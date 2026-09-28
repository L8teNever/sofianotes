"""SQLite persistence for sofianotes.

Boards belong to a person. Folders and placements are per person so shared
boards can be sorted independently. Strokes stay on the board they were
drawn on.

Who is "logged in" as which person is resolved from the
Cf-Access-Authenticated-User-Email header (see auth.py) against the
person_emails table, managed by an admin. The three original people
(Simon, Franz, Die Jungen) are seeded once on first start so existing
boards/folders/shares referencing those ids keep working unchanged; an
admin can add further people afterwards.
"""
import asyncio
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

LEGACY_PEOPLE = (
    {"id": "simon", "name": "Simon"},
    {"id": "franz", "name": "Franz"},
    {"id": "jungen", "name": "Die Jungen"},
)
LEGACY_BOARD_ID = "00000000-0000-0000-0000-000000000001"

FOLDER_COLORS = ("#eaddff", "#d3e3fd", "#c4eed0", "#ffdec1", "#ffd8e4", "#fff3c4")
DEFAULT_FOLDER_COLOR = FOLDER_COLORS[0]

_person_ids_cache: set[str] = set()

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
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS boards (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            person_id TEXT NOT NULL,
            parent_id TEXT,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        )
        """
    )
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS placements (
            person_id TEXT NOT NULL,
            board_id TEXT NOT NULL,
            folder_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (person_id, board_id)
        )
        """
    )
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS shares (
            board_id TEXT NOT NULL,
            person_id TEXT NOT NULL,
            PRIMARY KEY (board_id, person_id)
        )
        """
    )
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS people (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        )
        """
    )
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS person_emails (
            email TEXT PRIMARY KEY,
            person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE
        )
        """
    )
    _seed_people_sync()
    _refresh_person_cache_sync()
    cols = {row[1] for row in _conn.execute("PRAGMA table_info(strokes)").fetchall()}
    if "extra" not in cols:
        _conn.execute("ALTER TABLE strokes ADD COLUMN extra TEXT")
    if "board_id" not in cols:
        _conn.execute("ALTER TABLE strokes ADD COLUMN board_id TEXT")
    folder_cols = {row[1] for row in _conn.execute("PRAGMA table_info(folders)").fetchall()}
    if "color" not in folder_cols:
        _conn.execute(f"ALTER TABLE folders ADD COLUMN color TEXT DEFAULT '{DEFAULT_FOLDER_COLOR}'")
    _migrate_legacy_sync()
    _conn.commit()


def _seed_people_sync() -> None:
    n = _conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
    if n == 0:
        now = time.time()
        for p in LEGACY_PEOPLE:
            _conn.execute(
                "INSERT INTO people (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)",
                (p["id"], p["name"], now),
            )


def _refresh_person_cache_sync() -> None:
    global _person_ids_cache
    _person_ids_cache = {r[0] for r in _conn.execute("SELECT id FROM people").fetchall()}


def _migrate_legacy_sync() -> None:
    n_boards = _conn.execute("SELECT COUNT(*) FROM boards").fetchone()[0]
    n_strokes = _conn.execute("SELECT COUNT(*) FROM strokes").fetchone()[0]
    now = time.time()
    if n_boards == 0 and n_strokes > 0:
        _conn.execute(
            "INSERT INTO boards (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (LEGACY_BOARD_ID, "simon", "Gemeinsames Blatt", now, now),
        )
        _conn.execute("UPDATE strokes SET board_id = ? WHERE board_id IS NULL OR board_id = ''", (LEGACY_BOARD_ID,))
        for pid in _person_ids_cache:
            _conn.execute(
                "INSERT OR IGNORE INTO placements (person_id, board_id, folder_id, sort_order) VALUES (?, ?, NULL, 0)",
                (pid, LEGACY_BOARD_ID),
            )
            if pid != "simon":
                _conn.execute(
                    "INSERT OR IGNORE INTO shares (board_id, person_id) VALUES (?, ?)",
                    (LEGACY_BOARD_ID, pid),
                )
    else:
        _conn.execute("UPDATE strokes SET board_id = ? WHERE board_id IS NULL OR board_id = ''", (LEGACY_BOARD_ID,))


def _load_all_sync(board_id: str | None = None) -> list[dict[str, Any]]:
    if board_id:
        cur = _conn.execute(
            "SELECT id, tool, color, size, points, extra FROM strokes WHERE board_id = ? ORDER BY created_at ASC",
            (board_id,),
        )
    else:
        cur = _conn.execute(
            "SELECT id, tool, color, size, points, extra FROM strokes ORDER BY created_at ASC"
        )
    strokes = []
    for row in cur.fetchall():
        item = {
            "id": row[0],
            "tool": row[1],
            "color": row[2],
            "size": row[3],
            "points": json.loads(row[4]),
        }
        if row[5]:
            try:
                extra = json.loads(row[5])
            except json.JSONDecodeError:
                extra = None
            if extra:
                item["extra"] = extra
        strokes.append(item)
    return strokes


def _insert_sync(stroke: dict[str, Any]) -> None:
    extra = stroke.get("extra")
    extra_json = json.dumps(extra) if extra is not None else None
    board_id = stroke.get("boardId") or stroke.get("board_id")
    _conn.execute(
        "INSERT OR REPLACE INTO strokes (id, tool, color, size, points, extra, created_at, board_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            stroke["id"],
            stroke["tool"],
            stroke["color"],
            stroke["size"],
            json.dumps(stroke["points"]),
            extra_json,
            time.time(),
            board_id,
        ),
    )
    if board_id:
        _conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (time.time(), board_id))
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


def use_database(path: str) -> None:
    global _conn, DB_PATH
    DB_PATH = Path(path)
    _conn.close()
    _conn = _connect()
    _init_sync()


async def load_all(board_id: str | None = None) -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _load_all_sync, board_id)


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


def valid_person(person_id: str | None) -> bool:
    return person_id in _person_ids_cache


def _board_row(board_id: str) -> dict[str, Any] | None:
    row = _conn.execute(
        "SELECT id, owner_id, title, created_at, updated_at FROM boards WHERE id = ?",
        (board_id,),
    ).fetchone()
    if not row:
        return None
    shared_with = [
        r[0]
        for r in _conn.execute("SELECT person_id FROM shares WHERE board_id = ?", (row[0],)).fetchall()
    ]
    return {
        "id": row[0],
        "ownerId": row[1],
        "title": row[2],
        "createdAt": row[3],
        "updatedAt": row[4],
        "sharedWith": shared_with,
    }


def _can_access_sync(person_id: str, board_id: str) -> bool:
    board = _board_row(board_id)
    if not board:
        return False
    if board["ownerId"] == person_id:
        return True
    row = _conn.execute(
        "SELECT 1 FROM shares WHERE board_id = ? AND person_id = ?",
        (board_id, person_id),
    ).fetchone()
    return bool(row)


def _library_sync(person_id: str, folder_id: str | None) -> dict[str, Any]:
    folders = []
    cur = _conn.execute(
        """
        SELECT id, parent_id, name, sort_order, color FROM folders
        WHERE person_id = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
        ORDER BY sort_order ASC, name COLLATE NOCASE ASC
        """,
        (person_id, folder_id, folder_id),
    )
    for row in cur.fetchall():
        folders.append(
            {"id": row[0], "parentId": row[1], "name": row[2], "sortOrder": row[3], "color": row[4] or DEFAULT_FOLDER_COLOR}
        )
    boards = []
    cur = _conn.execute(
        """
        SELECT b.id, b.owner_id, b.title, b.created_at, b.updated_at, p.folder_id, p.sort_order
        FROM placements p
        JOIN boards b ON b.id = p.board_id
        WHERE p.person_id = ? AND ((p.folder_id IS NULL AND ? IS NULL) OR p.folder_id = ?)
        ORDER BY p.sort_order ASC, b.updated_at DESC
        """,
        (person_id, folder_id, folder_id),
    )
    for row in cur.fetchall():
        shared_with = [
            r[0]
            for r in _conn.execute("SELECT person_id FROM shares WHERE board_id = ?", (row[0],)).fetchall()
        ]
        boards.append(
            {
                "id": row[0],
                "ownerId": row[1],
                "title": row[2],
                "createdAt": row[3],
                "updatedAt": row[4],
                "folderId": row[5],
                "sortOrder": row[6],
                "shared": row[1] != person_id,
                "sharedWith": shared_with,
            }
        )
    crumbs = []
    walk = folder_id
    seen = set()
    while walk and walk not in seen:
        seen.add(walk)
        row = _conn.execute(
            "SELECT id, parent_id, name FROM folders WHERE id = ? AND person_id = ?",
            (walk, person_id),
        ).fetchone()
        if not row:
            break
        crumbs.append({"id": row[0], "parentId": row[1], "name": row[2]})
        walk = row[1]
    crumbs.reverse()
    all_folders = [
        {"id": r[0], "parentId": r[1], "name": r[2]}
        for r in _conn.execute(
            "SELECT id, parent_id, name FROM folders WHERE person_id = ? ORDER BY name COLLATE NOCASE",
            (person_id,),
        ).fetchall()
    ]
    return {"personId": person_id, "folderId": folder_id, "folders": folders, "boards": boards, "crumbs": crumbs, "allFolders": all_folders}


def _create_board_sync(person_id: str, title: str, folder_id: str | None, board_id: str | None = None) -> dict[str, Any]:
    now = time.time()
    board_id = board_id or str(uuid.uuid4())
    title = (title or "").strip() or "Unbenannte Skizze"
    existing = _board_row(board_id)
    if existing:
        return existing
    _conn.execute(
        "INSERT INTO boards (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (board_id, person_id, title, now, now),
    )
    _conn.execute(
        "INSERT INTO placements (person_id, board_id, folder_id, sort_order) VALUES (?, ?, ?, 0)",
        (person_id, board_id, folder_id),
    )
    _conn.commit()
    board = _board_row(board_id)
    board["shared"] = False
    board["folderId"] = folder_id
    return board


def _rename_board_sync(person_id: str, board_id: str, title: str) -> dict[str, Any] | None:
    if not _can_access_sync(person_id, board_id):
        return None
    title = (title or "").strip() or "Unbenannte Skizze"
    _conn.execute("UPDATE boards SET title = ?, updated_at = ? WHERE id = ?", (title, time.time(), board_id))
    _conn.commit()
    return _board_row(board_id)


def _delete_board_sync(person_id: str, board_id: str) -> bool:
    board = _board_row(board_id)
    if not board or board["ownerId"] != person_id:
        return False
    _conn.execute("DELETE FROM strokes WHERE board_id = ?", (board_id,))
    _conn.execute("DELETE FROM placements WHERE board_id = ?", (board_id,))
    _conn.execute("DELETE FROM shares WHERE board_id = ?", (board_id,))
    _conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))
    _conn.commit()
    return True


def _share_sync(person_id: str, board_id: str, with_person: str) -> dict[str, Any] | None:
    board = _board_row(board_id)
    if not board or board["ownerId"] != person_id:
        return None
    if with_person not in _person_ids_cache or with_person == person_id:
        return None
    _conn.execute("INSERT OR IGNORE INTO shares (board_id, person_id) VALUES (?, ?)", (board_id, with_person))
    _conn.execute(
        "INSERT OR IGNORE INTO placements (person_id, board_id, folder_id, sort_order) VALUES (?, ?, NULL, 0)",
        (with_person, board_id),
    )
    _conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (time.time(), board_id))
    _conn.commit()
    return _board_row(board_id)


def _unshare_sync(person_id: str, board_id: str, with_person: str) -> bool:
    board = _board_row(board_id)
    if not board or board["ownerId"] != person_id:
        return False
    _conn.execute("DELETE FROM shares WHERE board_id = ? AND person_id = ?", (board_id, with_person))
    _conn.execute("DELETE FROM placements WHERE person_id = ? AND board_id = ?", (with_person, board_id))
    _conn.commit()
    return True


def _create_folder_sync(
    person_id: str, name: str, parent_id: str | None, folder_id: str | None = None, color: str | None = None
) -> dict[str, Any]:
    name = (name or "").strip() or "Ordner"
    color = color if color in FOLDER_COLORS else DEFAULT_FOLDER_COLOR
    folder_id = folder_id or str(uuid.uuid4())
    row = _conn.execute("SELECT id, parent_id, name, sort_order, color FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if row:
        return {"id": row[0], "parentId": row[1], "name": row[2], "sortOrder": row[3], "color": row[4] or DEFAULT_FOLDER_COLOR}
    if parent_id:
        row = _conn.execute(
            "SELECT 1 FROM folders WHERE id = ? AND person_id = ?",
            (parent_id, person_id),
        ).fetchone()
        if not row:
            parent_id = None
    _conn.execute(
        "INSERT INTO folders (id, person_id, parent_id, name, sort_order, created_at, color) VALUES (?, ?, ?, ?, 0, ?, ?)",
        (folder_id, person_id, parent_id, name, time.time(), color),
    )
    _conn.commit()
    return {"id": folder_id, "parentId": parent_id, "name": name, "sortOrder": 0, "color": color}


def _rename_folder_sync(person_id: str, folder_id: str, name: str | None, color: str | None = None) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = []
    if name is not None:
        sets.append("name = ?")
        params.append(name.strip() or "Ordner")
    if color in FOLDER_COLORS:
        sets.append("color = ?")
        params.append(color)
    if not sets:
        row = _conn.execute(
            "SELECT id FROM folders WHERE id = ? AND person_id = ?", (folder_id, person_id)
        ).fetchone()
        if not row:
            return None
    else:
        params.extend([folder_id, person_id])
        cur = _conn.execute(
            f"UPDATE folders SET {', '.join(sets)} WHERE id = ? AND person_id = ?", params
        )
        _conn.commit()
        if cur.rowcount == 0:
            return None
    row = _conn.execute(
        "SELECT id, parent_id, name, sort_order, color FROM folders WHERE id = ?",
        (folder_id,),
    ).fetchone()
    return {"id": row[0], "parentId": row[1], "name": row[2], "sortOrder": row[3], "color": row[4] or DEFAULT_FOLDER_COLOR}


def _folder_descendants(person_id: str, folder_id: str) -> set[str]:
    out = {folder_id}
    stack = [folder_id]
    while stack:
        current = stack.pop()
        rows = _conn.execute(
            "SELECT id FROM folders WHERE person_id = ? AND parent_id = ?",
            (person_id, current),
        ).fetchall()
        for (cid,) in rows:
            if cid not in out:
                out.add(cid)
                stack.append(cid)
    return out


def _move_folder_sync(person_id: str, folder_id: str, parent_id: str | None) -> bool:
    row = _conn.execute(
        "SELECT 1 FROM folders WHERE id = ? AND person_id = ?",
        (folder_id, person_id),
    ).fetchone()
    if not row:
        return False
    if parent_id:
        if parent_id in _folder_descendants(person_id, folder_id):
            return False
        ok = _conn.execute(
            "SELECT 1 FROM folders WHERE id = ? AND person_id = ?",
            (parent_id, person_id),
        ).fetchone()
        if not ok:
            return False
    _conn.execute(
        "UPDATE folders SET parent_id = ? WHERE id = ? AND person_id = ?",
        (parent_id, folder_id, person_id),
    )
    _conn.commit()
    return True


def _delete_folder_sync(person_id: str, folder_id: str) -> bool:
    row = _conn.execute(
        "SELECT parent_id FROM folders WHERE id = ? AND person_id = ?",
        (folder_id, person_id),
    ).fetchone()
    if not row:
        return False
    parent_id = row[0]
    _conn.execute(
        "UPDATE folders SET parent_id = ? WHERE person_id = ? AND parent_id = ?",
        (parent_id, person_id, folder_id),
    )
    _conn.execute(
        "UPDATE placements SET folder_id = ? WHERE person_id = ? AND folder_id = ?",
        (parent_id, person_id, folder_id),
    )
    _conn.execute("DELETE FROM folders WHERE id = ? AND person_id = ?", (folder_id, person_id))
    _conn.commit()
    return True


def _place_board_sync(person_id: str, board_id: str, folder_id: str | None) -> bool:
    if not _can_access_sync(person_id, board_id):
        return False
    if folder_id:
        ok = _conn.execute(
            "SELECT 1 FROM folders WHERE id = ? AND person_id = ?",
            (folder_id, person_id),
        ).fetchone()
        if not ok:
            return False
    cur = _conn.execute(
        "UPDATE placements SET folder_id = ? WHERE person_id = ? AND board_id = ?",
        (folder_id, person_id, board_id),
    )
    if cur.rowcount == 0:
        _conn.execute(
            "INSERT INTO placements (person_id, board_id, folder_id, sort_order) VALUES (?, ?, ?, 0)",
            (person_id, board_id, folder_id),
        )
    _conn.commit()
    return True


def _people_sync() -> list[dict[str, Any]]:
    rows = _conn.execute(
        "SELECT id, name, is_admin FROM people ORDER BY created_at ASC, rowid ASC"
    ).fetchall()
    return [{"id": r[0], "name": r[1], "isAdmin": bool(r[2])} for r in rows]


def _people_admin_sync() -> list[dict[str, Any]]:
    people = _people_sync()
    for p in people:
        p["emails"] = [
            r[0]
            for r in _conn.execute(
                "SELECT email FROM person_emails WHERE person_id = ? ORDER BY email ASC", (p["id"],)
            ).fetchall()
        ]
    return people


def _person_by_email_sync(email: str) -> dict[str, Any] | None:
    row = _conn.execute(
        """
        SELECT p.id, p.name, p.is_admin
        FROM person_emails pe JOIN people p ON p.id = pe.person_id
        WHERE pe.email = ?
        """,
        (email.strip().lower(),),
    ).fetchone()
    if row is None:
        return None
    return {"id": row[0], "name": row[1], "isAdmin": bool(row[2])}


def _ensure_admin_sync(email: str) -> None:
    email = email.strip().lower()
    if not email:
        return
    row = _conn.execute("SELECT person_id FROM person_emails WHERE email = ?", (email,)).fetchone()
    if row is not None:
        _conn.execute("UPDATE people SET is_admin = 1 WHERE id = ?", (row[0],))
        _conn.commit()
        return
    simon_claimed = _conn.execute(
        "SELECT 1 FROM person_emails WHERE person_id = 'simon'"
    ).fetchone()
    simon_exists = _conn.execute("SELECT 1 FROM people WHERE id = 'simon'").fetchone()
    if simon_exists and not simon_claimed:
        target_id = "simon"
        _conn.execute("UPDATE people SET is_admin = 1 WHERE id = ?", (target_id,))
    else:
        target_id = str(uuid.uuid4())
        _conn.execute(
            "INSERT INTO people (id, name, is_admin, created_at) VALUES (?, 'Admin', 1, ?)",
            (target_id, time.time()),
        )
    _conn.execute("INSERT INTO person_emails (email, person_id) VALUES (?, ?)", (email, target_id))
    _conn.commit()
    _refresh_person_cache_sync()


def _create_person_sync(name: str) -> dict[str, Any]:
    person_id = str(uuid.uuid4())
    name = (name or "").strip() or "Neue Person"
    now = time.time()
    _conn.execute(
        "INSERT INTO people (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)",
        (person_id, name, now),
    )
    _conn.commit()
    _refresh_person_cache_sync()
    return {"id": person_id, "name": name, "isAdmin": False, "emails": []}


def _rename_person_sync(person_id: str, name: str) -> bool:
    name = (name or "").strip()
    if not name:
        return False
    cur = _conn.execute("UPDATE people SET name = ? WHERE id = ?", (name, person_id))
    _conn.commit()
    return cur.rowcount > 0


def _delete_person_sync(person_id: str) -> str | None:
    """Returns None on success, or an error code string."""
    if not _conn.execute("SELECT 1 FROM people WHERE id = ?", (person_id,)).fetchone():
        return "not_found"
    if _conn.execute("SELECT 1 FROM boards WHERE owner_id = ?", (person_id,)).fetchone():
        return "owns_boards"
    _conn.execute("DELETE FROM person_emails WHERE person_id = ?", (person_id,))
    _conn.execute("DELETE FROM folders WHERE person_id = ?", (person_id,))
    _conn.execute("DELETE FROM placements WHERE person_id = ?", (person_id,))
    _conn.execute("DELETE FROM shares WHERE person_id = ?", (person_id,))
    _conn.execute("DELETE FROM people WHERE id = ?", (person_id,))
    _conn.commit()
    _refresh_person_cache_sync()
    return None


def _add_person_email_sync(person_id: str, email: str) -> bool:
    email = email.strip().lower()
    if not _conn.execute("SELECT 1 FROM people WHERE id = ?", (person_id,)).fetchone():
        return False
    if _conn.execute("SELECT 1 FROM person_emails WHERE email = ?", (email,)).fetchone():
        return False
    _conn.execute("INSERT INTO person_emails (email, person_id) VALUES (?, ?)", (email, person_id))
    _conn.commit()
    return True


def _remove_person_email_sync(person_id: str, email: str) -> None:
    _conn.execute(
        "DELETE FROM person_emails WHERE email = ? AND person_id = ?",
        (email.strip().lower(), person_id),
    )
    _conn.commit()


async def people() -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _people_sync)


async def people_admin() -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _people_admin_sync)


async def person_by_email(email: str) -> dict[str, Any] | None:
    if not email:
        return None
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _person_by_email_sync, email)


async def ensure_admin(email: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _ensure_admin_sync, email)


async def create_person(name: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _create_person_sync, name)


async def rename_person(person_id: str, name: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _rename_person_sync, person_id, name)


async def delete_person(person_id: str) -> str | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _delete_person_sync, person_id)


async def add_person_email(person_id: str, email: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _add_person_email_sync, person_id, email)


async def remove_person_email(person_id: str, email: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _remove_person_email_sync, person_id, email)


async def can_access(person_id: str, board_id: str) -> bool:
    if not valid_person(person_id):
        return False
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _can_access_sync, person_id, board_id)


async def get_board(board_id: str) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _board_row, board_id)


async def library(person_id: str, folder_id: str | None) -> dict[str, Any] | None:
    if not valid_person(person_id):
        return None
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _library_sync, person_id, folder_id)


async def create_board(person_id: str, title: str, folder_id: str | None, board_id: str | None = None) -> dict[str, Any] | None:
    if not valid_person(person_id):
        return None
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(
            None, _create_board_sync, person_id, title, folder_id, board_id
        )


async def rename_board(person_id: str, board_id: str, title: str) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _rename_board_sync, person_id, board_id, title)


async def delete_board(person_id: str, board_id: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _delete_board_sync, person_id, board_id)


async def share_board(person_id: str, board_id: str, with_person: str) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _share_sync, person_id, board_id, with_person)


async def unshare_board(person_id: str, board_id: str, with_person: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _unshare_sync, person_id, board_id, with_person)


async def create_folder(
    person_id: str, name: str, parent_id: str | None, folder_id: str | None = None, color: str | None = None
) -> dict[str, Any] | None:
    if not valid_person(person_id):
        return None
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(
            None, _create_folder_sync, person_id, name, parent_id, folder_id, color
        )


async def rename_folder(person_id: str, folder_id: str, name: str | None, color: str | None = None) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _rename_folder_sync, person_id, folder_id, name, color)


async def move_folder(person_id: str, folder_id: str, parent_id: str | None) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _move_folder_sync, person_id, folder_id, parent_id)


async def delete_folder(person_id: str, folder_id: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _delete_folder_sync, person_id, folder_id)


async def place_board(person_id: str, board_id: str, folder_id: str | None) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _place_board_sync, person_id, board_id, folder_id)
