"""Persist the live board as a .goodnotes archive plus a vector PDF.

The official GoodNotes document format is closed (ZIP + length-prefixed
protobuf + Apple framed LZ4). This module writes a sofianotes archive that
uses the .goodnotes extension the user asked for, containing:

- strokes.json  — exact board data (source of truth besides SQLite)
- sofianotes.pdf — vector strokes GoodNotes can import as a notebook
- manifest.json — format version and how to open the file

Both files are rewritten on the server after every finished stroke / erase /
move so the disk copy stays in sync with the live board.
"""

from __future__ import annotations

import asyncio
import io
import json
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from reportlab.lib.colors import Color, HexColor
from reportlab.pdfgen import canvas as pdf_canvas

from reportlab.lib.utils import ImageReader

from . import db, media

EXPORT_DIR = Path(__file__).resolve().parent.parent.parent / "data"
GOODNOTES_PATH = EXPORT_DIR / "sofianotes.goodnotes"
PDF_PATH = EXPORT_DIR / "sofianotes.pdf"

GRID = 32
BG = HexColor("#ece9e3")
GRID_LIGHT = Color(70 / 255, 90 / 255, 150 / 255, alpha=0.14)
GRID_BOLD = Color(70 / 255, 90 / 255, 150 / 255, alpha=0.28)
MAX_PAGE = 2400.0
MARGIN = 36.0
DEBOUNCE_S = 0.45

_loop_task: asyncio.Task | None = None
_write_lock = threading.Lock()


def _hex_color(hex_color: str, alpha: float) -> Color:
    h = (hex_color or "#000000").lstrip("#")
    if len(h) != 6:
        h = "1c1c1e"
    r = int(h[0:2], 16) / 255.0
    g = int(h[2:4], 16) / 255.0
    b = int(h[4:6], 16) / 255.0
    return Color(r, g, b, alpha=alpha)


def _wrap_pdf_text(text: str, font: str, size: float, width: float | None) -> list[str]:
    """Bricht Text wie im Browser um: Zeilenumbrueche bleiben, sonst wortweise bis zur Breite."""
    from reportlab.pdfbase.pdfmetrics import stringWidth

    out: list[str] = []
    for para in str(text).split("\n"):
        if not width:
            out.append(para)
            continue
        line = ""
        for word in para.split(" "):
            candidate = f"{line} {word}" if line else word
            if not line or stringWidth(candidate, font, size) <= width:
                line = candidate
            else:
                out.append(line)
                line = word
        out.append(line)
    return out or [""]


def _run_font(run: dict[str, Any]) -> str:
    bold = bool(run.get("b"))
    italic = bool(run.get("i"))
    if bold and italic:
        return "Helvetica-BoldOblique"
    if bold:
        return "Helvetica-Bold"
    if italic:
        return "Helvetica-Oblique"
    return "Helvetica"


def layout_runs(runs: list[dict[str, Any]], size: float, width: float | None) -> list[list[tuple[str, float, dict[str, Any]]]]:
    """Wie layoutRuns im Browser: Wort-Stuecke mit eigener Schrift, Umbruch bei width."""
    import re

    from reportlab.pdfbase.pdfmetrics import stringWidth

    lines: list[list[tuple[str, float, dict[str, Any]]]] = [[]]
    widths = [0.0]
    for run in runs:
        if not isinstance(run, dict):
            continue
        font = _run_font(run)
        for part in re.split(r"(\n|\s+)", str(run.get("t") or "")):
            if not part:
                continue
            if part == "\n":
                lines.append([])
                widths.append(0.0)
                continue
            w = stringWidth(part, font, size)
            space = part.isspace()
            if width and not space and widths[-1] > 0 and widths[-1] + w > width:
                while lines[-1] and lines[-1][-1][0].isspace():
                    widths[-1] -= lines[-1].pop()[1]
                lines.append([])
                widths.append(0.0)
            if space and widths[-1] == 0 and len(lines) > 1 and width:
                continue
            lines[-1].append((part, w, run))
            widths[-1] += w
    return lines


def _draw_runs(c, runs: list[dict[str, Any]], x0: float, y0: float, size: float, width: float | None) -> None:
    for li, line in enumerate(layout_runs(runs, size, width)):
        x = x0
        y = y0 - li * size * 1.3
        for text, w, run in line:
            c.setFont(_run_font(run), size)
            c.drawString(x, y, text)
            c.setLineWidth(max(0.3, size * 0.06))
            if run.get("u"):
                c.line(x, y - size * 0.12, x + w, y - size * 0.12)
            if run.get("s"):
                c.line(x, y + size * 0.3, x + w, y + size * 0.3)
            x += w


