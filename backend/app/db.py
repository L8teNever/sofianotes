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
import random
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
    # Versionsverlauf: jede Aenderung an einem Strich (vorher/nachher, wer, wann)
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS stroke_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id TEXT NOT NULL,
            stroke_id TEXT NOT NULL,
            person_id TEXT,
            at REAL NOT NULL,
            before TEXT,
            after TEXT
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS stroke_log_board ON stroke_log (board_id, id)")
    # Eingang: Blaetter/PDFs, die jemand einem geschickt hat (Kopie, keine Zusammenarbeit)
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            to_person TEXT NOT NULL,
            from_person TEXT,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            board_id TEXT,
            file_id TEXT,
            at REAL NOT NULL,
            seen INTEGER NOT NULL DEFAULT 0
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
    if "author" not in cols:
        # wer den Strich angelegt hat (fuer "nur hinzufuegen": eigene Striche aendern ja, fremde nein)
        _conn.execute("ALTER TABLE strokes ADD COLUMN author TEXT")
        # einmalig aus dem Verlauf nachtragen (ein Durchgang, erster Eintrag je Strich)
        try:
            first: dict[str, str] = {}
            for sid, pid in _conn.execute("SELECT stroke_id, person_id FROM stroke_log ORDER BY id ASC"):
                if sid not in first and pid:
                    first[sid] = pid
            _conn.executemany("UPDATE strokes SET author = ? WHERE id = ? AND author IS NULL", [(p, i) for i, p in first.items()])
        except sqlite3.OperationalError:
            pass
    share_cols = {row[1] for row in _conn.execute("PRAGMA table_info(shares)").fetchall()}
    if "role" not in share_cols:
        # edit = alles, add = nur dazuschreiben (eigenes aendern), view = nur ansehen
        _conn.execute("ALTER TABLE shares ADD COLUMN role TEXT NOT NULL DEFAULT 'edit'")
    folder_cols = {row[1] for row in _conn.execute("PRAGMA table_info(folders)").fetchall()}
    if "color" not in folder_cols:
        _conn.execute(f"ALTER TABLE folders ADD COLUMN color TEXT DEFAULT '{DEFAULT_FOLDER_COLOR}'")
    if "starred" not in folder_cols:
        _conn.execute("ALTER TABLE folders ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
    board_cols = {row[1] for row in _conn.execute("PRAGMA table_info(boards)").fetchall()}
    if "sofia_homework_id" not in board_cols:
        _conn.execute("ALTER TABLE boards ADD COLUMN sofia_homework_id INTEGER")
    if "solution_share" not in board_cols:
        _conn.execute("ALTER TABLE boards ADD COLUMN solution_share INTEGER NOT NULL DEFAULT 1")
    if "sofia_solution_id" not in board_cols:
        _conn.execute("ALTER TABLE boards ADD COLUMN sofia_solution_id INTEGER")
    if "solution_synced_at" not in board_cols:
        _conn.execute("ALTER TABLE boards ADD COLUMN solution_synced_at REAL")
    if "solution_error" not in board_cols:
        _conn.execute("ALTER TABLE boards ADD COLUMN solution_error TEXT")
    if "paper" not in board_cols:
        _conn.execute("ALTER TABLE boards ADD COLUMN paper TEXT")
    board_cols3 = {row[1] for row in _conn.execute("PRAGMA table_info(boards)").fetchall()}
    if "refs" not in board_cols3:
        _conn.execute("ALTER TABLE boards ADD COLUMN refs TEXT")
    if "notebook" not in board_cols3:
        # Notizbuch mit A4-Seiten statt unendlichem Blatt (JSON: layout, template, pages)
        _conn.execute("ALTER TABLE boards ADD COLUMN notebook TEXT")
    if "paper" not in folder_cols:
        _conn.execute("ALTER TABLE folders ADD COLUMN paper TEXT")
    people_cols2 = {row[1] for row in _conn.execute("PRAGMA table_info(people)").fetchall()}
    if "solution_mode" not in people_cols2:
        _conn.execute("ALTER TABLE people ADD COLUMN solution_mode TEXT NOT NULL DEFAULT 'auto'")
    if "default_paper" not in people_cols2:
        _conn.execute("ALTER TABLE people ADD COLUMN default_paper TEXT NOT NULL DEFAULT 'graph'")
    if "prefs" not in people_cols2:
        _conn.execute("ALTER TABLE people ADD COLUMN prefs TEXT")
        _conn.execute("ALTER TABLE people ADD COLUMN prefs_at REAL")
    if "sofia_subject_id" not in folder_cols:
        _conn.execute("ALTER TABLE folders ADD COLUMN sofia_subject_id INTEGER")
    people_cols = {row[1] for row in _conn.execute("PRAGMA table_info(people)").fetchall()}
    if "sofia_user_id" not in people_cols:
        _conn.execute("ALTER TABLE people ADD COLUMN sofia_user_id INTEGER")
    if "active" not in people_cols:
        _conn.execute("ALTER TABLE people ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    if "sofia_email" not in people_cols:
        _conn.execute("ALTER TABLE people ADD COLUMN sofia_email TEXT")
    if "color" not in people_cols:
        # feste Farbe pro Person (Cursor im Blatt, Versionsverlauf)
        _conn.execute("ALTER TABLE people ADD COLUMN color TEXT")
    placement_cols = {row[1] for row in _conn.execute("PRAGMA table_info(placements)").fetchall()}
    if "starred" not in placement_cols:
        _conn.execute("ALTER TABLE placements ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
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
            "SELECT id, tool, color, size, points, extra, author FROM strokes WHERE board_id = ? ORDER BY created_at ASC",
            (board_id,),
        )
    else:
        cur = _conn.execute(
            "SELECT id, tool, color, size, points, extra, author FROM strokes ORDER BY created_at ASC"
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
        if row[6]:
            item["author"] = row[6]
        strokes.append(item)
    return strokes


def _stroke_json_sync(stroke_id: str) -> tuple[str | None, str | None]:
    """(board_id, JSON des Strichs) oder (None, None)."""
    row = _conn.execute("SELECT id, tool, color, size, points, extra, board_id FROM strokes WHERE id = ?", (stroke_id,)).fetchone()
    if not row:
        return None, None
    item: dict[str, Any] = {"id": row[0], "tool": row[1], "color": row[2], "size": row[3], "points": json.loads(row[4])}
    if row[5]:
        try:
            extra = json.loads(row[5])
        except ValueError:
            extra = None
        if extra:
            item["extra"] = extra
    return row[6], json.dumps(item)


def _clean_stroke(stroke: dict[str, Any]) -> dict[str, Any]:
    item = {k: stroke[k] for k in ("id", "tool", "color", "size", "points") if k in stroke}
    if stroke.get("extra") is not None:
        item["extra"] = stroke["extra"]
    return item


def _log_sync(board_id: str | None, stroke_id: str, person_id: str | None, before: str | None, after: str | None) -> None:
    if not board_id or before == after:
        return
    _conn.execute(
        "INSERT INTO stroke_log (board_id, stroke_id, person_id, at, before, after) VALUES (?, ?, ?, ?, ?, ?)",
        (board_id, stroke_id, person_id, time.time(), before, after),
    )


def _insert_sync(stroke: dict[str, Any], person_id: str | None = None) -> None:
    extra = stroke.get("extra")
    extra_json = json.dumps(extra) if extra is not None else None
    board_id = stroke.get("boardId") or stroke.get("board_id")
    if person_id:
        _, before = _stroke_json_sync(stroke["id"])
        _log_sync(board_id, stroke["id"], person_id, before, json.dumps(_clean_stroke(stroke)))
    # Beim Aendern bleibt created_at (= Reihenfolge beim Laden) erhalten
    _conn.execute(
        "INSERT INTO strokes (id, tool, color, size, points, extra, created_at, board_id, author) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET tool = excluded.tool, color = excluded.color, size = excluded.size, "
        "points = excluded.points, extra = excluded.extra, board_id = excluded.board_id",
        (
            stroke["id"],
            stroke["tool"],
            stroke["color"],
            stroke["size"],
            json.dumps(stroke["points"]),
            extra_json,
            time.time(),
            board_id,
            person_id or stroke.get("author"),
        ),
    )
    if board_id:
        _conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (time.time(), board_id))
    _conn.commit()


def _stroke_owners_sync(stroke_ids: list[str]) -> dict[str, str | None]:
    """Strich-ID -> Autor (None = unbekannt/alt) fuer vorhandene Striche."""
    out: dict[str, str | None] = {}
    ids = [str(x) for x in stroke_ids if x][:2000]
    for i in range(0, len(ids), 500):
        part = ids[i : i + 500]
        q = ",".join("?" for _ in part)
        for sid, author in _conn.execute(f"SELECT id, author FROM strokes WHERE id IN ({q})", part).fetchall():
            out[sid] = author
    return out


async def stroke_owners(stroke_ids: list[str]) -> dict[str, str | None]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _stroke_owners_sync, stroke_ids)


def _filter_owner_protected_sync(board_id: str, person_id: str, ids: list[str]) -> list[str]:
    """Striche, die ein Nicht-Besitzer per REST noch aendern darf (nicht vom Blatt-Admin)."""
    row = _conn.execute("SELECT owner_id FROM boards WHERE id = ?", (board_id,)).fetchone()
    if not row or not person_id or row[0] == person_id:
        return list(ids)
    owner_id = row[0]
    authored = _stroke_owners_sync(ids)
    return [i for i in ids if authored.get(i) != owner_id]


async def filter_owner_protected(board_id: str, person_id: str, ids: list[str]) -> list[str]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _filter_owner_protected_sync, board_id, person_id, ids)


