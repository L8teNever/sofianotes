"""Store uploaded board images as files, referenced from stroke.extra.mediaId."""

from __future__ import annotations

import base64
import re
import uuid
from pathlib import Path

MEDIA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "media"
MAX_BYTES = 3_500_000
_DATA_URI = re.compile(r"^data:image/(jpeg|jpg);base64,(.+)$", re.I | re.S)
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


def _ensure_dir() -> Path:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    return MEDIA_DIR


def valid_id(media_id: str) -> bool:
    return bool(media_id and _UUID.match(media_id))


def path_for(media_id: str) -> Path:
    return _ensure_dir() / f"{media_id}.jpg"


def save_data_uri(data_uri: str, media_id: str | None = None) -> dict:
    raw = (data_uri or "").strip()
    match = _DATA_URI.match(raw)
    if not match:
        raise ValueError("jpeg_data_uri")
    try:
        blob = base64.b64decode(match.group(2), validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("jpeg_data_uri") from exc
    if not blob or len(blob) > MAX_BYTES:
        raise ValueError("too_large" if blob else "jpeg_data_uri")
    if blob[:2] != b"\xff\xd8":
        raise ValueError("jpeg_data_uri")
    if media_id:
        if not valid_id(media_id):
            raise ValueError("jpeg_data_uri")
    else:
        media_id = str(uuid.uuid4())
    path_for(media_id).write_bytes(blob)
    return {"id": media_id, "bytes": len(blob)}


def load_bytes(media_id: str) -> bytes | None:
    if not valid_id(media_id):
        return None
    path = path_for(media_id)
    if not path.is_file():
        return None
    return path.read_bytes()