def _bbox(strokes: list[dict[str, Any]]) -> tuple[float, float, float, float]:
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")
    for s in strokes:
        pad = float(s.get("size") or 4)
        for p in s.get("points") or []:
            x, y = float(p["x"]), float(p["y"])
            if x - pad < min_x:
                min_x = x - pad
            if y - pad < min_y:
                min_y = y - pad
            if x + pad > max_x:
                max_x = x + pad
            if y + pad > max_y:
                max_y = y + pad
    if min_x == float("inf"):
        return -400.0, -300.0, 400.0, 300.0
    return min_x, min_y, max_x, max_y


def _looks_like_polygon(pts: list[dict[str, Any]]) -> bool:
    if len(pts) == 2:
        return True
    if len(pts) < 3 or len(pts) > 6:
        return False
    a, b = pts[0], pts[-1]
    dx = float(a["x"]) - float(b["x"])
    dy = float(a["y"]) - float(b["y"])
    return dx * dx + dy * dy < 36.0


def _xy(p: dict[str, Any]) -> tuple[float, float]:
    return float(p["x"]), float(p["y"])


def _mid(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0


def _trace_smooth_pdf(path: Any, pts: list[dict[str, Any]], tx, ty) -> None:
    """Mittelpunkt-Quadrate als kubische Bezier, analog zur Canvas-Tinte."""
    mapped = [(tx(x), ty(y)) for x, y in (_xy(p) for p in pts)]
    path.moveTo(mapped[0][0], mapped[0][1])
    if len(mapped) == 2:
        path.lineTo(mapped[1][0], mapped[1][1])
        return
    first_mid = _mid(mapped[0], mapped[1])
    path.lineTo(first_mid[0], first_mid[1])
    for i in range(1, len(mapped) - 1):
        p0 = _mid(mapped[i - 1], mapped[i])
        p1 = mapped[i]
        p2 = _mid(mapped[i], mapped[i + 1])
        c1 = (p0[0] + 2.0 / 3.0 * (p1[0] - p0[0]), p0[1] + 2.0 / 3.0 * (p1[1] - p0[1]))
        c2 = (p2[0] + 2.0 / 3.0 * (p1[0] - p2[0]), p2[1] + 2.0 / 3.0 * (p1[1] - p2[1]))
        path.curveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1])
    last = mapped[-1]
    path.lineTo(last[0], last[1])


def _avg_width(stroke: dict[str, Any]) -> float:
    size = float(stroke.get("size") or 4)
    pts = stroke.get("points") or []
    if not pts:
        return size
    acc = 0.0
    for p in pts:
        pr = p.get("p")
        pr = pr if pr and pr > 0 else 0.5
        acc += max(1.0, size * (0.3 + 0.7 * pr))
    return acc / len(pts)