SHARE_ROLES = ("edit", "add", "view")


def _role_sync(person_id: str, board_id: str) -> str | None:
    """owner / edit / add / view - oder None ohne Zugriff."""
    row = _conn.execute("SELECT owner_id FROM boards WHERE id = ?", (board_id,)).fetchone()
    if not row:
        return None
    if row[0] == person_id:
        return "owner"
    r = _conn.execute("SELECT role FROM shares WHERE board_id = ? AND person_id = ?", (board_id, person_id)).fetchone()
    if not r:
        return None
    return r[0] if r[0] in SHARE_ROLES else "edit"


async def board_role(person_id: str, board_id: str) -> str | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _role_sync, person_id, board_id)


def _delete_sync(stroke_ids: list[str], person_id: str | None = None) -> None:
    if not stroke_ids:
        return
    if person_id:
        for sid in stroke_ids:
            bid, before = _stroke_json_sync(sid)
            if before:
                _log_sync(bid, sid, person_id, before, None)
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


def _insert_many_sync(board_id: str, strokes: list[dict[str, Any]]) -> None:
    base = time.time()
    _conn.executemany(
        "INSERT OR REPLACE INTO strokes (id, tool, color, size, points, extra, created_at, board_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                s["id"], s["tool"], s["color"], s["size"], json.dumps(s["points"]),
                json.dumps(s["extra"]) if s.get("extra") is not None else None,
                base + i * 1e-6, board_id,
            )
            for i, s in enumerate(strokes)
        ],
    )
    _conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (time.time(), board_id))
    _conn.commit()


