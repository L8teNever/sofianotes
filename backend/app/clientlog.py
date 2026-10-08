"""Fehlerprotokoll der App: Fehler und die letzten Bedienschritte, die das Geraet meldet.

Eine Zeile pro Eintrag (JSON) in data/client-log.jsonl; die Datei wird klein gehalten.
"""

from __future__ import annotations

import json
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

LOG_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "client-log.jsonl"
MAX_BYTES = 1_500_000
_lock = threading.Lock()
_recent: dict[str, deque] = defaultdict(deque)


def _clip(v: Any, n: int) -> Any:
    if isinstance(v, str):
        return v[:n]
    return v


def _allowed(person_id: str) -> bool:
    """Hoechstens 40 Meldungen pro Minute und Person (eine Fehlerschleife soll nichts fluten)."""
    now = time.time()
    q = _recent[person_id]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= 40:
        return False
    q.append(now)
    return True


def add(person_id: str, person_name: str, entry: dict[str, Any]) -> bool:
    if not _allowed(person_id):
        return False
    actions = entry.get("actions")
    clean = {
        "at": time.time(),
        "clientAt": _clip(entry.get("clientAt"), 40),
        "person": person_name,
        "kind": _clip(entry.get("kind"), 30) or "error",
        "message": _clip(entry.get("message"), 600),
        "stack": _clip(entry.get("stack"), 2500),
        "where": entry.get("where") if isinstance(entry.get("where"), dict) else {},
        "version": entry.get("version") if isinstance(entry.get("version"), dict) else {},
        "ua": _clip(entry.get("ua"), 240),
        "online": entry.get("online"),
        "actions": [_clip(a, 140) for a in actions[-30:]] if isinstance(actions, list) else [],
    }
    line = json.dumps(clean, ensure_ascii=False)
    with _lock:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        try:
            if LOG_PATH.stat().st_size > MAX_BYTES:
                lines = LOG_PATH.read_text(encoding="utf-8").splitlines()
                LOG_PATH.write_text("\n".join(lines[len(lines) // 2 :]) + "\n", encoding="utf-8")
        except OSError:
            pass
    return True


def recent(limit: int = 100) -> list[dict[str, Any]]:
    with _lock:
        try:
            lines = LOG_PATH.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
    out = []
    for ln in lines[-limit:]:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out[::-1]