def _render_strokes(c, strokes: list[dict[str, Any]], tx, ty, scale: float) -> None:
    """Zeichnet Striche, Bilder, Tabellen und Text mit der Abbildung tx/ty in den PDF-Canvas."""
    def _draw_image(stroke: dict[str, Any]) -> None:
        extra = stroke.get("extra") or {}
        media_id = extra.get("mediaId")
        blob = media.load_bytes(str(media_id or ""))
        if not blob:
            return
        pts = stroke.get("points") or []
        if len(pts) < 2:
            return
        x0 = min(float(pts[0]["x"]), float(pts[1]["x"]))
        y0 = min(float(pts[0]["y"]), float(pts[1]["y"]))
        x1 = max(float(pts[0]["x"]), float(pts[1]["x"]))
        y1 = max(float(pts[0]["y"]), float(pts[1]["y"]))
        crop = extra.get("crop") or {}
        left = max(0.0, min(1.0, float(crop.get("l") or 0)))
        top = max(0.0, min(1.0, float(crop.get("t") or 0)))
        right = max(left + 0.01, min(1.0, float(crop.get("r") if crop.get("r") is not None else 1)))
        bottom = max(top + 0.01, min(1.0, float(crop.get("b") if crop.get("b") is not None else 1)))
        try:
            reader = ImageReader(io.BytesIO(blob))
            c.saveState()
            path = c.beginPath()
            path.rect(tx(x0), ty(y1), tx(x1) - tx(x0), ty(y0) - ty(y1))
            c.clipPath(path, stroke=0, fill=0)
            full_w = (tx(x1) - tx(x0)) / (right - left)
            full_h = (ty(y0) - ty(y1)) / (bottom - top)
            ox = tx(x0) - left * full_w
            oy = ty(y1) - (1.0 - bottom) * full_h
            c.drawImage(reader, ox, oy, width=full_w, height=full_h, mask="auto")
            c.restoreState()
        except Exception:  # noqa: BLE001
            return

    def _draw_table(stroke: dict[str, Any]) -> None:
        pts = stroke.get("points") or []
        if len(pts) < 2:
            return
        extra = stroke.get("extra") or {}
        x0 = min(float(pts[0]["x"]), float(pts[1]["x"]))
        y0 = min(float(pts[0]["y"]), float(pts[1]["y"]))
        w = abs(float(pts[1]["x"]) - float(pts[0]["x"]))
        h = abs(float(pts[1]["y"]) - float(pts[0]["y"]))
        cols = max(1, int(extra.get("cols") or 1))
        rows = max(1, int(extra.get("rows") or 1))
        cw = extra.get("cw") if isinstance(extra.get("cw"), list) and len(extra["cw"]) == cols else [1.0] * cols
        rh = extra.get("rh") if isinstance(extra.get("rh"), list) and len(extra["rh"]) == rows else [1.0] * rows
        sw = float(sum(cw)) or 1.0
        sh = float(sum(rh)) or 1.0
        xs = [x0]
        for v in cw:
            xs.append(xs[-1] + float(v) / sw * w)
        ys = [y0]
        for v in rh:
            ys.append(ys[-1] + float(v) / sh * h)
        size = float(stroke.get("size") or 20)
        c.setFillColor(Color(1, 1, 1, alpha=0.92))
        c.rect(tx(x0), ty(y0 + h), w * scale, h * scale, stroke=0, fill=1)
        c.setStrokeColor(_hex_color(str(stroke.get("color") or "#5f6368"), 1.0))
        c.setLineWidth(max(0.4, size * 0.05 * scale))
        for x in xs:
            c.line(tx(x), ty(y0), tx(x), ty(y0 + h))
        for y in ys:
            c.line(tx(x0), ty(y), tx(x0 + w), ty(y))
        cells = extra.get("cells") or {}
        font_size = max(5.0, size * scale)
        pad = size * 0.4
        c.setFillColor(HexColor("#1E1F22"))
        c.setFont("Helvetica", font_size)
        for key, text in cells.items():
            try:
                r, col = (int(v) for v in str(key).split(","))
            except ValueError:
                continue
            if not text or r >= rows or col >= cols:
                continue
            lines = _wrap_pdf_text(str(text), "Helvetica", font_size, max(4.0, (xs[col + 1] - xs[col] - pad * 2) * scale))
            for i, line in enumerate(lines):
                c.drawString(tx(xs[col] + pad), ty(ys[r] + pad + size * 0.95) - i * font_size * 1.3, line)

    # Images under tables under marker under ink.
    ordered = (
        [s for s in strokes if s.get("tool") == "image"]
        + [s for s in strokes if s.get("tool") == "table"]
        + [s for s in strokes if s.get("tool") == "marker"]
        + [s for s in strokes if s.get("tool") not in ("image", "table", "marker")]
    )
    for stroke in ordered:
        pts = stroke.get("points") or []
        if not pts:
            continue
        if stroke.get("tool") == "image":
            _draw_image(stroke)
            continue
        is_marker = stroke.get("tool") == "marker"
        alpha = 0.38 if is_marker else 1.0
        width = float(stroke.get("size") or (18 if is_marker else 4))
        c.setStrokeColor(_hex_color(str(stroke.get("color") or "#1c1c1e"), alpha))
        c.setFillColor(_hex_color(str(stroke.get("color") or "#1c1c1e"), alpha))
        c.setLineWidth(max(0.6, width * scale))
        c.setLineCap(1)
        c.setLineJoin(1)
        if len(pts) == 1:
            r = max(0.4, (width * scale) / 2)
            c.circle(tx(float(pts[0]["x"])), ty(float(pts[0]["y"])), r, stroke=0, fill=1)
            continue
        if stroke.get("tool") == "table":
            _draw_table(stroke)
            continue
        if stroke.get("tool") == "text":
            label = str(pts[0].get("text") or "")
            if label:
                extra = stroke.get("extra") or {}
                box = bool(extra.get("box"))
                font = "Helvetica" if box else "Helvetica-Bold"
                font_size = max(6.0, width * scale)
                c.setFillColor(_hex_color(str(stroke.get("color") or "#0b57d0"), 1.0))
                c.setFont(font, font_size)
                wrap = float(extra["width"]) * scale if box and extra.get("width") else None
                runs = extra.get("runs") if box and isinstance(extra.get("runs"), list) else None
                if runs:
                    _draw_runs(c, runs, tx(float(pts[0]["x"])), ty(float(pts[0]["y"])), font_size, wrap)
                    continue
                lines = _wrap_pdf_text(label, font, font_size, wrap) if box else [label]
                for i, line in enumerate(lines):
                    c.drawString(tx(float(pts[0]["x"])), ty(float(pts[0]["y"])) - i * font_size * 1.3, line)
            continue
        path = c.beginPath()
        if _looks_like_polygon(pts):
            path.moveTo(tx(float(pts[0]["x"])), ty(float(pts[0]["y"])))
            for p in pts[1:]:
                path.lineTo(tx(float(p["x"])), ty(float(p["y"])))
        else:
            _trace_smooth_pdf(path, pts, tx, ty)
        c.drawPath(path, stroke=1, fill=0)