async def insert_strokes(board_id: str, strokes: list[dict[str, Any]]) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _insert_many_sync, board_id, strokes)


async def insert_stroke(stroke: dict[str, Any], person_id: str | None = None) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _insert_sync, stroke, person_id)


async def delete_strokes(stroke_ids: list[str], person_id: str | None = None) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _delete_sync, stroke_ids, person_id)


# ---- Versionsverlauf ----------------------------------------------------
HISTORY_GAP = 600  # Pause, ab der ein neuer Abschnitt beginnt (Sekunden)
HISTORY_SPAN = 3600  # ein Abschnitt umfasst hoechstens so lange


def _history_groups_sync(board_id: str) -> dict[str, Any]:
    rows = _conn.execute(
        "SELECT id, person_id, at, before IS NULL, after IS NULL FROM stroke_log WHERE board_id = ? ORDER BY id",
        (board_id,),
    ).fetchall()
    groups: list[dict[str, Any]] = []
    for lid, pid, at, was_new, gone in rows:
        g = groups[-1] if groups else None
        if not g or g["person"] != pid or at - g["end"] > HISTORY_GAP or at - g["start"] > HISTORY_SPAN:
            g = {"fromId": lid, "toId": lid, "person": pid, "start": at, "end": at, "added": 0, "removed": 0, "changed": 0}
            groups.append(g)
        g["toId"] = lid
        g["end"] = at
        if was_new:
            g["added"] += 1
        elif gone:
            g["removed"] += 1
        else:
            g["changed"] += 1
    groups.reverse()
    return {"groups": groups[:400], "total": len(groups)}


def _state_at_sync(board_id: str, upto: int) -> dict[str, dict[str, Any]]:
    state = {s["id"]: s for s in _load_all_sync(board_id)}
    rows = _conn.execute(
        "SELECT stroke_id, before FROM stroke_log WHERE board_id = ? AND id > ? ORDER BY id DESC",
        (board_id, upto),
    ).fetchall()
    for sid, before in rows:
        if before:
            state[sid] = json.loads(before)
        else:
            state.pop(sid, None)
    return state


def _history_view_sync(board_id: str, from_id: int, upto: int) -> dict[str, Any]:
    state = _state_at_sync(board_id, upto)
    rows = _conn.execute(
        "SELECT stroke_id, before, after FROM stroke_log WHERE board_id = ? AND id >= ? AND id <= ? ORDER BY id",
        (board_id, from_id, upto),
    ).fetchall()
    first: dict[str, str | None] = {}
    last: dict[str, str | None] = {}
    for sid, before, after in rows:
        first.setdefault(sid, before)
        last[sid] = after
    added, changed, removed = [], [], []
    for sid, before in first.items():
        after = last[sid]
        if after is None and before is not None:
            removed.append(json.loads(before))
        elif after is not None and before is None:
            added.append(sid)
        elif after is not None:
            changed.append(sid)
    return {"strokes": list(state.values()), "added": added, "changed": changed, "removed": removed}


def _authors_sync(board_id: str) -> dict[str, Any]:
    rows = _conn.execute(
        """SELECT l.stroke_id, l.person_id, l.at FROM stroke_log l
           JOIN (SELECT stroke_id, MAX(id) AS mid FROM stroke_log WHERE board_id = ? GROUP BY stroke_id) m
             ON l.id = m.mid
           WHERE l.after IS NOT NULL""",
        (board_id,),
    ).fetchall()
    return {sid: {"person": pid, "at": at} for sid, pid, at in rows}


def _restore_sync(board_id: str, upto: int, person_id: str) -> dict[str, int]:
    target = _state_at_sync(board_id, upto)
    current = {s["id"]: s for s in _load_all_sync(board_id)}
    gone = [sid for sid in current if sid not in target]
    if gone:
        _delete_sync(gone, person_id)
    changed = 0
    for sid, stroke in target.items():
        if current.get(sid) == stroke:
            continue
        item = dict(stroke)
        item["board_id"] = board_id
        _insert_sync(item, person_id)
        changed += 1
    _conn.commit()
    return {"removed": len(gone), "restored": changed}


async def history_groups(board_id: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _history_groups_sync, board_id)


async def history_view(board_id: str, from_id: int, upto: int) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _history_view_sync, board_id, from_id, upto)


async def stroke_authors(board_id: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _authors_sync, board_id)


async def restore_version(board_id: str, upto: int, person_id: str) -> dict[str, int]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _restore_sync, board_id, upto, person_id)


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
        "SELECT id, owner_id, title, created_at, updated_at, sofia_homework_id, solution_share, sofia_solution_id, solution_synced_at, solution_error, paper, refs, notebook FROM boards WHERE id = ?",
        (board_id,),
    ).fetchone()
    if not row:
        return None
    share_rows = _conn.execute("SELECT person_id, role FROM shares WHERE board_id = ?", (row[0],)).fetchall()
    shared_with = [r[0] for r in share_rows]
    return {
        "id": row[0],
        "ownerId": row[1],
        "title": row[2],
        "createdAt": row[3],
        "updatedAt": row[4],
        "sharedWith": shared_with,
        "shareRoles": {r[0]: (r[1] if r[1] in SHARE_ROLES else "edit") for r in share_rows},
        "sofiaHomeworkId": row[5],
        "solutionShare": bool(row[6]),
        "sofiaSolutionId": row[7],
        "solutionSyncedAt": row[8],
        "solutionError": row[9],
        "paper": row[10] or "graph",
        "refs": _load_refs(row[11]),
        "notebook": _load_notebook(row[12]),
    }


