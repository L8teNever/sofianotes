from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from . import cloudflare_ocr, db, goodnotes_export, media, spellcheck
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


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/recognize")
async def recognize_status() -> dict:
    budget = cloudflare_ocr.DAILY_NEURON_BUDGET
    snap = await db.ocr_snapshot()
    remaining = max(0.0, budget - float(snap.get("used") or 0))
    return {
        "enabled": cloudflare_ocr.configured(),
        "model": cloudflare_ocr.model_name() if cloudflare_ocr.configured() else None,
        "dailyNeurons": budget,
        "usedNeurons": round(float(snap.get("used") or 0), 1),
        "remainingNeurons": round(remaining, 1),
        "calls": int(snap.get("calls") or 0),
    }


@app.post("/api/recognize")
async def recognize_ink(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="json required") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="json object required")
    if not cloudflare_ocr.configured():
        return {"ok": False, "error": "not_configured"}
    budget = cloudflare_ocr.DAILY_NEURON_BUDGET
    estimate = cloudflare_ocr.DEFAULT_CALL_NEURONS
    reserved = await db.ocr_reserve(estimate, budget)
    if reserved is None:
        snap = await db.ocr_snapshot()
        return {
            "ok": False,
            "error": "quota",
            "remainingNeurons": 0,
            "usedNeurons": round(float(snap.get("used") or 0), 1),
            "dailyNeurons": budget,
        }
    image = body.get("image") or ""
    prefer = body.get("preferDigits", True)
    result = await cloudflare_ocr.transcribe(image, prefer_digits=bool(prefer))
    if result.get("error") == "bad_image":
        await db.ocr_adjust(-estimate)
        raise HTTPException(status_code=400, detail="image data URI required")
    if result.get("error") == "too_large":
        await db.ocr_adjust(-estimate)
        raise HTTPException(status_code=413, detail="image too large")
    err = str(result.get("error") or "")
    if err in ("http_429", "http_402") or result.get("error") == "quota":
        await db.ocr_fill(budget)
        result = {**result, "error": "quota", "remainingNeurons": 0, "dailyNeurons": budget}
        return result
    actual = float(result.get("neurons") or estimate)
    if abs(actual - estimate) > 0.5:
        await db.ocr_adjust(actual - estimate)
    snap = await db.ocr_snapshot()
    result["usedNeurons"] = round(float(snap.get("used") or 0), 1)
    result["remainingNeurons"] = round(max(0.0, budget - float(snap.get("used") or 0)), 1)
    result["dailyNeurons"] = budget
    return result


@app.post("/api/spell")
async def spell_ink(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="json required") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="json object required")
    text = str(body.get("text") or "")
    return {
        "ok": True,
        "misspelled": spellcheck.misspelled(text),
        "suggestions": spellcheck.suggestions(text),
    }


@app.get("/api/people")
async def list_people() -> dict:
    return {"people": await db.people()}


@app.get("/api/library")
async def get_library(person: str, folder: str | None = None) -> dict:
    data = await db.library(person, folder or None)
    if data is None:
        raise HTTPException(status_code=400, detail="unknown person")
    return data


@app.post("/api/boards")
async def create_board(request: Request) -> dict:
    body = await _json_body(request)
    person = str(body.get("personId") or "")
    title = str(body.get("title") or "Unbenannte Skizze")
    folder = body.get("folderId") or None
    board = await db.create_board(person, title, folder)
    if board is None:
        raise HTTPException(status_code=400, detail="unknown person")
    return {"ok": True, "board": board}


@app.patch("/api/boards/{board_id}")
async def patch_board(board_id: str, request: Request) -> dict:
    body = await _json_body(request)
    person = str(body.get("personId") or "")
    title = str(body.get("title") or "")
    board = await db.rename_board(person, board_id, title)
    if board is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True, "board": board}


@app.delete("/api/boards/{board_id}")
async def remove_board(board_id: str, person: str) -> dict:
    ok = await db.delete_board(person, board_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.post("/api/boards/{board_id}/share")
async def share_board(board_id: str, request: Request) -> dict:
    body = await _json_body(request)
    person = str(body.get("personId") or "")
    with_person = str(body.get("withPersonId") or "")
    board = await db.share_board(person, board_id, with_person)
    if board is None:
        raise HTTPException(status_code=400, detail="cannot share")
    return {"ok": True, "board": board}


@app.delete("/api/boards/{board_id}/share/{with_person}")
async def unshare_board(board_id: str, with_person: str, person: str) -> dict:
    ok = await db.unshare_board(person, board_id, with_person)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.post("/api/folders")
async def create_folder(request: Request) -> dict:
    body = await _json_body(request)
    person = str(body.get("personId") or "")
    name = str(body.get("name") or "Ordner")
    parent = body.get("parentId") or None
    folder = await db.create_folder(person, name, parent)
    if folder is None:
        raise HTTPException(status_code=400, detail="unknown person")
    return {"ok": True, "folder": folder}


@app.patch("/api/folders/{folder_id}")
async def patch_folder(folder_id: str, request: Request) -> dict:
    body = await _json_body(request)
    person = str(body.get("personId") or "")
    if "parentId" in body:
        parent = body.get("parentId") or None
        ok = await db.move_folder(person, folder_id, parent)
        if not ok:
            raise HTTPException(status_code=400, detail="cannot move")
    if "name" in body:
        folder = await db.rename_folder(person, folder_id, str(body.get("name") or ""))
        if folder is None:
            raise HTTPException(status_code=404, detail="not found")
        return {"ok": True, "folder": folder}
    return {"ok": True}


@app.delete("/api/folders/{folder_id}")
async def remove_folder(folder_id: str, person: str) -> dict:
    ok = await db.delete_folder(person, folder_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.post("/api/placements")
async def place_board(request: Request) -> dict:
    body = await _json_body(request)
    person = str(body.get("personId") or "")
    board_id = str(body.get("boardId") or "")
    folder = body.get("folderId") or None
    ok = await db.place_board(person, board_id, folder)
    if not ok:
        raise HTTPException(status_code=400, detail="cannot move")
    return {"ok": True}


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="json required") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="json object required")
    return body


