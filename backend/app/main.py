from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from . import db, goodnotes_export
from .ws_manager import ConnectionManager

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"

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
    await goodnotes_export.schedule_write(db.load_all)


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/export.goodnotes")
async def download_goodnotes() -> FileResponse:
    goodnotes_export.write_exports(await db.load_all())
    return FileResponse(
        goodnotes_export.GOODNOTES_PATH,
        media_type="application/octet-stream",
        filename="sofianotes.goodnotes",
    )


@app.get("/api/export.pdf")
async def download_pdf() -> FileResponse:
    goodnotes_export.write_exports(await db.load_all())
    return FileResponse(
        goodnotes_export.PDF_PATH,
        media_type="application/pdf",
        filename="sofianotes.pdf",
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    client = manager.connect(websocket)

    strokes = await db.load_all()
    await websocket.send_json(
        {"type": "init", "clientId": client.id, "color": client.color, "strokes": strokes}
    )
    await manager.broadcast(
        {"type": "presence_join", "id": client.id, "color": client.color}, exclude=websocket
    )

    try:
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")
            persist_changed = False

            if msg_type == "cursor":
                await manager.broadcast(
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
                    await db.insert_stroke(entry)
                    persist_changed = True
                await manager.broadcast(
                    {"type": "stroke_end", "id": client.id, "strokeId": stroke_id},
                    exclude=websocket,
                )

            elif msg_type == "stroke_replace":
                stroke_id = msg.get("strokeId")
                entry = client.in_progress.get(stroke_id)
                new_points = msg.get("points", [])
                if entry is not None:
                    entry["points"] = new_points
                await manager.broadcast(
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
                    await db.insert_stroke(stroke)
                    persist_changed = True
                    await manager.broadcast(
                        {"type": "stroke_move", "id": client.id, "stroke": stroke},
                        exclude=websocket,
                    )

            elif msg_type == "stroke_abort":
                stroke_id = msg.get("strokeId")
                client.in_progress.pop(stroke_id, None)
                await manager.broadcast(
                    {"type": "stroke_abort", "id": client.id, "strokeId": stroke_id},
                    exclude=websocket,
                )

            elif msg_type == "erase":
                stroke_ids = [s for s in msg.get("strokeIds", []) if s]
                if stroke_ids:
                    await db.delete_strokes(stroke_ids)
                    persist_changed = True
                    await manager.broadcast(
                        {"type": "erase", "id": client.id, "strokeIds": stroke_ids},
                        exclude=websocket,
                    )

            if persist_changed:
                await goodnotes_export.schedule_write(db.load_all)

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
        await manager.broadcast({"type": "presence_leave", "id": client.id})


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