def _load_notebook(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        nb = json.loads(raw)
    except ValueError:
        return None
    return nb if isinstance(nb, dict) else None


def clean_notebook(nb: Any) -> dict[str, Any] | None:
    """Notizbuch-Daten pruefen: Anordnung, Vorlage fuer neue Seiten, Seitenliste."""
    if not isinstance(nb, dict):
        return None

    def page_bg(d: Any) -> dict[str, Any]:
        d = d if isinstance(d, dict) else {}
        out: dict[str, Any] = {"paper": d.get("paper") if d.get("paper") in PAPERS else "graph"}
        if d.get("mediaId"):
            out["mediaId"] = str(d["mediaId"])[:80]
        return out

    pages = []
    for pg in (nb.get("pages") or [])[:2000]:
        if not isinstance(pg, dict) or not pg.get("id"):
            continue
        item = {"id": str(pg["id"])[:60], **page_bg(pg)}
        try:
            w = float(pg.get("w") or 794)
            h = float(pg.get("h") or 1123)
        except (TypeError, ValueError):
            w, h = 794.0, 1123.0
        item["w"] = max(200.0, min(4000.0, w))
        item["h"] = max(200.0, min(4000.0, h))
        try:
            rot = int(pg.get("rot") or 0) % 4
        except (TypeError, ValueError):
            rot = 0
        if rot:
            item["rot"] = rot
        if pg.get("read"):
            item["read"] = True
        if pg.get("board"):
            item["board"] = True
        pages.append(item)
    page_ids = {p["id"] for p in pages}
    bookmarks = []
    for raw in (nb.get("bookmarks") or [])[:200]:
        if not isinstance(raw, dict):
            continue
        pid = str(raw.get("pageId") or "")[:60]
        name = str(raw.get("name") or "").strip()[:80]
        bid = str(raw.get("id") or "")[:60]
        if not pid or pid not in page_ids or not name:
            continue
        bookmarks.append({"id": bid or pid, "pageId": pid, "name": name})
    return {
        "layout": "horizontal" if nb.get("layout") == "horizontal" else "vertical",
        "template": page_bg(nb.get("template")),
        "pages": pages,
        "bookmarks": bookmarks,
    }


def _set_board_notebook_sync(board_id: str, nb: dict[str, Any] | None) -> bool:
    cur = _conn.execute("UPDATE boards SET notebook = ?, updated_at = ? WHERE id = ?", (json.dumps(nb) if nb else None, time.time(), board_id))
    _conn.commit()
    return cur.rowcount > 0


async def set_board_notebook(board_id: str, nb: dict[str, Any] | None) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _set_board_notebook_sync, board_id, nb)


