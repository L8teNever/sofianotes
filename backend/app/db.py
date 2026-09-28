"""SQLite persistence for sofianotes.

Mehrere Boards, jedes einem Nutzer zugeordnet. Ein Nutzer kann mehrere
E-Mail-Adressen haben (alle loggen ihn ein); welche E-Mail zu welchem
Nutzer gehoert, legt ein Admin fest. Reads/writes sind selten (einmal pro
fertigem Strich/Radiergummi-Aktion bzw. Board-/Nutzerverwaltung), deshalb
reichen blockierende sqlite3-Aufrufe ueber run_in_executor - keine async
Treiber noetig.
"""
import asyncio
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "board.db"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


_conn = _connect()
_lock = asyncio.Lock()


def _init_sync() -> None:
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_emails (
            email TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS boards (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS strokes (
            id TEXT PRIMARY KEY,
            board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            tool TEXT NOT NULL,
            color TEXT NOT NULL,
            size REAL NOT NULL,
            points TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_strokes_board ON strokes(board_id);
        CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id);
        """
    )
    _conn.commit()


def _ensure_admin_sync(admin_email: str) -> None:
    email = admin_email.strip().lower()
    row = _conn.execute("SELECT user_id FROM user_emails WHERE email = ?", (email,)).fetchone()
    if row is not None:
        _conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (row[0],))
        _conn.commit()
        return
    user_id = str(uuid.uuid4())
    now = time.time()
    _conn.execute(
        "INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 1, ?)",
        (user_id, "Admin", now),
    )
    _conn.execute("INSERT INTO user_emails (email, user_id) VALUES (?, ?)", (email, user_id))
    _conn.commit()


# ---- users / auth -------------------------------------------------------


def _find_user_by_email_sync(email: str) -> dict[str, Any] | None:
    row = _conn.execute(
        """
        SELECT u.id, u.name, u.is_admin
        FROM user_emails ue JOIN users u ON u.id = ue.user_id
        WHERE ue.email = ?
        """,
        (email.strip().lower(),),
    ).fetchone()
    if row is None:
        return None
    return {"id": row[0], "name": row[1], "is_admin": bool(row[2])}


def _list_users_sync() -> list[dict[str, Any]]:
    users = _conn.execute(
        "SELECT id, name, is_admin, created_at FROM users ORDER BY created_at ASC"
    ).fetchall()
    result = []
    for uid, name, is_admin, created_at in users:
        emails = [
            r[0]
            for r in _conn.execute(
                "SELECT email FROM user_emails WHERE user_id = ? ORDER BY email ASC", (uid,)
            ).fetchall()
        ]
        result.append(
            {"id": uid, "name": name, "is_admin": bool(is_admin), "created_at": created_at, "emails": emails}
        )
    return result


def _create_user_sync(name: str) -> dict[str, Any]:
    user_id = str(uuid.uuid4())
    now = time.time()
    _conn.execute(
        "INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)",
        (user_id, name, now),
    )
    _conn.commit()
    return {"id": user_id, "name": name, "is_admin": False, "created_at": now, "emails": []}


def _delete_user_sync(user_id: str) -> None:
    _conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    _conn.commit()


def _add_email_sync(user_id: str, email: str) -> bool:
    email = email.strip().lower()
    existing = _conn.execute("SELECT 1 FROM user_emails WHERE email = ?", (email,)).fetchone()
    if existing is not None:
        return False
    _conn.execute("INSERT INTO user_emails (email, user_id) VALUES (?, ?)", (email, user_id))
    _conn.commit()
    return True


def _remove_email_sync(user_id: str, email: str) -> None:
    _conn.execute(
        "DELETE FROM user_emails WHERE email = ? AND user_id = ?", (email.strip().lower(), user_id)
    )
    _conn.commit()


# ---- boards ---------------------------------------------------------------


def _list_boards_sync(user_id: str) -> list[dict[str, Any]]:
    rows = _conn.execute(
        "SELECT id, name, created_at FROM boards WHERE user_id = ? ORDER BY created_at ASC",
        (user_id,),
    ).fetchall()
    return [{"id": r[0], "name": r[1], "created_at": r[2]} for r in rows]


def _get_board_sync(board_id: str) -> dict[str, Any] | None:
    row = _conn.execute(
        "SELECT id, user_id, name, created_at FROM boards WHERE id = ?", (board_id,)
    ).fetchone()
    if row is None:
        return None
    return {"id": row[0], "user_id": row[1], "name": row[2], "created_at": row[3]}


def _create_board_sync(user_id: str, name: str) -> dict[str, Any]:
    board_id = str(uuid.uuid4())
    now = time.time()
    _conn.execute(
        "INSERT INTO boards (id, user_id, name, created_at) VALUES (?, ?, ?, ?)",
        (board_id, user_id, name, now),
    )
    _conn.commit()
    return {"id": board_id, "name": name, "created_at": now}


def _rename_board_sync(board_id: str, name: str) -> None:
    _conn.execute("UPDATE boards SET name = ? WHERE id = ?", (name, board_id))
    _conn.commit()


def _delete_board_sync(board_id: str) -> None:
    _conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))
    _conn.commit()


# ---- strokes ---------------------------------------------------------------


def _load_all_sync(board_id: str) -> list[dict[str, Any]]:
    cur = _conn.execute(
        "SELECT id, tool, color, size, points FROM strokes WHERE board_id = ? ORDER BY created_at ASC",
        (board_id,),
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


def _insert_sync(board_id: str, stroke: dict[str, Any]) -> None:
    _conn.execute(
        "INSERT OR REPLACE INTO strokes (id, board_id, tool, color, size, points, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            stroke["id"],
            board_id,
            stroke["tool"],
            stroke["color"],
            stroke["size"],
            json.dumps(stroke["points"]),
            time.time(),
        ),
    )
    _conn.commit()


def _delete_sync(board_id: str, stroke_ids: list[str]) -> None:
    if not stroke_ids:
        return
    placeholders = ",".join("?" for _ in stroke_ids)
    _conn.execute(
        f"DELETE FROM strokes WHERE board_id = ? AND id IN ({placeholders})",
        [board_id, *stroke_ids],
    )
    _conn.commit()


# ---- async wrappers ---------------------------------------------------------


async def init() -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _init_sync)


async def ensure_admin(admin_email: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _ensure_admin_sync, admin_email)


async def find_user_by_email(email: str) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _find_user_by_email_sync, email)


async def list_users() -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _list_users_sync)


async def create_user(name: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _create_user_sync, name)


async def delete_user(user_id: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _delete_user_sync, user_id)


async def add_email(user_id: str, email: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _add_email_sync, user_id, email)


async def remove_email(user_id: str, email: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _remove_email_sync, user_id, email)


async def list_boards(user_id: str) -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _list_boards_sync, user_id)


async def get_board(board_id: str) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _get_board_sync, board_id)


async def create_board(user_id: str, name: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _create_board_sync, user_id, name)


async def rename_board(board_id: str, name: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _rename_board_sync, board_id, name)


async def delete_board(board_id: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _delete_board_sync, board_id)


async def load_all(board_id: str) -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _load_all_sync, board_id)


async def insert_stroke(board_id: str, stroke: dict[str, Any]) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _insert_sync, board_id, stroke)


async def delete_strokes(board_id: str, stroke_ids: list[str]) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _delete_sync, board_id, stroke_ids)