def build_pdf(strokes: list[dict[str, Any]]) -> bytes:
    min_x, min_y, max_x, max_y = _bbox(strokes)
    world_w = max(80.0, max_x - min_x)
    world_h = max(80.0, max_y - min_y)
    scale = min(MAX_PAGE / world_w, MAX_PAGE / world_h, 1.0)
    page_w = world_w * scale + MARGIN * 2
    page_h = world_h * scale + MARGIN * 2

    def tx(x: float) -> float:
        return (x - min_x) * scale + MARGIN

    def ty(y: float) -> float:
        return page_h - ((y - min_y) * scale + MARGIN)

    buf = io.BytesIO()
    c = pdf_canvas.Canvas(buf, pagesize=(page_w, page_h))
    c.setTitle("sofianotes")
    c.setFillColor(BG)
    c.rect(0, 0, page_w, page_h, stroke=0, fill=1)

    start_x = min_x - (min_x % GRID)
    start_y = min_y - (min_y % GRID)
    c.setLineWidth(0.6)
    x = start_x
    while x <= max_x + GRID:
        bold = int(round(x / GRID)) % 4 == 0
        c.setStrokeColor(GRID_BOLD if bold else GRID_LIGHT)
        c.line(tx(x), ty(min_y) + MARGIN * 0, tx(x), ty(max_y))
        x += GRID
    y = start_y
    while y <= max_y + GRID:
        bold = int(round(y / GRID)) % 4 == 0
        c.setStrokeColor(GRID_BOLD if bold else GRID_LIGHT)
        c.line(tx(min_x), ty(y), tx(max_x), ty(y))
        y += GRID

    _render_strokes(c, strokes, tx, ty, scale)

    c.showPage()
    c.save()
    return buf.getvalue()


A4_W = 794.0  # Weltbreite einer A4-Seite (wie im Frontend)
A4_H = 1123.0
PAGE_GAP = 48.0
A4_PT_W = 595.28


def page_rects(notebook: dict[str, Any]) -> list[tuple[dict[str, Any], float, float, float, float]]:
    """(Seite, x, y, w, h) in Weltkoordinaten - gleiche Anordnung wie im Frontend."""
    out = []
    horizontal = notebook.get("layout") == "horizontal"
    pos = 0.0
    for pg in notebook.get("pages") or []:
        w = float(pg.get("w") or A4_W)
        h = float(pg.get("h") or A4_H)
        if horizontal:
            out.append((pg, pos, 0.0, w, h))
            pos += w + PAGE_GAP
        else:
            out.append((pg, 0.0, pos, w, h))
            pos += h + PAGE_GAP
    return out