def _load_refs(raw: str | None) -> list[dict[str, Any]]:
    try:
        refs = json.loads(raw) if raw else []
    except ValueError:
        return []
    return refs if isinstance(refs, list) else []


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
        SELECT id, parent_id, name, sort_order, color, starred, sofia_subject_id, paper FROM folders
        WHERE person_id = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
        ORDER BY starred DESC, sort_order ASC, name COLLATE NOCASE ASC
        """,
        (person_id, folder_id, folder_id),
    )
    for row in cur.fetchall():
        folders.append(
            {
                "id": row[0],
                "parentId": row[1],
                "name": row[2],
                "sortOrder": row[3],
                "color": row[4] or DEFAULT_FOLDER_COLOR,
                "starred": bool(row[5]),
                "sofiaSubjectId": row[6],
                "paper": row[7],
            }
        )
    boards = []
    cur = _conn.execute(
        """
        SELECT b.id, b.owner_id, b.title, b.created_at, b.updated_at, p.folder_id, p.sort_order, p.starred, b.notebook IS NOT NULL
        FROM placements p
        JOIN boards b ON b.id = p.board_id
        WHERE p.person_id = ? AND ((p.folder_id IS NULL AND ? IS NULL) OR p.folder_id = ?)
        ORDER BY p.starred DESC, p.sort_order ASC, b.updated_at DESC
        """,
        (person_id, folder_id, folder_id),
    )
    for row in cur.fetchall():
        share_rows = _conn.execute("SELECT person_id, role FROM shares WHERE board_id = ?", (row[0],)).fetchall()
        shared_with = [r[0] for r in share_rows]
        boards.append(
            {
                "id": row[0],
                "ownerId": row[1],
                "title": row[2],
                "createdAt": row[3],
                "updatedAt": row[4],
                "folderId": row[5],
                "sortOrder": row[6],
                "starred": bool(row[7]),
                "shared": row[1] != person_id,
                "sharedWith": shared_with,
                "shareRoles": {r[0]: (r[1] if r[1] in SHARE_ROLES else "edit") for r in share_rows},
                "notebook": bool(row[8]),
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


PAPERS = ("graph", "dots", "lines", "blank")


def _paper_for_new_board(person_id: str, folder_id: str | None) -> str:
    """Papier eines neuen Blatts: vom Ordner (oder dem naechsten Ueberordner, der eins
    festgelegt hat), sonst der eigene Standard der Person, sonst kariert."""
    seen: set[str] = set()
    walk = folder_id
    while walk and walk not in seen:
        seen.add(walk)
        row = _conn.execute("SELECT parent_id, paper FROM folders WHERE id = ?", (walk,)).fetchone()
        if not row:
            break
        if row[1] in PAPERS:
            return row[1]
        walk = row[0]
    row = _conn.execute("SELECT default_paper FROM people WHERE id = ?", (person_id,)).fetchone()
    return row[0] if row and row[0] in PAPERS else "graph"


def _person_settings_sync(person_id: str) -> dict[str, Any]:
    row = _conn.execute("SELECT solution_mode, default_paper FROM people WHERE id = ?", (person_id,)).fetchone()
    if not row:
        return {"solutionMode": "auto", "defaultPaper": "graph"}
    return {"solutionMode": row[0] or "auto", "defaultPaper": row[1] if row[1] in PAPERS else "graph"}


def _set_person_settings_sync(person_id: str, solution_mode: str | None, default_paper: str | None) -> dict[str, Any]:
    if solution_mode in ("auto", "manual", "off"):
        _conn.execute("UPDATE people SET solution_mode = ? WHERE id = ?", (solution_mode, person_id))
    if default_paper in PAPERS:
        _conn.execute("UPDATE people SET default_paper = ? WHERE id = ?", (default_paper, person_id))
    _conn.commit()
    return _person_settings_sync(person_id)


def _set_folder_paper_sync(person_id: str, folder_id: str, paper: str | None) -> bool:
    if paper is not None and paper not in PAPERS:
        return False
    cur = _conn.execute("UPDATE folders SET paper = ? WHERE id = ? AND person_id = ?", (paper, folder_id, person_id))
    _conn.commit()
    return cur.rowcount > 0


def _set_board_paper_sync(board_id: str, paper: str) -> bool:
    if paper not in PAPERS:
        return False
    cur = _conn.execute("UPDATE boards SET paper = ? WHERE id = ?", (paper, board_id))
    _conn.commit()
    return cur.rowcount > 0


def _set_board_refs_sync(board_id: str, refs: list[dict[str, Any]]) -> bool:
    cur = _conn.execute("UPDATE boards SET refs = ? WHERE id = ?", (json.dumps(refs), board_id))
    _conn.commit()
    return cur.rowcount > 0


async def set_board_refs(board_id: str, refs: list[dict[str, Any]]) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _set_board_refs_sync, board_id, refs)


def _person_prefs_sync(person_id: str) -> dict[str, Any]:
    row = _conn.execute("SELECT prefs, prefs_at FROM people WHERE id = ?", (person_id,)).fetchone()
    prefs: dict[str, Any] = {}
    if row and row[0]:
        try:
            prefs = json.loads(row[0])
        except ValueError:
            prefs = {}
    return {"prefs": prefs if isinstance(prefs, dict) else {}, "updatedAt": (row[1] if row else None) or 0}


def _set_person_prefs_sync(person_id: str, prefs: dict[str, Any]) -> dict[str, Any]:
    now = time.time()
    _conn.execute("UPDATE people SET prefs = ?, prefs_at = ? WHERE id = ?", (json.dumps(prefs), now, person_id))
    _conn.commit()
    return {"prefs": prefs, "updatedAt": now}


async def person_prefs(person_id: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _person_prefs_sync, person_id)


async def set_person_prefs(person_id: str, prefs: dict[str, Any]) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _set_person_prefs_sync, person_id, prefs)


async def person_settings(person_id: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _person_settings_sync, person_id)


async def set_person_settings(person_id: str, solution_mode: str | None, default_paper: str | None) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _set_person_settings_sync, person_id, solution_mode, default_paper)


async def set_folder_paper(person_id: str, folder_id: str, paper: str | None) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _set_folder_paper_sync, person_id, folder_id, paper)


async def set_board_paper(board_id: str, paper: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _set_board_paper_sync, board_id, paper)


def _create_board_sync(person_id: str, title: str, folder_id: str | None, board_id: str | None = None) -> dict[str, Any]:
    now = time.time()
    board_id = board_id or str(uuid.uuid4())
    title = (title or "").strip() or "Unbenannte Skizze"
    existing = _board_row(board_id)
    if existing:
        return existing
    paper = _paper_for_new_board(person_id, folder_id)
    _conn.execute(
        "INSERT INTO boards (id, owner_id, title, created_at, updated_at, paper) VALUES (?, ?, ?, ?, ?, ?)",
        (board_id, person_id, title, now, now, paper),
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
    _conn.execute("DELETE FROM stroke_log WHERE board_id = ?", (board_id,))
    _conn.execute("DELETE FROM placements WHERE board_id = ?", (board_id,))
    _conn.execute("DELETE FROM shares WHERE board_id = ?", (board_id,))
    _conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))
    _conn.commit()
    return True


def _share_sync(person_id: str, board_id: str, with_person: str, role: str | None = None) -> dict[str, Any] | None:
    board = _board_row(board_id)
    if not board or board["ownerId"] != person_id:
        return None
    if with_person not in _person_ids_cache or with_person == person_id:
        return None
    role = role if role in SHARE_ROLES else None
    if role:
        _conn.execute(
            "INSERT INTO shares (board_id, person_id, role) VALUES (?, ?, ?) ON CONFLICT(board_id, person_id) DO UPDATE SET role = excluded.role",
            (board_id, with_person, role),
        )
    else:
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


def _star_board_sync(person_id: str, board_id: str, starred: bool) -> bool:
    if not _can_access_sync(person_id, board_id):
        return False
    cur = _conn.execute(
        "UPDATE placements SET starred = ? WHERE person_id = ? AND board_id = ?",
        (1 if starred else 0, person_id, board_id),
    )
    _conn.commit()
    return cur.rowcount > 0


def _star_folder_sync(person_id: str, folder_id: str, starred: bool) -> bool:
    cur = _conn.execute(
        "UPDATE folders SET starred = ? WHERE id = ? AND person_id = ?",
        (1 if starred else 0, folder_id, person_id),
    )
    _conn.commit()
    return cur.rowcount > 0


# Farben, die eine Person einmal zufaellig bekommt und dann fuer immer behaelt
PERSON_COLORS = [
    "#1a73e8", "#e8710a", "#188038", "#a142f4", "#d93025", "#12b5cb",
    "#e52592", "#f9ab00", "#3949ab", "#00897b", "#8d6e63", "#7cb342",
]


def _ensure_colors_sync() -> None:
    """Wer noch keine Farbe hat, bekommt zufaellig eine (moeglichst noch freie)."""
    rows = _conn.execute("SELECT id, color FROM people").fetchall()
    used = {r[1] for r in rows if r[1]}
    changed = False
    for pid, color in rows:
        if color:
            continue
        free = [c for c in PERSON_COLORS if c not in used] or PERSON_COLORS
        c = random.choice(free)
        used.add(c)
        _conn.execute("UPDATE people SET color = ? WHERE id = ?", (c, pid))
        changed = True
    if changed:
        _conn.commit()


def _person_color_sync(person_id: str) -> str | None:
    _ensure_colors_sync()
    row = _conn.execute("SELECT color FROM people WHERE id = ?", (person_id,)).fetchone()
    return row[0] if row else None


async def person_color(person_id: str) -> str | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _person_color_sync, person_id)


def _people_sync() -> list[dict[str, Any]]:
    _ensure_colors_sync()
    rows = _conn.execute(
        "SELECT id, name, is_admin, sofia_user_id, color FROM people WHERE active = 1 ORDER BY created_at ASC, rowid ASC"
    ).fetchall()
    return [{"id": r[0], "name": r[1], "isAdmin": bool(r[2]), "fromSofia": r[3] is not None, "color": r[4]} for r in rows]


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
        WHERE pe.email = ? AND p.active = 1
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


# ---- Abgleich mit Sofia ------------------------------------------------------
SOFIA_ADMIN_ROLES = {"super_admin", "admin"}


def _soft_color(hex_color: str | None) -> str:
    """Sofia-Fachfarben koennen kraeftig sein (#00ff00); Ordner-Kacheln brauchen eine
    helle Flaeche. Kraeftige Farben werden aufgehellt, Pastelltoene bleiben."""
    h = (hex_color or "").strip().lstrip("#")
    if len(h) != 6:
        return DEFAULT_FOLDER_COLOR
    try:
        r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return DEFAULT_FOLDER_COLOR
    lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    if lum >= 0.82:
        return "#" + h.lower()
    k = 0.72  # Richtung Weiss
    r, g, b = (round(c + (255 - c) * k) for c in (r, g, b))
    return f"#{r:02x}{g:02x}{b:02x}"


def _apply_sofia_sync(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Uebernimmt Personen (mit allen Mail-Adressen) und Faecher aus Sofia.

    - Jede Sofia-Person bekommt genau eine Person hier (gemerkt ueber sofia_user_id).
      Beim ersten Abgleich wird eine vorhandene Person ueber ihre Mail-Adresse
      zugeordnet, damit ihre Blaetter und Ordner erhalten bleiben.
    - Personen, die es in Sofia nicht (mehr) gibt, werden nur ausgeblendet
      (active = 0), nie geloescht - ihre Blaetter bleiben in der Datenbank.
    - Fuer jedes Fach, das die Person in Sofia sieht, gibt es oben einen Ordner
      (gemerkt ueber sofia_subject_id). Umbenennungen in Sofia ziehen nach, ein
      geloeschtes Fach laesst den Ordner samt Inhalt stehen.
    """
    users = snapshot.get("users") or []
    subjects = snapshot.get("subjects") or []
    now = time.time()
    linked: set[str] = set()
    created_people = 0
    created_folders = 0
    for u in users:
        uid = u.get("id")
        if uid is None:
            continue
        primary = str(u.get("email") or "").strip().lower()
        emails = [primary] + [str(a).strip().lower() for a in (u.get("aliases") or [])]
        emails = [e for i, e in enumerate(emails) if e and "@" in e and e not in emails[:i]]
        name = (u.get("display_name") or "").strip() or (primary.split("@")[0] if primary else "Person")
        row = _conn.execute("SELECT id FROM people WHERE sofia_user_id = ?", (uid,)).fetchone()
        pid = row[0] if row else None
        if pid is None and primary:
            # erste Zuordnung: vorhandene, noch freie Person mit der Hauptadresse uebernehmen
            row = _conn.execute(
                """SELECT p.id FROM person_emails pe JOIN people p ON p.id = pe.person_id
                   WHERE pe.email = ? AND p.sofia_user_id IS NULL""",
                (primary,),
            ).fetchone()
            pid = row[0] if row else None
        if pid is None:
            pid = str(uuid.uuid4())
            _conn.execute(
                "INSERT INTO people (id, name, is_admin, created_at, sofia_user_id, active, sofia_email) VALUES (?, ?, 0, ?, ?, 1, ?)",
                (pid, name, now, uid, primary),
            )
            created_people += 1
        is_admin = 1 if str(u.get("role") or "") in SOFIA_ADMIN_ROLES else None
        _conn.execute(
            "UPDATE people SET name = ?, sofia_user_id = ?, active = 1, sofia_email = ?, is_admin = COALESCE(?, is_admin) WHERE id = ?",
            (name, uid, primary, is_admin, pid),
        )
        for e in emails:
            _conn.execute("DELETE FROM person_emails WHERE email = ? AND person_id != ?", (e, pid))
            _conn.execute("INSERT OR IGNORE INTO person_emails (email, person_id) VALUES (?, ?)", (e, pid))
        if emails:
            marks = ",".join("?" for _ in emails)
            _conn.execute(f"DELETE FROM person_emails WHERE person_id = ? AND email NOT IN ({marks})", (pid, *emails))
        linked.add(pid)

        # Faecher -> Ordner
        cls = u.get("class_id")
        visible = [
            s
            for s in subjects
            if s.get("is_global") or s.get("class_id") is None or (cls is not None and s.get("class_id") == cls)
        ]
        for s in visible:
            sid = s.get("id")
            sname = str(s.get("name") or s.get("short_name") or "").strip()
            if sid is None or not sname:
                continue
            color = _soft_color(s.get("color"))
            row = _conn.execute(
                "SELECT id, name FROM folders WHERE person_id = ? AND sofia_subject_id = ?", (pid, sid)
            ).fetchone()
            if row:
                if row[1] != sname:
                    _conn.execute("UPDATE folders SET name = ? WHERE id = ?", (sname, row[0]))
                continue
            same = _conn.execute(
                """SELECT id FROM folders WHERE person_id = ? AND parent_id IS NULL
                   AND sofia_subject_id IS NULL AND lower(name) = lower(?)""",
                (pid, sname),
            ).fetchone()
            if same:
                _conn.execute("UPDATE folders SET sofia_subject_id = ? WHERE id = ?", (sid, same[0]))
                continue
            _conn.execute(
                """INSERT INTO folders (id, person_id, parent_id, name, sort_order, created_at, color, starred, sofia_subject_id)
                   VALUES (?, ?, NULL, ?, 0, ?, ?, 0, ?)""",
                (str(uuid.uuid4()), pid, sname, now, color, sid),
            )
            created_folders += 1
    if users:
        # nur ausblenden, wenn Sofia wirklich eine Liste geliefert hat
        marks = ",".join("?" for _ in linked) or "''"
        gone = [
            r[0]
            for r in _conn.execute(f"SELECT id FROM people WHERE active = 1 AND id NOT IN ({marks})", tuple(linked)).fetchall()
        ]
        for pid in gone:
            _conn.execute("UPDATE people SET active = 0 WHERE id = ?", (pid,))
            _conn.execute("DELETE FROM person_emails WHERE person_id = ?", (pid,))
    known = {s.get("id") for s in subjects if s.get("id") is not None}
    if subjects:
        for (fid, ssid) in _conn.execute("SELECT id, sofia_subject_id FROM folders WHERE sofia_subject_id IS NOT NULL").fetchall():
            if ssid not in known:
                _conn.execute("UPDATE folders SET sofia_subject_id = NULL WHERE id = ?", (fid,))
    _conn.commit()
    _refresh_person_cache_sync()
    return {"people": len(linked), "newPeople": created_people, "newFolders": created_folders}


def _sofia_person_sync(person_id: str) -> dict[str, Any] | None:
    row = _conn.execute(
        "SELECT sofia_user_id, sofia_email FROM people WHERE id = ?", (person_id,)
    ).fetchone()
    if not row or row[0] is None:
        return None
    folders = {
        r[0]: r[1]
        for r in _conn.execute(
            "SELECT sofia_subject_id, id FROM folders WHERE person_id = ? AND sofia_subject_id IS NOT NULL", (person_id,)
        ).fetchall()
    }
    return {"sofiaUserId": row[0], "email": row[1], "folders": folders}


def _homework_boards_sync(person_id: str) -> dict[int, str]:
    """Hausaufgabe -> Blatt dieser Person (eigenes Blatt, zuletzt bearbeitet zuerst)."""
    rows = _conn.execute(
        """SELECT b.sofia_homework_id, b.id FROM boards b
           JOIN placements p ON p.board_id = b.id AND p.person_id = ?
           WHERE b.owner_id = ? AND b.sofia_homework_id IS NOT NULL
           ORDER BY b.updated_at ASC""",
        (person_id, person_id),
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def _homework_board_sync(person_id: str, hw_id: int, title: str, folder_id: str | None) -> dict[str, Any]:
    """Blatt zur Hausaufgabe holen oder neu anlegen (im Fach-Ordner, falls vorhanden)."""
    existing = _homework_boards_sync(person_id).get(hw_id)
    if existing:
        return {"id": existing, "created": False}
    if folder_id and not _conn.execute(
        "SELECT 1 FROM folders WHERE id = ? AND person_id = ?", (folder_id, person_id)
    ).fetchone():
        folder_id = None
    board = _create_board_sync(person_id, title, folder_id)
    _conn.execute("UPDATE boards SET sofia_homework_id = ? WHERE id = ?", (hw_id, board["id"]))
    _conn.commit()
    return {"id": board["id"], "created": True}


def _link_homework_board_sync(person_id: str, hw_id: int, board_id: str) -> bool:
    """Vorhandenes eigenes Blatt als Blatt zu dieser Hausaufgabe festlegen."""
    if not _conn.execute("SELECT 1 FROM boards WHERE id = ? AND owner_id = ?", (board_id, person_id)).fetchone():
        return False
    _conn.execute(
        "UPDATE boards SET sofia_homework_id = NULL WHERE owner_id = ? AND sofia_homework_id = ? AND id != ?",
        (person_id, hw_id, board_id),
    )
    _conn.execute("UPDATE boards SET sofia_homework_id = ? WHERE id = ?", (hw_id, board_id))
    _conn.commit()
    return True


def _recent_boards_sync(person_id: str, limit: int) -> list[dict[str, Any]]:
    rows = _conn.execute(
        """SELECT b.id, b.title, b.updated_at, b.sofia_homework_id, f.name
           FROM boards b JOIN placements p ON p.board_id = b.id AND p.person_id = ?
           LEFT JOIN folders f ON f.id = p.folder_id
           WHERE b.owner_id = ? ORDER BY b.updated_at DESC LIMIT ?""",
        (person_id, person_id, limit),
    ).fetchall()
    return [{"id": r[0], "title": r[1], "updatedAt": r[2], "sofiaHomeworkId": r[3], "folder": r[4]} for r in rows]


def _solution_state_sync(board_id: str, **fields: Any) -> None:
    cols = {"share": "solution_share", "solutionId": "sofia_solution_id", "syncedAt": "solution_synced_at", "error": "solution_error"}
    sets = [f"{cols[k]} = ?" for k in fields]
    if not sets:
        return
    _conn.execute(f"UPDATE boards SET {', '.join(sets)} WHERE id = ?", (*fields.values(), board_id))
    _conn.commit()


def _owner_email_sync(board_id: str) -> str | None:
    row = _conn.execute(
        "SELECT p.sofia_email FROM boards b JOIN people p ON p.id = b.owner_id WHERE b.id = ?", (board_id,)
    ).fetchone()
    return row[0] if row else None


async def link_homework_board(person_id: str, hw_id: int, board_id: str) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _link_homework_board_sync, person_id, hw_id, board_id)


async def recent_boards(person_id: str, limit: int = 60) -> list[dict[str, Any]]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _recent_boards_sync, person_id, limit)


