"""Lernende Formen-Erkennung, gemeinsam fuer alle Geraete.

Jedes Geraet meldet anonym, wie es einer eingerasteten Form ergangen ist:

- ``snap_undone``  - kurz danach rueckgaengig gemacht / wegradiert (Fehlalarm)
- ``snap_kept``    - nach einer Weile noch da (richtig erkannt)
- ``snap_edited``  - danach noch verschoben/skaliert (richtig erkannt, wurde benutzt)
- ``missed``       - lange gehalten, nichts erkannt, Strich gleich wieder weg
                     (vermutlich ein verpasster Form-Versuch)

Dazu kommt je eine Messgroesse: ``ellipse`` (mittlere Abweichung von der besten
Ellipse, relativ zum Radius) und ``line`` (Weglaenge / Luftlinie). Aus den
letzten Meldungen werden die Toleranzen und die Haltezeit so gewaehlt, dass
moeglichst viele gewollte Formen erkannt und moeglichst wenige ungewollte
ausgeloest werden. Die Werte gehen live per WebSocket an alle Geraete.
"""

from __future__ import annotations

import time
from typing import Any

from . import db

DEFAULTS: dict[str, float] = {
    "holdMs": 1500.0,
    "stillPx": 12.0,
    "ellipseTol": 0.12,
    "lineTol": 1.12,
}
BOUNDS: dict[str, tuple[float, float]] = {
    "holdMs": (1000.0, 2500.0),
    "ellipseTol": (0.06, 0.22),
    "lineTol": (1.04, 1.22),
}
EVENTS = {"snap_undone", "snap_kept", "snap_edited", "missed"}
WINDOW = 400  # so viele letzte Meldungen zaehlen
MIN_SAMPLES = 8  # darunter bleiben die Standardwerte
FP_WEIGHT = 1.3  # ein Fehlalarm stoert mehr als eine verpasste Form


def _init_sync() -> None:
    db._conn.execute(
        """
        CREATE TABLE IF NOT EXISTS shape_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            event TEXT NOT NULL,
            shape TEXT,
            ellipse REAL,
            line REAL,
            ms REAL
        )
        """
    )
    db._conn.commit()


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) < 1e9 else None


def _best_tol(pos: list[float], fp: list[float], default: float, lo: float, hi: float) -> float:
    """Toleranz, bei der (gewollt erkannt) - FP_WEIGHT * (ungewollt erkannt) am groessten ist."""
    if len(pos) + len(fp) < MIN_SAMPLES:
        return default
    steps = 64
    best_t = default
    best_score = None
    for i in range(steps + 1):
        t = lo + (hi - lo) * i / steps
        score = sum(1 for m in pos if m <= t) - FP_WEIGHT * sum(1 for m in fp if m <= t)
        # leichte Vorliebe fuer den Standard, damit wenige Meldungen nicht wild ausschlagen
        score -= 0.5 * abs(t - default) / (hi - lo)
        if best_score is None or score > best_score + 1e-9:
            best_score = score
            best_t = t
    return round(best_t, 4)