def _stroke_center(stroke: dict[str, Any]) -> tuple[float, float]:
    pts = stroke.get("points") or []
    xs = [float(p.get("x", 0)) for p in pts] or [0.0]
    ys = [float(p.get("y", 0)) for p in pts] or [0.0]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def build_notebook_pdf(notebook: dict[str, Any], strokes: list[dict[str, Any]]) -> bytes:
    """Ein PDF mit einer Seite pro Notizbuch-Seite (A4), samt Seiten-Hintergrund."""
    buf = io.BytesIO()
    c = pdf_canvas.Canvas(buf)
    c.setTitle("sofianotes")
    rects = page_rects(notebook)
    for pg, px, py, w, h in rects:
        scale = A4_PT_W / A4_W
        pw, ph = w * scale, h * scale
        c.setPageSize((pw, ph))
        c.setFillColor(HexColor("#ffffff"))
        c.rect(0, 0, pw, ph, stroke=0, fill=1)
        blob = media.load_bytes(str(pg.get("mediaId") or "")) if pg.get("mediaId") else None
        if blob:
            try:
                rot = int(pg.get("rot") or 0) % 4
                if rot:
                    # Seite wurde gedreht (im Uhrzeigersinn): Bild um die Seitenmitte drehen
                    iw, ih = (ph, pw) if rot % 2 else (pw, ph)
                    c.saveState()
                    c.translate(pw / 2, ph / 2)
                    c.rotate(-90 * rot)
                    c.drawImage(ImageReader(io.BytesIO(blob)), -iw / 2, -ih / 2, width=iw, height=ih)
                    c.restoreState()
                else:
                    c.drawImage(ImageReader(io.BytesIO(blob)), 0, 0, width=pw, height=ph)
            except Exception:  # noqa: BLE001
                pass
        else:
            # wie ein echter A4-Block: 5-mm-Kaestchen/Punkte, liniert ca. 8,5 mm mit Randlinie
            paper = pg.get("paper") or "graph"
            mm = 72.0 / 25.4
            step = 5 * mm
            if paper == "graph":
                c.setLineWidth(0.35)
                c.setStrokeColor(Color(80 / 255, 100 / 255, 150 / 255, alpha=0.3))
                x = step
                while x < pw:
                    c.line(x, 0, x, ph)
                    x += step
                y = step
                while y < ph:
                    c.line(0, ph - y, pw, ph - y)
                    y += step
            elif paper == "lines":
                c.setLineWidth(0.4)
                c.setStrokeColor(Color(80 / 255, 100 / 255, 150 / 255, alpha=0.4))
                y = 25 * mm
                while y < ph - 5 * mm:
                    c.line(0, ph - y, pw, ph - y)
                    y += 8.5 * mm
                c.setStrokeColor(Color(217 / 255, 48 / 255, 37 / 255, alpha=0.5))
                c.line(20 * mm, 0, 20 * mm, ph)
            elif paper == "dots":
                c.setFillColor(Color(60 / 255, 70 / 255, 90 / 255, alpha=0.45))
                y = step
                while y < ph:
                    x = step
                    while x < pw:
                        c.circle(x, ph - y, 0.55, stroke=0, fill=1)
                        x += step
                    y += step
        mine = [s for s in strokes if px <= _stroke_center(s)[0] <= px + w and py <= _stroke_center(s)[1] <= py + h]

        def tx(x: float, _px=px) -> float:
            return (x - _px) * scale

        def ty(y: float, _py=py, _ph=ph) -> float:
            return _ph - (y - _py) * scale

        _render_strokes(c, mine, tx, ty, scale)
        c.showPage()
    if not rects:
        c.showPage()
    c.save()
    return buf.getvalue()


def build_board_pdf(board: dict[str, Any] | None, strokes: list[dict[str, Any]]) -> bytes:
    nb = (board or {}).get("notebook")
    if nb and nb.get("pages"):
        return build_notebook_pdf(nb, strokes)
    return build_pdf(strokes)


def build_goodnotes_archive(strokes: list[dict[str, Any]], pdf_bytes: bytes | None = None) -> bytes:
    if pdf_bytes is None:
        pdf_bytes = build_pdf(strokes)
    payload = {
        "app": "sofianotes",
        "format": 1,
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "strokeCount": len(strokes),
        "howToOpen": (
            "Dies ist ein sofianotes-Archiv mit der Endung .goodnotes. "
            "Die enthaltene sofianotes.pdf in GoodNotes importieren "
            "(Teilen → GoodNotes / Einfügen als Dokument)."
        ),
        "strokes": strokes,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps({k: payload[k] for k in payload if k != "strokes"}, indent=2))
        zf.writestr("strokes.json", json.dumps(strokes))
        zf.writestr("sofianotes.pdf", pdf_bytes)
    return buf.getvalue()


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def write_exports(strokes: list[dict[str, Any]]) -> tuple[Path, Path]:
    with _write_lock:
        pdf_bytes = build_pdf(strokes)
        archive = build_goodnotes_archive(strokes, pdf_bytes)
        _atomic_write(PDF_PATH, pdf_bytes)
        _atomic_write(GOODNOTES_PATH, archive)
        return GOODNOTES_PATH, PDF_PATH


async def schedule_write(load_strokes: Callable[[], Awaitable[list[dict[str, Any]]]] | None = None) -> None:
    """Debounced rewrite so bursts of strokes do not hammer the disk."""
    global _loop_task
    loader = load_strokes or db.load_all

    async def _run() -> None:
        await asyncio.sleep(DEBOUNCE_S)
        strokes = await loader()
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, write_exports, strokes)

    if _loop_task and not _loop_task.done():
        _loop_task.cancel()
    _loop_task = asyncio.create_task(_run())