async def solution_state(board_id: str, **fields: Any) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, lambda: _solution_state_sync(board_id, **fields))


async def owner_email(board_id: str) -> str | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _owner_email_sync, board_id)


async def homework_boards(person_id: str) -> dict[int, str]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _homework_boards_sync, person_id)


async def homework_board(person_id: str, hw_id: int, title: str, folder_id: str | None) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _homework_board_sync, person_id, hw_id, title, folder_id)


async def apply_sofia_sync(snapshot: dict[str, Any]) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _apply_sofia_sync, snapshot)


async def sofia_person(person_id: str) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _sofia_person_sync, person_id)


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


async def share_board(person_id: str, board_id: str, with_person: str, role: str | None = None) -> dict[str, Any] | None:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _share_sync, person_id, board_id, with_person, role)


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


async def star_board(person_id: str, board_id: str, starred: bool) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _star_board_sync, person_id, board_id, starred)


async def star_folder(person_id: str, folder_id: str, starred: bool) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _star_folder_sync, person_id, folder_id, starred)



# ---- Eingang -------------------------------------------------------------
def _inbox_add_sync(to_person: str, from_person: str, kind: str, title: str, board_id: str | None, file_id: str | None) -> None:
    _conn.execute(
        "INSERT INTO inbox (to_person, from_person, kind, title, board_id, file_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (to_person, from_person, kind, title, board_id, file_id, time.time()),
    )
    _conn.commit()


