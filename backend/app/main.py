from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from . import db
from .ws_manager import ConnectionManager

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"

app = FastAPI(title="sofianotes")
manager = ConnectionManager()


@app.on_event("startup")
async def on_startup() -> None:
    await db.init()


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


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
                    await manager.broadcast(
                        {"type": "erase", "id": client.id, "strokeIds": stroke_ids},
                        exclude=websocket,
                    )

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
        await manager.broadcast({"type": "presence_leave", "id": client.id})


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