@app.post("/api/media")
async def upload_media(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="json required") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="json object required")
    data = body.get("image") or body.get("data") or ""
    try:
        saved = media.save_data_uri(str(data))
    except ValueError as exc:
        code = str(exc)
        if code == "too_large":
            raise HTTPException(status_code=413, detail="image too large") from exc
        raise HTTPException(status_code=400, detail="jpeg data URI required") from exc
    return {"ok": True, "id": saved["id"], "bytes": saved["bytes"]}


@app.get("/api/media/{media_id}")
async def get_media(media_id: str) -> Response:
    blob = media.load_bytes(media_id)
    if blob is None:
        raise HTTPException(status_code=404, detail="not found")
    return Response(
        content=blob,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.get("/api/export.goodnotes")
async def download_goodnotes(board: str) -> FileResponse:
    if not await db.get_board(board):
        raise HTTPException(status_code=404, detail="not found")
    goodnotes_export.write_exports(await db.load_all(board))
    return FileResponse(
        goodnotes_export.GOODNOTES_PATH,
        media_type="application/octet-stream",
        filename="sofianotes.goodnotes",
    )


@app.get("/api/export.pdf")
async def download_pdf(board: str) -> FileResponse:
    if not await db.get_board(board):
        raise HTTPException(status_code=404, detail="not found")
    goodnotes_export.write_exports(await db.load_all(board))
    return FileResponse(
        goodnotes_export.PDF_PATH,
        media_type="application/pdf",
        filename="sofianotes.pdf",
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    person = websocket.query_params.get("person") or ""
    board_id = websocket.query_params.get("board") or ""
    await websocket.accept()
    if not db.valid_person(person) or not await db.can_access(person, board_id):
        await websocket.close(code=4403)
        return
    client = manager.connect(websocket)
    client.person_id = person
    client.board_id = board_id

    strokes = await db.load_all(board_id)
    board = await db.get_board(board_id)
    await websocket.send_json(
        {
            "type": "init",
            "clientId": client.id,
            "color": client.color,
            "personId": person,
            "board": board,
            "strokes": strokes,
        }
    )
    await manager.broadcast(
        {"type": "presence_join", "id": client.id, "color": client.color},
        exclude=websocket,
        board_id=board_id,
    )

    try:
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")
            persist_changed = False
            room = client.board_id

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
                    board_id=room,
                )

            elif msg_type == "stroke_start":
                stroke_id = msg.get("strokeId")
                if not stroke_id:
                    continue
                entry = {
                    "id": stroke_id,
                    "tool": msg.get("tool", "pen"),
                    "color": msg.get("color", "#000000"),
                    "size": msg.get("size", 4),
                    "points": list(msg.get("points", [])),
                    "board_id": room,
                }
                if isinstance(msg.get("extra"), dict):
                    entry["extra"] = msg.get("extra")
                client.in_progress[stroke_id] = entry
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
                    board_id=room,
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
                    board_id=room,
                )

            elif msg_type == "stroke_end":
                stroke_id = msg.get("strokeId")
                entry = client.in_progress.pop(stroke_id, None)
                extra = msg.get("extra")
                if entry is not None and extra is not None:
                    entry["extra"] = extra
                if entry is not None and len(entry["points"]) >= 1:
                    entry["board_id"] = room
                    await db.insert_stroke(entry)
                    persist_changed = True
                await manager.broadcast(
                    {"type": "stroke_end", "id": client.id, "strokeId": stroke_id},
                    exclude=websocket,
                    board_id=room,
                )

            elif msg_type == "stroke_replace":
                stroke_id = msg.get("strokeId")
                entry = client.in_progress.get(stroke_id)
                new_points = msg.get("points", [])
                extra = msg.get("extra")
                if entry is not None:
                    entry["points"] = new_points
                    if extra is not None:
                        entry["extra"] = extra
                payload = {
                    "type": "stroke_replace",
                    "id": client.id,
                    "strokeId": stroke_id,
                    "points": new_points,
                }
                if extra is not None:
                    payload["extra"] = extra
                await manager.broadcast(payload, exclude=websocket, board_id=room)

            elif msg_type == "stroke_move":
                stroke = msg.get("stroke")
                if stroke and stroke.get("id"):
                    stroke["board_id"] = room
                    await db.insert_stroke(stroke)
                    persist_changed = True
                    await manager.broadcast(
                        {"type": "stroke_move", "id": client.id, "stroke": stroke},
                        exclude=websocket,
                        board_id=room,
                    )

            elif msg_type == "stroke_abort":
                stroke_id = msg.get("strokeId")
                client.in_progress.pop(stroke_id, None)
                await manager.broadcast(
                    {"type": "stroke_abort", "id": client.id, "strokeId": stroke_id},
                    exclude=websocket,
                    board_id=room,
                )

            elif msg_type == "erase":
                stroke_ids = [s for s in msg.get("strokeIds", []) if s]
                if stroke_ids:
                    await db.delete_strokes(stroke_ids)
                    persist_changed = True
                    await manager.broadcast(
                        {"type": "erase", "id": client.id, "strokeIds": stroke_ids},
                        exclude=websocket,
                        board_id=room,
                    )

            if persist_changed:
                bid = room
                await goodnotes_export.schedule_write(lambda: db.load_all(bid))

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
        await manager.broadcast({"type": "presence_leave", "id": client.id}, board_id=board_id)


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
