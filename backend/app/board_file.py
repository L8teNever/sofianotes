"""Eigenes Dateiformat .sofianotes: ein Blatt komplett zum Sichern und wieder Importieren.

ZIP mit
  manifest.json  {"format": "sofianotes", "version": 1, "title", "paper", "refs", "strokes"}
  media/<id>.jpg alle Bilder (im Blatt und im Material-Fenster)
Striche behalten alle Daten (Punkte, Druck, Text, Tabellen, Zuschnitt ...), deshalb ist
ein importiertes Blatt wieder voll bearbeitbar.
"""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from typing import Any

from . import files, media

FORMAT = "sofianotes"
VERSION = 1
MAX_FILE_BYTES = 150_000_000
MAX_STROKES = 200_000


def _media_ids(strokes: list[dict[str, Any]], refs: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    for s in strokes:
        mid = (s.get("extra") or {}).get("mediaId")
        if mid and mid not in ids:
            ids.append(mid)
    for r in refs:
        mid = r.get("mediaId")
        if mid and mid not in ids:
            ids.append(mid)
    return ids


def build(board: dict[str, Any], strokes: list[dict[str, Any]]) -> bytes:
    refs = board.get("refs") or []
    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "title": board.get("title") or "Unbenannte Skizze",
        "paper": board.get("paper") or "graph",
        "refs": refs,
        "sofiaHomeworkId": board.get("sofiaHomeworkId"),
        "strokes": strokes,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        for r in refs:
            fid = r.get("fileId")
            hit = files.load(fid) if fid else None
            if hit:
                zf.writestr(zipfile.ZipInfo(f"files/{fid}.bin"), hit[0], compress_type=zipfile.ZIP_DEFLATED)
        for mid in _media_ids(strokes, refs):
            blob = media.load_bytes(mid)
            if blob:
                # JPEGs sind schon komprimiert
                zf.writestr(zipfile.ZipInfo(f"media/{mid}.jpg"), blob, compress_type=zipfile.ZIP_STORED)
    return buf.getvalue()


def parse(data: bytes) -> dict[str, Any]:
    """Liest eine .sofianotes-Datei; Bilder bekommen neue IDs und werden gespeichert.
    Rueckgabe: {"title", "paper", "refs", "strokes"} mit neuen Strich-IDs."""
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("too_large")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    except (zipfile.BadZipFile, KeyError, ValueError, UnicodeDecodeError) as exc:
        raise ValueError("not_sofianotes") from exc
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise ValueError("not_sofianotes")
    strokes_in = manifest.get("strokes") or []
    refs_in = manifest.get("refs") or []
    if not isinstance(strokes_in, list) or not isinstance(refs_in, list) or len(strokes_in) > MAX_STROKES:
        raise ValueError("not_sofianotes")

    names = set(zf.namelist())
    id_map: dict[str, str] = {}

    def new_media(old: str) -> str | None:
        if old in id_map:
            return id_map[old]
        name = f"media/{old}.jpg"
        if name not in names:
            return None
        blob = zf.read(name)
        if not blob or len(blob) > media.MAX_BYTES or blob[:2] != b"\xff\xd8":
            return None
        mid = str(uuid.uuid4())
        media.path_for(mid).write_bytes(blob)
        id_map[old] = mid
        return mid

    strokes: list[dict[str, Any]] = []
    for s in strokes_in:
        if not isinstance(s, dict) or not isinstance(s.get("points"), list) or not s.get("tool"):
            continue
        item = {
            "id": str(uuid.uuid4()),
            "tool": str(s["tool"])[:40],
            "color": str(s.get("color") or "#000000")[:40],
            "size": float(s.get("size") or 1),
            "points": s["points"],
        }
        extra = s.get("extra")
        if isinstance(extra, dict):
            extra = dict(extra)
            if extra.get("mediaId"):
                mid = new_media(str(extra["mediaId"]))
                if not mid:
                    continue
                extra["mediaId"] = mid
            item["extra"] = extra
        strokes.append(item)

    refs: list[dict[str, Any]] = []
    for r in refs_in:
        if isinstance(r, dict) and r.get("mediaId"):
            mid = new_media(str(r["mediaId"]))
            if mid:
                refs.append({"mediaId": mid, "name": str(r.get("name") or "Bild")[:160]})
        elif isinstance(r, dict) and r.get("fileId"):
            name = f"files/{r['fileId']}.bin"
            if name not in names:
                continue
            blob = zf.read(name)
            try:
                meta = files.save(blob, str(r.get("name") or "Datei"), str(r.get("mime") or ""))
            except ValueError:
                continue
            refs.append({"fileId": meta["id"], "name": meta["name"], "mime": meta["mime"]})

    paper = manifest.get("paper")
    hw = manifest.get("sofiaHomeworkId")
    return {
        "sofiaHomeworkId": hw if isinstance(hw, int) and not isinstance(hw, bool) else None,
        "title": str(manifest.get("title") or "Importiertes Blatt")[:200],
        "paper": paper if paper in ("graph", "dots", "lines", "blank") else "graph",
        "refs": refs[:80],
        "strokes": strokes,
    }
