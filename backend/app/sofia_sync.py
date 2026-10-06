"""Abgleich mit der grossen Sofia-App im selben internen Docker-Netz.

Sofia nimmt Anfragen von anderen Diensten ohne Cloudflare-Header an, wenn sie den
gemeinsamen Schluessel ``X-Internal-Token`` mitschicken (derselbe Weg wie der
Sofia-MCP-Dienst). ``X-Act-As-Email`` waehlt, als wer gefragt wird.

- Alle paar Minuten: Personen (mit allen Mail-Adressen) und Faecher holen und in
  die Notes-Datenbank uebernehmen (siehe ``db.apply_sofia_sync``).
- Auf Anfrage: aktuelles / naechstes Fach aus dem Stundenplan der Person.

Konfiguration (alles per Umgebung, ohne -> Abgleich aus):
  SOFIA_API_BASE       z. B. http://sofia-kulbarts:8000/api/v1
  SOFIA_INTERNAL_TOKEN der Schluessel selbst, oder
  SOFIA_TOKEN_FILE     Pfad zur Datei internal_service_token.txt aus Sofias data/
  SOFIA_ACT_AS         Admin-Mail fuer den Abgleich (Standard: Sofias eigener Standard)
  SOFIA_SYNC_SECONDS   Abstand zwischen zwei Abgleichen (Standard 120)
  SOFIA_TZ             Zeitzone fuer den Stundenplan (Standard Europe/Berlin)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from . import db

log = logging.getLogger("sofianotes.sofia")

API_BASE = os.environ.get("SOFIA_API_BASE", "").strip().rstrip("/")
ACT_AS = os.environ.get("SOFIA_ACT_AS", "").strip()
INTERVAL = max(30.0, float(os.environ.get("SOFIA_SYNC_SECONDS", "120") or 120))
TZ_NAME = os.environ.get("SOFIA_TZ", "Europe/Berlin")

state: dict[str, Any] = {"lastSync": None, "lastError": None, "people": 0, "subjects": 0}
_subjects: list[dict[str, Any]] = []
_sync_lock = asyncio.Lock()
_last_try = 0.0
_tt_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _token() -> str:
    tok = os.environ.get("SOFIA_INTERNAL_TOKEN", "").strip()
    if tok:
        return tok
    path = os.environ.get("SOFIA_TOKEN_FILE", "").strip()
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""
    return ""


def enabled() -> bool:
    return bool(API_BASE and _token())


def _get(path: str, act_as: str | None = None) -> Any:
    headers = {"X-Internal-Token": _token(), "Accept": "application/json"}
    who = act_as or ACT_AS
    if who:
        headers["X-Act-As-Email"] = who
    req = urllib.request.Request(API_BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 - feste interne Adresse
        return json.loads(resp.read().decode("utf-8"))


def _fetch_snapshot() -> dict[str, Any]:
    users = _get("/users/")
    out_users = []
    for u in users if isinstance(users, list) else []:
        aliases: list[str] = []
        try:
            aliases = [a.get("email") for a in _get(f"/users/{u['id']}/emails") if a.get("email")]
        except (urllib.error.URLError, ValueError, KeyError, TypeError):
            aliases = []
        out_users.append({**u, "aliases": aliases})
    subjects = _get("/subjects/")
    return {"users": out_users, "subjects": subjects if isinstance(subjects, list) else []}


async def sync_once(force: bool = False) -> dict[str, Any]:
    """Ein Abgleich. Ohne force hoechstens alle 10 s (z. B. bei unbekannter Mail)."""
    global _last_try, _subjects
    if not enabled():
        return {"ok": False, "error": "disabled"}
    if not force and time.time() - _last_try < 10:
        return {"ok": True, "skipped": True}
    async with _sync_lock:
        _last_try = time.time()
        try:
            snap = await asyncio.get_event_loop().run_in_executor(None, _fetch_snapshot)
        except Exception as exc:  # noqa: BLE001 - Netz/JSON: nur melden, App laeuft weiter
            state["lastError"] = f"{type(exc).__name__}: {exc}"
            log.warning("Sofia-Abgleich fehlgeschlagen: %s", exc)
            return {"ok": False, "error": state["lastError"]}
        if not snap["users"]:
            state["lastError"] = "Sofia hat keine Personen geliefert"
            return {"ok": False, "error": state["lastError"]}
        result = await db.apply_sofia_sync(snap)
        _subjects = snap["subjects"]
        state.update(lastSync=time.time(), lastError=None, people=result["people"], subjects=len(_subjects))
        return {"ok": True, **result}


async def run_forever() -> None:
    while True:
        try:
            await sync_once(force=True)
        except Exception:  # noqa: BLE001
            log.exception("Sofia-Abgleich abgebrochen")
        await asyncio.sleep(INTERVAL)


def _subject_for_lesson(lesson: dict[str, Any]) -> dict[str, Any] | None:
    short = str(lesson.get("subject_short") or "").strip().lower()
    name = str(lesson.get("subject") or "").strip().lower()
    for s in _subjects:
        if short and str(s.get("short_name") or "").strip().lower() == short:
            return s
    for s in _subjects:
        sn = str(s.get("name") or "").strip().lower()
        if sn and sn in (name, short):
            return s
    return None


def _hhmm(v: Any) -> str:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return ""
    return f"{n // 100:02d}:{n % 100:02d}"


async def current_lesson(person_id: str) -> dict[str, Any]:
    """Aktuelles und naechstes Fach heute fuer diese Person (aus ihrem Sofia-Stundenplan)."""
    if not enabled():
        return {"enabled": False}
    info = await db.sofia_person(person_id)
    if not info or not info.get("email"):
        return {"enabled": True, "linked": False}
    email = info["email"]
    cached = _tt_cache.get(email)
    if cached and time.time() - cached[0] < 120:
        tt = cached[1]
    else:
        try:
            tt = await asyncio.get_event_loop().run_in_executor(None, _get, "/timetable/", email)
        except Exception as exc:  # noqa: BLE001
            return {"enabled": True, "linked": True, "error": f"{type(exc).__name__}"}
        _tt_cache[email] = (time.time(), tt)
    if not _subjects:
        await sync_once()
    now = datetime.now(ZoneInfo(TZ_NAME))
    today = now.strftime("%Y%m%d")
    hm = now.hour * 100 + now.minute
    lessons = [
        l
        for l in ((tt or {}).get("this_week") or {}).get("lessons") or []
        if str(l.get("date")) == today and not l.get("cancelled")
    ]
    lessons.sort(key=lambda l: int(l.get("startTime") or 0))

    def pack(l: dict[str, Any] | None) -> dict[str, Any] | None:
        if not l:
            return None
        subj = _subject_for_lesson(l)
        sid = subj.get("id") if subj else None
        return {
            "subject": (subj or {}).get("name") or l.get("subject") or l.get("subject_short"),
            "start": _hhmm(l.get("startTime")),
            "end": _hhmm(l.get("endTime")),
            "room": l.get("room") or "",
            "subjectId": sid,
            "folderId": info["folders"].get(sid) if sid is not None else None,
        }

    current = next((l for l in lessons if int(l.get("startTime") or 0) <= hm < int(l.get("endTime") or 0)), None)
    upcoming = next((l for l in lessons if int(l.get("startTime") or 0) > hm), None)
    return {"enabled": True, "linked": True, "current": pack(current), "next": pack(upcoming)}


# ---- Hausaufgaben -------------------------------------------------------------
def _send(method: str, path: str, act_as: str) -> Any:
    headers = {"X-Internal-Token": _token(), "Accept": "application/json", "X-Act-As-Email": act_as}
    req = urllib.request.Request(API_BASE + path, method=method, headers=headers, data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8") or "null")


def _subject_by_id(sid: Any) -> dict[str, Any] | None:
    for s in _subjects:
        if s.get("id") == sid:
            return s
    return None


def _att_list(hw: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for a in hw.get("attachments") or []:
        url = str(a.get("url") or "")
        if not url.startswith("/uploads/"):
            continue
        name = a.get("name") or url.rsplit("/", 1)[-1]
        kind = a.get("type") or "file"
        if kind != "image" and url.lower().rsplit(".", 1)[-1] in ("jpg", "jpeg", "png", "gif", "webp", "heic"):
            kind = "image"
        out.append({"url": "/api/sofia/file?u=" + urllib.parse.quote(url, safe=""), "type": kind, "name": name})
    return out


def _pack_homework(hw: dict[str, Any], info: dict[str, Any], boards: dict[int, str]) -> dict[str, Any]:
    subj = _subject_by_id(hw.get("subject_id")) or {}
    sid = hw.get("subject_id")
    return {
        "id": hw.get("id"),
        "subjectId": sid,
        "subject": subj.get("name") or "",
        "subjectShort": subj.get("short_name") or "",
        "color": subj.get("color") or "#6750a4",
        "description": hw.get("description") or "",
        "due": hw.get("due_date") or "",
        "done": info["sofiaUserId"] in (hw.get("checked_by") or []),
        "attachments": _att_list(hw),
        "folderId": info["folders"].get(sid),
        "boardId": boards.get(hw.get("id")),
    }


async def _homework_ctx(person_id: str) -> tuple[dict[str, Any] | None, str | None]:
    if not enabled():
        return None, "disabled"
    info = await db.sofia_person(person_id)
    if not info or not info.get("email"):
        return None, "not_linked"
    if not _subjects:
        await sync_once()
    return info, None


async def homework_list(person_id: str) -> dict[str, Any]:
    info, err = await _homework_ctx(person_id)
    if err:
        return {"enabled": err != "disabled", "error": err, "items": []}
    try:
        items = await asyncio.get_event_loop().run_in_executor(None, _get, "/homework/", info["email"])
    except Exception as exc:  # noqa: BLE001
        return {"enabled": True, "error": type(exc).__name__, "items": []}
    boards = await db.homework_boards(person_id)
    today = datetime.now(ZoneInfo(TZ_NAME)).strftime("%Y-%m-%d")
    out = []
    for hw in items if isinstance(items, list) else []:
        p = _pack_homework(hw, info, boards)
        # erledigte nur, solange sie noch nicht vorbei sind; offene immer
        if p["done"] and p["due"] and p["due"][:10] < today:
            continue
        out.append(p)
    out.sort(key=lambda h: (h["done"], h["due"] or "9999", h["id"] or 0))
    return {"enabled": True, "items": out, "today": today}


async def homework_get(person_id: str, hw_id: int) -> dict[str, Any] | None:
    info, err = await _homework_ctx(person_id)
    if err:
        return None
    try:
        hw = await asyncio.get_event_loop().run_in_executor(None, _get, f"/homework/{hw_id}", info["email"])
    except Exception:  # noqa: BLE001
        return None
    boards = await db.homework_boards(person_id)
    return _pack_homework(hw, info, boards)


async def homework_toggle(person_id: str, hw_id: int) -> dict[str, Any] | None:
    info, err = await _homework_ctx(person_id)
    if err:
        return None
    try:
        res = await asyncio.get_event_loop().run_in_executor(None, _send, "POST", f"/homework/{hw_id}/check", info["email"])
    except Exception:  # noqa: BLE001
        return None
    return {"done": bool((res or {}).get("checked"))}


def _fetch_file(path: str) -> tuple[bytes, str]:
    req = urllib.request.Request(API_BASE.rsplit("/api/", 1)[0] + path, headers={"X-Internal-Token": _token()})
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
        return resp.read(), resp.headers.get("Content-Type") or "application/octet-stream"


async def fetch_file(path: str) -> tuple[bytes, str] | None:
    if not enabled() or not path.startswith("/uploads/") or ".." in path:
        return None
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _fetch_file, path)
    except Exception:  # noqa: BLE001
        return None
