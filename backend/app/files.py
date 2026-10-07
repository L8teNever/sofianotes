"""Beliebige Dateien (PDF, Word, ...) fuer das Material-Fenster eines Blatts."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

FILES_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "files"
MAX_BYTES = 60_000_000
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def valid_id(file_id: str) -> bool:
    return bool(file_id and _UUID.match(file_id))


def _paths(file_id: str) -> tuple[Path, Path]:
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    return FILES_DIR / f"{file_id}.bin", FILES_DIR / f"{file_id}.json"


def clean_name(name: str) -> str:
    name = (name or "Datei").replace("/", "_").replace("\\", "_").strip()
    return name[:160] or "Datei"


def save(data: bytes, name: str, mime: str) -> dict[str, Any]:
    if not data:
        raise ValueError("empty")
    if len(data) > MAX_BYTES:
        raise ValueError("too_large")
    file_id = str(uuid.uuid4())
    meta = {"id": file_id, "name": clean_name(name), "mime": (mime or "application/octet-stream")[:120], "bytes": len(data)}
    blob_path, meta_path = _paths(file_id)
    blob_path.write_bytes(data)
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return meta


def load(file_id: str) -> tuple[bytes, dict[str, Any]] | None:
    if not valid_id(file_id):
        return None
    blob_path, meta_path = _paths(file_id)
    if not blob_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        meta = {"id": file_id, "name": "Datei", "mime": "application/octet-stream"}
    return blob_path.read_bytes(), meta
