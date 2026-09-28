import os
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from . import db
from .auth import get_current_user, get_current_user_ws, require_admin
from .ws_manager import ConnectionManager

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip()

app = FastAPI(title="sofianotes")
manager = ConnectionManager()


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    """Erzwingt Revalidierung bei jedem Laden, damit ein neuer Deploy nicht
    durch den Cloudflare-Edge-Cache oder den Browser-Cache verdeckt wird
    (App-Code aendert sich bei jedem Push, ein alter Stand waere ein Bug)."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path == "/" or not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app.add_middleware(NoCacheStaticMiddleware)


@app.on_event("startup")
async def on_startup() -> None:
    await db.init()
    if ADMIN_EMAIL:
        await db.ensure_admin(ADMIN_EMAIL)


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


# ---- Nutzer / eigene Person ------------------------------------------------


@app.get("/api/me")
async def me(user: dict = Depends(get_current_user)) -> dict:
    return user


# ---- Boards (immer nur die des eingeloggten Nutzers) -----------------------


class BoardCreate(BaseModel):
    name: str


class BoardRename(BaseModel):
    name: str


@app.get("/api/boards")
async def list_boards(user: dict = Depends(get_current_user)) -> list[dict]:
    return await db.list_boards(user["id"])


@app.post("/api/boards")
async def create_board(payload: BoardCreate, user: dict = Depends(get_current_user)) -> dict:
    name = payload.name.strip() or "Neues Board"
    return await db.create_board(user["id"], name)


async def _owned_board(board_id: str, user: dict) -> dict:
    board = await db.get_board(board_id)
    if board is None or board["user_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="Board nicht gefunden.")
    return board


@app.patch("/api/boards/{board_id}")
async def rename_board(board_id: str, payload: BoardRename, user: dict = Depends(get_current_user)) -> dict:
    await _owned_board(board_id, user)
    name = payload.name.strip() or "Board"
    await db.rename_board(board_id, name)
    return {"id": board_id, "name": name}


@app.delete("/api/boards/{board_id}")
async def delete_board(board_id: str, user: dict = Depends(get_current_user)) -> dict:
    await _owned_board(board_id, user)
    await db.delete_board(board_id)
    return {"ok": True}


# ---- Admin: Nutzer + zugeordnete Mail-Adressen verwalten -------------------


class UserCreate(BaseModel):
    name: str


class EmailAdd(BaseModel):
    email: str


@app.get("/api/admin/users")
async def admin_list_users(_: dict = Depends(require_admin)) -> list[dict]:
    return await db.list_users()


@app.post("/api/admin/users")
async def admin_create_user(payload: UserCreate, _: dict = Depends(require_admin)) -> dict:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name fehlt.")
    return await db.create_user(name)


@app.delete("/api/admin/users/{user_id}")
async def admin_delete_user(user_id: str, admin: dict = Depends(require_admin)) -> dict:
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Der eigene Admin-Account kann nicht geloescht werden.")
    await db.delete_user(user_id)
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/emails")
async def admin_add_email(user_id: str, payload: EmailAdd, _: dict = Depends(require_admin)) -> dict:
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Ungueltige Mail-Adresse.")
    added = await db.add_email(user_id, email)
    if not added:
        raise HTTPException(status_code=409, detail="Diese Mail-Adresse ist bereits einem Nutzer zugeordnet.")
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}/emails/{email}")
async def admin_remove_email(user_id: str, email: str, _: dict = Depends(require_admin)) -> dict:
    await db.remove_email(user_id, email)
    return {"ok": True}


# ---- WebSocket: Live-Zeichnen pro Board ------------------------------------


@app.websocket("/ws/{board_id}")
async def websocket_endpoint(websocket: WebSocket, board_id: str) -> None:
    user = await get_current_user_ws(websocket)
    if user is None:
        await websocket.close(code=4401)
        return
    board = await db.get_board(board_id)
    if board is None or board["user_id"] != user["id"]:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    client = manager.connect(websocket, board_id)

    strokes = await db.load_all(board_id)
    await websocket.send_json(
        {"type": "init", "clientId": client.id, "color": client.color, "strokes": strokes}
    )
    await manager.broadcast(
        board_id, {"type": "presence_join", "id": client.id, "color": client.color}, exclude=websocket
    )

    try:
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")

            if msg_type == "cursor":
                await manager.broadcast(
                    board_id,
                    {
                        "type": "cursor",
                        "id": client.id,
                        "color": client.color,
                        "x": msg.get("x"),
                        "y": msg.get("y"),
                        "tool": msg.get("tool"),
                        "size": msg.get("size"),
                    },
                    exclude=websocket,
                )

            elif msg_type == "stroke_start":
                stroke_id = msg.get("strokeId")
                if not stroke_id:
                    continue
                client.in_progress[stroke_id] = {
                    "id": stroke_id,
                    "tool": msg.get("tool", "pen"),
                    "color": msg.get("color", "#000000"),
                    "size": msg.get("size", 4),
                    "points": list(msg.get("points", [])),
                }
                await manager.broadcast(
                    board_id,
                    {
                        "type": "stroke_start",
                        "id": client.id,
                        "strokeId": stroke_id,
                        "tool": client.in_progress[stroke_id]["tool"],
                        "color": client.in_progress[stroke_id]["color"],
                        "size": client.in_progress[stroke_id]["size"],
                        "points": client.in_progress[stroke_id]["points"],
                    },
                    exclude=websocket,
                )

            elif msg_type == "stroke_points":
                stroke_id = msg.get("strokeId")
                entry = client.in_progress.get(stroke_id)
                new_points = msg.get("points", [])
                if entry is not None:
                    entry["points"].extend(new_points)
                await manager.broadcast(
                    board_id,
                    {
                        "type": "stroke_points",
                        "id": client.id,
                        "strokeId": stroke_id,
                        "points": new_points,
                    },
                    exclude=websocket,
                )

            elif msg_type == "stroke_end":
                stroke_id = msg.get("strokeId")
                entry = client.in_progress.pop(stroke_id, None)
                if entry is not None and len(entry["points"]) >= 1:
                    await db.insert_stroke(board_id, entry)
                await manager.broadcast(
                    board_id, {"type": "stroke_end", "id": client.id, "strokeId": stroke_id}, exclude=websocket
                )

            elif msg_type == "stroke_replace":
                stroke_id = msg.get("strokeId")
                entry = client.in_progress.get(stroke_id)
                new_points = msg.get("points", [])
                if entry is not None:
                    entry["points"] = new_points
                await manager.broadcast(
                    board_id,
                    {
                        "type": "stroke_replace",
                        "id": client.id,
                        "strokeId": stroke_id,
                        "points": new_points,
                    },
                    exclude=websocket,
                )

            elif msg_type == "stroke_move":
                stroke = msg.get("stroke")
                if stroke and stroke.get("id"):
                    await db.insert_stroke(board_id, stroke)
                    await manager.broadcast(
                        board_id, {"type": "stroke_move", "id": client.id, "stroke": stroke}, exclude=websocket
                    )

            elif msg_type == "stroke_abort":
                stroke_id = msg.get("strokeId")
                client.in_progress.pop(stroke_id, None)
                await manager.broadcast(
                    board_id, {"type": "stroke_abort", "id": client.id, "strokeId": stroke_id}, exclude=websocket
                )

            elif msg_type == "erase":
                stroke_ids = [s for s in msg.get("strokeIds", []) if s]
                if stroke_ids:
                    await db.delete_strokes(board_id, stroke_ids)
                    await manager.broadcast(
                        board_id, {"type": "erase", "id": client.id, "strokeIds": stroke_ids}, exclude=websocket
                    )

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
        await manager.broadcast(board_id, {"type": "presence_leave", "id": client.id})


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
