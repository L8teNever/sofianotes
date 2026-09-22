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

from . import db

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

    # Marker first (under ink), then pen.
    ordered = [s for s in strokes if s.get("tool") == "marker"] + [
        s for s in strokes if s.get("tool") != "marker"
    ]
    for stroke in ordered:
        pts = stroke.get("points") or []
        if not pts:
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
        if stroke.get("tool") == "text":
            label = str(pts[0].get("text") or "")
            if label:
                c.setFillColor(_hex_color(str(stroke.get("color") or "#0b57d0"), 1.0))
                c.setFont("Helvetica-Bold", max(8.0, width * scale))
                c.drawString(tx(float(pts[0]["x"])), ty(float(pts[0]["y"])), label)
            continue
        path = c.beginPath()
        if _looks_like_polygon(pts):
            path.moveTo(tx(float(pts[0]["x"])), ty(float(pts[0]["y"])))
            for p in pts[1:]:
                path.lineTo(tx(float(p["x"])), ty(float(p["y"])))
        else:
            _trace_smooth_pdf(path, pts, tx, ty)
        c.drawPath(path, stroke=1, fill=0)

    c.showPage()
    c.save()
    return buf.getvalue()


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