def _inbox_list_sync(person_id: str) -> dict[str, Any]:
    rows = _conn.execute(
        "SELECT id, from_person, kind, title, board_id, file_id, at, seen FROM inbox WHERE to_person = ? ORDER BY id DESC LIMIT 100",
        (person_id,),
    ).fetchall()
    items = [
        {"id": r[0], "from": r[1], "kind": r[2], "title": r[3], "boardId": r[4], "fileId": r[5], "at": r[6], "seen": bool(r[7])}
        for r in rows
    ]
    return {"items": items, "unseen": sum(1 for i in items if not i["seen"])}


def _inbox_seen_sync(person_id: str) -> None:
    _conn.execute("UPDATE inbox SET seen = 1 WHERE to_person = ?", (person_id,))
    _conn.commit()


def _inbox_remove_sync(person_id: str, item_id: int) -> bool:
    cur = _conn.execute("DELETE FROM inbox WHERE id = ? AND to_person = ?", (item_id, person_id))
    _conn.commit()
    return cur.rowcount > 0


async def inbox_add(to_person: str, from_person: str, kind: str, title: str, board_id: str | None = None, file_id: str | None = None) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _inbox_add_sync, to_person, from_person, kind, title, board_id, file_id)


async def inbox_list(person_id: str) -> dict[str, Any]:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _inbox_list_sync, person_id)


async def inbox_seen(person_id: str) -> None:
    async with _lock:
        await asyncio.get_event_loop().run_in_executor(None, _inbox_seen_sync, person_id)


async def inbox_remove(person_id: str, item_id: int) -> bool:
    async with _lock:
        return await asyncio.get_event_loop().run_in_executor(None, _inbox_remove_sync, person_id, item_id)