def compute_params(events: list[dict[str, Any]]) -> dict[str, float]:
    params = dict(DEFAULTS)
    pos_e: list[float] = []
    fp_e: list[float] = []
    pos_l: list[float] = []
    fp_l: list[float] = []
    snaps_ok = snaps_bad = missed = 0
    for ev in events:
        kind = ev.get("event")
        shape = ev.get("shape") or ""
        e = _num(ev.get("ellipse"))
        ln = _num(ev.get("line"))
        good = kind in ("snap_kept", "snap_edited", "missed")
        bad = kind == "snap_undone"
        if kind in ("snap_kept", "snap_edited"):
            snaps_ok += 1
        elif bad:
            snaps_bad += 1
        elif kind == "missed":
            missed += 1
        # verpasste Versuche: das Geraet schickt nur die passende Messgroesse
        # (geschlossener Strich -> ellipse, offener -> line)
        if kind == "missed":
            if e is not None:
                pos_e.append(e)
            elif ln is not None:
                pos_l.append(ln)
            continue
        if shape in ("circle", "ellipse") and e is not None:
            (pos_e if good else fp_e).append(e)
        elif shape == "line" and ln is not None:
            (pos_l if good else fp_l).append(ln)
    lo, hi = BOUNDS["ellipseTol"]
    params["ellipseTol"] = _best_tol(pos_e, fp_e, DEFAULTS["ellipseTol"], lo, hi)
    lo, hi = BOUNDS["lineTol"]
    params["lineTol"] = _best_tol(pos_l, fp_l, DEFAULTS["lineTol"], lo, hi)
    total = snaps_ok + snaps_bad + missed
    if total >= MIN_SAMPLES:
        fp_rate = snaps_bad / max(1, snaps_ok + snaps_bad)
        miss_rate = missed / max(1, snaps_ok + missed)
        hold = DEFAULTS["holdMs"] + 1200.0 * (fp_rate - 0.15) - 600.0 * (miss_rate - 0.15)
        lo, hi = BOUNDS["holdMs"]
        params["holdMs"] = float(round(max(lo, min(hi, hold)) / 50.0) * 50)
    return params


def compute_stats(events: list[dict[str, Any]]) -> dict[str, Any]:
    undone = [ev for ev in events if ev.get("event") == "snap_undone"]
    undo_ms = [m for m in (_num(ev.get("ms")) for ev in undone) if m is not None]
    return {
        "snaps": sum(1 for ev in events if str(ev.get("event", "")).startswith("snap_")),
        "kept": sum(1 for ev in events if ev.get("event") == "snap_kept"),
        "edited": sum(1 for ev in events if ev.get("event") == "snap_edited"),
        "undone": len(undone),
        "missed": sum(1 for ev in events if ev.get("event") == "missed"),
        "avgUndoMs": round(sum(undo_ms) / len(undo_ms)) if undo_ms else None,
    }


def _recent_sync() -> list[dict[str, Any]]:
    rows = db._conn.execute(
        "SELECT event, shape, ellipse, line, ms FROM shape_feedback ORDER BY id DESC LIMIT ?",
        (WINDOW,),
    ).fetchall()
    return [{"event": r[0], "shape": r[1], "ellipse": r[2], "line": r[3], "ms": r[4]} for r in rows]


def _add_sync(ev: dict[str, Any]) -> None:
    db._conn.execute(
        "INSERT INTO shape_feedback (ts, event, shape, ellipse, line, ms) VALUES (?, ?, ?, ?, ?, ?)",
        (time.time(), ev["event"], ev.get("shape"), ev.get("ellipse"), ev.get("line"), ev.get("ms")),
    )
    # alte Meldungen nicht ewig aufheben
    db._conn.execute(
        "DELETE FROM shape_feedback WHERE id <= (SELECT id FROM shape_feedback ORDER BY id DESC LIMIT 1 OFFSET ?)",
        (WINDOW * 5,),
    )
    db._conn.commit()


def clean_event(raw: dict[str, Any]) -> dict[str, Any] | None:
    kind = str(raw.get("event") or "")
    if kind not in EVENTS:
        return None
    shape = str(raw.get("shape") or "")[:16] or None
    return {
        "event": kind,
        "shape": shape,
        "ellipse": _num(raw.get("ellipse")),
        "line": _num(raw.get("line")),
        "ms": _num(raw.get("ms")),
    }


async def _run(fn, *args):
    import asyncio

    async with db._lock:
        return await asyncio.get_event_loop().run_in_executor(None, fn, *args)


async def init() -> None:
    await _run(_init_sync)


async def snapshot() -> dict[str, Any]:
    events = await _run(_recent_sync)
    return {"params": compute_params(events), "stats": compute_stats(events)}


async def add(raw: dict[str, Any]) -> tuple[dict[str, Any], bool] | None:
    """Speichert eine Meldung; liefert (neuer Stand, Parameter geaendert?)."""
    ev = clean_event(raw)
    if ev is None:
        return None
    before = compute_params(await _run(_recent_sync))
    await _run(_add_sync, ev)
    after = await snapshot()
    return after, after["params"] != before
