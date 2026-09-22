"""SQLite persistence for the sofianotes whiteboard.

One board, stored as a flat table of finished strokes. Reads/writes are
infrequent (once per finished stroke or eraser action) so plain blocking
sqlite3 calls off the event loop via run_in_executor are enough - no need
for an async driver here.
"""
import asyncio
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "board.db"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


_conn = _connect()
_lock = asyncio.Lock()


def _init_sync() -> None:
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS strokes (
            id TEXT PRIMARY KEY,
            tool TEXT NOT NULL,
            color TEXT NOT NULL,
            size REAL NOT NULL,
            points TEXT NOT NULL,
            created_at REAL NOT NULL
        )
        """
    )
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ocr_usage (
            day TEXT PRIMARY KEY,
            neurons REAL NOT NULL DEFAULT 0,
            calls INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    _conn.commit()


def _load_all_sync() -> list[dict[str, Any]]:
    cur = _conn.execute(
        "SELECT id, tool, color, size, points FROM strokes ORDER BY created_at ASC"
    )
    strokes = []
    for row in cur.fetchall():
        strokes.append(
            {
                "id": row[0],
                "tool": row[1],
                "color": row[2],
                "size": row[3],
                "points": json.loads(row[4]),
            }
        )
    return strokes


def _insert_sync(stroke: dict[str, Any]) -> None:
    _conn.execute(
        "INSERT OR REPLACE INTO strokes (id, tool, color, size, points, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            stroke["id"],
            stroke["tool"],
            stroke["color"],
            stroke["size"],
            json.dumps(stroke["points"]),
            time.time(),
        ),
    )
    _conn.commit()


def _delete_sync(stroke_ids: list[str]) -> None:
    if not stroke_ids:
        return
    placeholders = ",".join("?" for _ in stroke_ids)
    _conn.execute(f"DELETE FROM strokes WHERE id IN ({placeholders})", stroke_ids)
    _conn.commit()


async def init() -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _init_sync)


async def load_all() -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _load_all_sync)


async def insert_stroke(stroke: dict[str, Any]) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _insert_sync, stroke)


async def delete_strokes(stroke_ids: list[str]) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _delete_sync, stroke_ids)


def _ocr_day() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _ocr_snapshot_sync() -> dict[str, float]:
    day = _ocr_day()
    row = _conn.execute(
        "SELECT neurons, calls FROM ocr_usage WHERE day = ?", (day,)
    ).fetchone()
    used = float(row[0]) if row else 0.0
    calls = int(row[1]) if row else 0
    return {"day": day, "used": used, "calls": calls}


def _ocr_reserve_sync(amount: float, budget: float) -> dict[str, float] | None:
    snap = _ocr_snapshot_sync()
    if snap["used"] + amount > budget + 1e-6:
        return None
    _conn.execute(
        """
        INSERT INTO ocr_usage (day, neurons, calls) VALUES (?, ?, 1)
        ON CONFLICT(day) DO UPDATE SET
            neurons = neurons + excluded.neurons,
            calls = calls + 1
        """,
        (snap["day"], amount),
    )
    _conn.commit()
    return _ocr_snapshot_sync()


def _ocr_adjust_sync(delta: float) -> None:
    day = _ocr_day()
    _conn.execute(
        """
        INSERT INTO ocr_usage (day, neurons, calls) VALUES (?, ?, 0)
        ON CONFLICT(day) DO UPDATE SET neurons = MAX(0, neurons + ?)
        """,
        (day, delta, delta),
    )
    _conn.commit()


def _ocr_fill_sync(budget: float) -> None:
    day = _ocr_day()
    _conn.execute(
        """
        INSERT INTO ocr_usage (day, neurons, calls) VALUES (?, ?, 0)
        ON CONFLICT(day) DO UPDATE SET neurons = MAX(neurons, ?)
        """,
        (day, budget, budget),
    )
    _conn.commit()


async def ocr_snapshot() -> dict[str, float]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _ocr_snapshot_sync)


async def ocr_reserve(amount: float, budget: float) -> dict[str, float] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(
            None, _ocr_reserve_sync, amount, budget
        )


async def ocr_adjust(delta: float) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _ocr_adjust_sync, delta)


async def ocr_fill(budget: float) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _ocr_fill_sync, budget)
