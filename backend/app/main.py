import asyncio
import json
import os
from pathlib import Path
import time

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware

from . import board_file, clientlog, cloudflare_ocr, db, files, goodnotes_export, media, shape_learning, sofia_sync, spellcheck
from .auth import get_current_person, get_current_person_ws, require_admin
from .version import get_version_info, inject_build
from .ws_manager import ConnectionManager, color_for

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"
BUILD_TS = str(int(time.time()))
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip()

app = FastAPI(title="sofianotes")
manager = ConnectionManager()


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    """Erzwingt Revalidierung bei jedem Laden, damit ein neuer Deploy nicht
    durch den Cloudflare-Edge-Cache oder den Browser-Cache verdeckt wird
    (App-Code aendert sich bei jedem Push, ein alter Stand waere ein Bug)."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path == "/service-worker.js":
            response.headers["Cache-Control"] = "no-store"
        elif request.query_params.get("v") and not request.url.path.startswith("/api/") and request.url.path not in ("/", "/index.html"):
            # versionierte Dateien (style.css?v=BUILD ...) aendern sich nie -> darf lange im Cache bleiben
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif request.url.path == "/" or not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app.add_middleware(NoCacheStaticMiddleware)
# Text komprimiert ausliefern (app.js ~500 KB -> ~120 KB)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.on_event("startup")
async def on_startup() -> None:
    await db.init()
    await shape_learning.init()
    if ADMIN_EMAIL:
        await db.ensure_admin(ADMIN_EMAIL)
    if sofia_sync.enabled():
        # Personen + Faecher laufend aus Sofia uebernehmen (internes Netz)
        import asyncio

        app.state.sofia_task = asyncio.create_task(sofia_sync.run_forever())


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/log")
async def client_log(request: Request, me: dict = Depends(get_current_person)) -> dict:
    """Fehlermeldung vom Geraet (wann, was, wo, welche Version, letzte Bedienschritte)."""
    body = await _json_body(request)
    ok = clientlog.add(me["id"], me.get("name") or me["id"], body if isinstance(body, dict) else {})
    return {"ok": ok}


@app.get("/api/admin/log")
async def admin_log(limit: int = 100, _: dict = Depends(require_admin)) -> dict:
    return {"entries": clientlog.recent(max(1, min(500, limit)))}


@app.get("/api/version")
async def app_version() -> dict:
    return get_version_info(BUILD_TS)


def _index_html() -> HTMLResponse:
    raw = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(inject_build(raw, BUILD_TS))


@app.get("/")
async def index_root() -> HTMLResponse:
    return _index_html()


@app.get("/index.html")
async def index_file() -> HTMLResponse:
    return _index_html()


@app.get("/service-worker.js")
async def service_worker() -> Response:
    raw = (FRONTEND_DIR / "service-worker.js").read_text(encoding="utf-8")
    return Response(
        content=inject_build(raw, BUILD_TS),
        media_type="application/javascript",
        headers={
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-store",
        },
    )


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


@app.get("/api/shape-params")
async def shape_params(_person: dict = Depends(get_current_person)) -> dict:
    return await shape_learning.snapshot()


@app.post("/api/shape-feedback")
async def shape_feedback(request: Request, _person: dict = Depends(get_current_person)) -> dict:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="JSON erwartet")
    result = await shape_learning.add(body if isinstance(body, dict) else {})
    if result is None:
        raise HTTPException(status_code=400, detail="Unbekannte Meldung")
    state, changed = result
    if changed:
        # neue Werte sofort an alle offenen Geraete (alle Blaetter)
        await manager.broadcast({"type": "shape_params", **state})
    return state


@app.get("/api/people")
async def list_people() -> dict:
    return {"people": await db.people()}


@app.get("/api/sofia/now")
async def sofia_now(person: dict = Depends(get_current_person)) -> dict:
    """Aktuelles/naechstes Fach laut Sofia-Stundenplan - fuer das Hervorheben des Ordners."""
    return await sofia_sync.current_lesson(person["id"])


@app.get("/api/sofia/status")
async def sofia_status(_: dict = Depends(get_current_person)) -> dict:
    return {"enabled": sofia_sync.enabled(), **sofia_sync.state}


@app.get("/api/sofia/homework")
async def sofia_homework(person: dict = Depends(get_current_person)) -> dict:
    return await sofia_sync.homework_list(person["id"])


@app.get("/api/sofia/homework/{hw_id}")
async def sofia_homework_one(hw_id: int, person: dict = Depends(get_current_person)) -> dict:
    hw = await sofia_sync.homework_get(person["id"], hw_id)
    if hw is None:
        raise HTTPException(status_code=404, detail="Hausaufgabe nicht gefunden")
    return hw


@app.post("/api/sofia/homework/{hw_id}/check")
async def sofia_homework_check(hw_id: int, person: dict = Depends(get_current_person)) -> dict:
    res = await sofia_sync.homework_toggle(person["id"], hw_id)
    if res is None:
        raise HTTPException(status_code=502, detail="Sofia nicht erreichbar")
    return res


@app.post("/api/sofia/homework/{hw_id}/board")
async def sofia_homework_board(hw_id: int, person: dict = Depends(get_current_person)) -> dict:
    """Blatt zur Hausaufgabe oeffnen (bzw. beim ersten Mal im Fach-Ordner anlegen)."""
    hw = await sofia_sync.homework_get(person["id"], hw_id)
    if hw is None:
        raise HTTPException(status_code=404, detail="Hausaufgabe nicht gefunden")
    text = " ".join(hw["description"].split())
    short = text[:40].rstrip() + ("…" if len(text) > 40 else "")
    title = (hw["subject"] + " – " if hw["subject"] else "") + (short or "Hausaufgabe")
    res = await db.homework_board(person["id"], hw_id, title, hw.get("folderId"))
    return {"ok": True, "boardId": res["id"], "created": res["created"], "title": title}


@app.get("/api/sofia/file")
async def sofia_file(u: str, _: dict = Depends(get_current_person)) -> Response:
    got = await sofia_sync.fetch_file(u)
    if got is None:
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")
    data, ctype = got
    return Response(content=data, media_type=ctype, headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/boards/recent")
async def boards_recent(person: dict = Depends(get_current_person)) -> dict:
    return {"boards": await db.recent_boards(person["id"])}


@app.post("/api/sofia/homework/{hw_id}/link")
async def sofia_homework_link(hw_id: int, request: Request, person: dict = Depends(get_current_person)) -> dict:
    """Vorhandenes eigenes Blatt dieser Hausaufgabe zuordnen."""
    body = await _json_body(request)
    board_id = str(body.get("boardId") or "")
    if not await db.link_homework_board(person["id"], hw_id, board_id):
        raise HTTPException(status_code=404, detail="Blatt nicht gefunden")
    board = await db.get_board(board_id)
    return {"ok": True, "boardId": board_id, "title": board["title"] if board else ""}


@app.get("/api/boards/{board_id}/solution")
async def board_solution(board_id: str, person: dict = Depends(get_current_person)) -> dict:
    board = await db.get_board(board_id)
    if not board or not await db.can_access(person["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    mode = (await db.person_settings(board["ownerId"]))["solutionMode"]
    return {
        "mode": mode,
        "solutionId": board.get("sofiaSolutionId"),
        "syncedAt": board.get("solutionSyncedAt"),
        "error": board.get("solutionError"),
        "pending": sofia_sync.solution_pending(board_id),
        "owner": board.get("ownerId") == person["id"],
    }


@app.post("/api/boards/{board_id}/solution")
async def board_solution_set(board_id: str, request: Request, person: dict = Depends(get_current_person)) -> dict:
    """upload=true laedt das Blatt jetzt als Loesung hoch (Modus 'Knopf' oder 'automatisch');
    remove=true nimmt die geteilte Loesung in Sofia wieder weg."""
    board = await db.get_board(board_id)
    if not board or board.get("ownerId") != person["id"] or not board.get("sofiaHomeworkId"):
        raise HTTPException(status_code=404, detail="not found")
    body = await _json_body(request)
    if body.get("remove"):
        await sofia_sync.remove_solution(board_id)
        return {"ok": True}
    if body.get("upload"):
        return await sofia_sync.upload_solution(board_id, manual=True)
    return {"ok": True}


@app.post("/api/sofia/sync")
async def sofia_sync_now(_: dict = Depends(require_admin)) -> dict:
    return await sofia_sync.sync_once(force=True)


def _people_from_sofia() -> None:
    if sofia_sync.enabled():
        raise HTTPException(status_code=409, detail="Personen kommen automatisch aus Sofia - dort aendern.")


@app.get("/api/me/prefs")
async def my_prefs(person: dict = Depends(get_current_person)) -> dict:
    """Geraete-Einstellungen (Stift, Farben, Leisten, Zoom ...) fuer alle Geraete des Kontos."""
    return await db.person_prefs(person["id"])


@app.put("/api/me/prefs")
async def set_my_prefs(request: Request, person: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    prefs = body.get("prefs")
    if not isinstance(prefs, dict) or len(json.dumps(prefs)) > 200_000:
        raise HTTPException(status_code=400, detail="bad prefs")
    prefs = {str(k)[:80]: v for k, v in prefs.items() if isinstance(v, str)}
    if body.get("merge"):
        # zusammenfuehren: Einstellungen anderer Geraete bleiben, nur ausdruecklich geloeschte fallen weg
        current = (await db.person_prefs(person["id"])).get("prefs") or {}
        merged = {**current, **prefs}
        for k in body.get("removed") or []:
            merged.pop(str(k), None)
        prefs = merged
    return await db.set_person_prefs(person["id"], prefs)


@app.get("/api/me/settings")
async def my_settings(person: dict = Depends(get_current_person)) -> dict:
    return await db.person_settings(person["id"])


@app.patch("/api/me/settings")
async def set_my_settings(request: Request, person: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    return await db.set_person_settings(person["id"], body.get("solutionMode"), body.get("defaultPaper"))


@app.get("/api/me")
async def me(person: dict = Depends(get_current_person)) -> dict:
    return person


class PersonCreate(BaseModel):
    name: str


class EmailAdd(BaseModel):
    email: str


@app.get("/api/admin/people")
async def admin_list_people(_: dict = Depends(require_admin)) -> list[dict]:
    return await db.people_admin()


@app.post("/api/admin/people")
async def admin_create_person(payload: PersonCreate, _: dict = Depends(require_admin)) -> dict:
    _people_from_sofia()
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name fehlt.")
    return await db.create_person(name)


@app.patch("/api/admin/people/{person_id}")
async def admin_rename_person(person_id: str, payload: PersonCreate, _: dict = Depends(require_admin)) -> dict:
    _people_from_sofia()
    ok = await db.rename_person(person_id, payload.name)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.delete("/api/admin/people/{person_id}")
async def admin_delete_person(person_id: str, admin: dict = Depends(require_admin)) -> dict:
    _people_from_sofia()
    if person_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Die eigene Person kann nicht geloescht werden.")
    err = await db.delete_person(person_id)
    if err == "not_found":
        raise HTTPException(status_code=404, detail="not found")
    if err == "owns_boards":
        raise HTTPException(status_code=409, detail="Diese Person besitzt noch Blaetter - erst loeschen/uebertragen.")
    return {"ok": True}


@app.post("/api/admin/people/{person_id}/emails")
async def admin_add_email(person_id: str, payload: EmailAdd, _: dict = Depends(require_admin)) -> dict:
    _people_from_sofia()
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Ungueltige Mail-Adresse.")
    added = await db.add_person_email(person_id, email)
    if not added:
        raise HTTPException(status_code=409, detail="Diese Mail-Adresse ist schon vergeben oder die Person existiert nicht.")
    return {"ok": True}


@app.delete("/api/admin/people/{person_id}/emails/{email}")
async def admin_remove_email(person_id: str, email: str, _: dict = Depends(require_admin)) -> dict:
    _people_from_sofia()
    await db.remove_person_email(person_id, email)
    return {"ok": True}


@app.get("/api/library")
async def get_library(folder: str | None = None, me: dict = Depends(get_current_person)) -> dict:
    data = await db.library(me["id"], folder or None)
    if data is None:
        raise HTTPException(status_code=400, detail="unknown person")
    return data


@app.post("/api/boards")
async def create_board(request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    title = str(body.get("title") or "Unbenannte Skizze")
    folder = body.get("folderId") or None
    board = await db.create_board(me["id"], title, folder, body.get("id") or None)
    if board is None:
        raise HTTPException(status_code=400, detail="unknown person")
    nb = db.clean_notebook(body.get("notebook")) if body.get("notebook") else None
    if nb and not board.get("notebook"):
        await db.set_board_notebook(board["id"], nb)
        board = await db.get_board(board["id"])
    return {"ok": True, "board": board}


@app.patch("/api/boards/{board_id}")
async def patch_board(board_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    role = await db.board_role(me["id"], board_id)
    if role == "view" or (role == "add" and ("refs" in body or "paper" in body)):
        raise HTTPException(status_code=403, detail="read only")
    if "notebook" in body:
        # Seiten des Notizbuchs (Anordnung, Vorlage, Hintergrund pro Seite)
        nb = db.clean_notebook(body.get("notebook"))
        if not nb or not await db.can_access(me["id"], board_id):
            raise HTTPException(status_code=400, detail="bad notebook")
        if role == "add":
            # nur dazuschreiben: Seiten anhaengen ja, vorhandene entfernen nein
            old = await db.get_board(board_id)
            old_ids = [pg.get("id") for pg in ((old or {}).get("notebook") or {}).get("pages", [])]
            new_ids = {pg.get("id") for pg in nb.get("pages", [])}
            if any(pid and pid not in new_ids for pid in old_ids):
                raise HTTPException(status_code=403, detail="read only")
        await db.set_board_notebook(board_id, nb)
        await manager.broadcast({"type": "board_notebook", "notebook": nb}, board_id=board_id)
        if "title" not in body and "paper" not in body and "refs" not in body:
            return {"ok": True, "notebook": nb}
    if "refs" in body:
        # eigene Bilder im Material-Fenster (Buchseite, Foto der Aufgabe ...)
        raw = body.get("refs")
        if not isinstance(raw, list) or not await db.can_access(me["id"], board_id):
            raise HTTPException(status_code=400, detail="bad refs")
        refs = []
        for r in raw[:80]:
            if not isinstance(r, dict):
                continue
            if r.get("mediaId"):
                refs.append({"mediaId": str(r["mediaId"])[:80], "name": str(r.get("name") or "Bild")[:160]})
            elif r.get("fileId") and files.valid_id(str(r["fileId"])):
                refs.append({"fileId": str(r["fileId"]), "name": files.clean_name(str(r.get("name") or "Datei")), "mime": str(r.get("mime") or "")[:120]})
        await db.set_board_refs(board_id, refs)
        await manager.broadcast({"type": "board_refs", "refs": refs}, board_id=board_id)
        if "title" not in body and "paper" not in body:
            return {"ok": True, "refs": refs}
    if "paper" in body:
        # Papier gilt fuers ganze Blatt, darf jede Person mit Zugriff aendern
        if not await db.can_access(me["id"], board_id) or not await db.set_board_paper(board_id, str(body.get("paper") or "")):
            raise HTTPException(status_code=400, detail="bad paper")
        await manager.broadcast({"type": "board_paper", "paper": body.get("paper")}, board_id=board_id)
        if "title" not in body:
            return {"ok": True, "board": await db.get_board(board_id)}
    title = str(body.get("title") or "")
    board = await db.rename_board(me["id"], board_id, title)
    if board is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True, "board": board}


@app.delete("/api/boards/{board_id}")
async def remove_board(board_id: str, me: dict = Depends(get_current_person)) -> dict:
    ok = await db.delete_board(me["id"], board_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.post("/api/boards/{board_id}/share")
async def share_board(board_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    with_person = str(body.get("withPersonId") or "")
    role = body.get("role")
    board = await db.share_board(me["id"], board_id, with_person, str(role) if role else None)
    if board is None:
        raise HTTPException(status_code=400, detail="cannot share")
    # offene Fenster der Person bekommen die neue Rolle sofort
    new_role = (board.get("shareRoles") or {}).get(with_person, "edit")
    for c in manager.clients_for(board_id, with_person):
        c.role = new_role
        try:
            await c.websocket.send_json({"type": "role", "role": new_role})
        except Exception:
            pass
    await manager.broadcast({"type": "board_shares", "sharedWith": board.get("sharedWith"), "shareRoles": board.get("shareRoles")}, board_id=board_id)
    return {"ok": True, "board": board}


@app.delete("/api/boards/{board_id}/share/{with_person}")
async def unshare_board(board_id: str, with_person: str, me: dict = Depends(get_current_person)) -> dict:
    ok = await db.unshare_board(me["id"], board_id, with_person)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    # Zugriff weg: offene Fenster der Person schliessen (zurueck in die Bibliothek)
    for c in manager.clients_for(board_id, with_person):
        try:
            await c.websocket.close(code=4403)
        except Exception:
            pass
    board = await db.get_board(board_id)
    if board:
        await manager.broadcast({"type": "board_shares", "sharedWith": board.get("sharedWith"), "shareRoles": board.get("shareRoles")}, board_id=board_id)
    return {"ok": True}


@app.get("/api/boards/{board_id}/presence")
async def board_presence(board_id: str, me: dict = Depends(get_current_person)) -> dict:
    """Wer das Blatt gerade offen hat."""
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    seen: list[str] = []
    for c in manager.clients_for(board_id):
        if c.person_id and c.person_id not in seen:
            seen.append(c.person_id)
    return {"people": seen}


@app.get("/api/folder-colors")
async def folder_colors() -> dict:
    return {"colors": list(db.FOLDER_COLORS)}


@app.post("/api/folders")
async def create_folder(request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    name = str(body.get("name") or "Ordner")
    parent = body.get("parentId") or None
    color = body.get("color") or None
    folder = await db.create_folder(me["id"], name, parent, body.get("id") or None, color)
    if folder is None:
        raise HTTPException(status_code=400, detail="unknown person")
    return {"ok": True, "folder": folder}


@app.patch("/api/folders/{folder_id}")
async def patch_folder(folder_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    if "parentId" in body:
        parent = body.get("parentId") or None
        ok = await db.move_folder(me["id"], folder_id, parent)
        if not ok:
            raise HTTPException(status_code=400, detail="cannot move")
    if "paper" in body:
        paper = body.get("paper") or None
        if not await db.set_folder_paper(me["id"], folder_id, paper):
            raise HTTPException(status_code=400, detail="bad paper")
    if "name" in body or "color" in body:
        name = str(body["name"]) if "name" in body else None
        folder = await db.rename_folder(me["id"], folder_id, name, body.get("color") or None)
        if folder is None:
            raise HTTPException(status_code=404, detail="not found")
        return {"ok": True, "folder": folder}
    return {"ok": True}


@app.delete("/api/folders/{folder_id}")
async def remove_folder(folder_id: str, me: dict = Depends(get_current_person)) -> dict:
    ok = await db.delete_folder(me["id"], folder_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.post("/api/placements")
async def place_board(request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    board_id = str(body.get("boardId") or "")
    folder = body.get("folderId") or None
    ok = await db.place_board(me["id"], board_id, folder)
    if not ok:
        raise HTTPException(status_code=400, detail="cannot move")
    return {"ok": True}


@app.post("/api/boards/{board_id}/star")
async def star_board(board_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    ok = await db.star_board(me["id"], board_id, bool(body.get("starred")))
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@app.post("/api/folders/{folder_id}/star")
async def star_folder(folder_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    ok = await db.star_folder(me["id"], folder_id, bool(body.get("starred")))
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
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
    want_id = body.get("id")
    try:
        saved = media.save_data_uri(str(data), str(want_id) if want_id else None)
    except ValueError as exc:
        code = str(exc)
        if code == "too_large":
            raise HTTPException(status_code=413, detail="image too large") from exc
        raise HTTPException(status_code=400, detail="jpeg data URI required") from exc
    return {"ok": True, "id": saved["id"], "bytes": saved["bytes"]}


@app.post("/api/files")
async def upload_file(request: Request, me: dict = Depends(get_current_person)) -> dict:
    """Datei fuers Material-Fenster (Body = Dateiinhalt, ?name=...)."""
    data = await request.body()
    try:
        meta = files.save(data, request.query_params.get("name") or "Datei", request.headers.get("content-type") or "", request.query_params.get("id") or None)
    except ValueError as exc:
        code = {"too_large": 413, "exists": 409}.get(str(exc), 400)
        raise HTTPException(status_code=code, detail=str(exc)) from exc
    return {"ok": True, **meta}


@app.get("/api/files/{file_id}")
async def get_file(file_id: str, me: dict = Depends(get_current_person)) -> Response:
    hit = files.load(file_id)
    if hit is None:
        raise HTTPException(status_code=404, detail="not found")
    blob, meta = hit
    from urllib.parse import quote

    return Response(
        content=blob,
        media_type=meta.get("mime") or "application/octet-stream",
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{quote(meta.get('name') or 'Datei')}",
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )


@app.put("/api/media/{media_id}")
async def upload_media_raw(media_id: str, request: Request) -> dict:
    """Bild als rohes JPEG (Body) - spart Base64 und JSON."""
    data = await request.body()
    try:
        saved = media.save_bytes(data, media_id)
    except ValueError as exc:
        code = 413 if str(exc) == "too_large" else 400
        raise HTTPException(status_code=code, detail=str(exc)) from exc
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


@app.get("/api/boards/{board_id}/history")
async def board_history(board_id: str, me: dict = Depends(get_current_person)) -> dict:
    """Versionsverlauf: Abschnitte (wer, wann, wie viel) - neueste zuerst."""
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    return await db.history_groups(board_id)


@app.get("/api/boards/{board_id}/history/view")
async def board_history_view(board_id: str, upto: int, start: int = 0, me: dict = Depends(get_current_person)) -> dict:
    """Stand des Blatts nach Eintrag `upto`, dazu was im Abschnitt start..upto geaendert wurde."""
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    return await db.history_view(board_id, start or upto, upto)


@app.get("/api/boards/{board_id}/authors")
async def board_authors(board_id: str, me: dict = Depends(get_current_person)) -> dict:
    """Wer hat welchen Strich zuletzt geaendert (fuer die farbige Markierung)."""
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    board = await db.get_board(board_id)
    return {"authors": await db.stroke_authors(board_id), "owner": board.get("ownerId") if board else None}


@app.post("/api/boards/{board_id}/history/restore")
async def board_history_restore(board_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    if await db.board_role(me["id"], board_id) not in ("owner", "edit"):
        raise HTTPException(status_code=403, detail="read only")
    body = await _json_body(request)
    try:
        upto = int(body.get("upto"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="upto required") from exc
    res = await db.restore_version(board_id, upto, me["id"])
    # alle offenen Fenster laden das Blatt neu
    await manager.broadcast({"type": "board_reload"}, board_id=board_id)
    return {"ok": True, **res}


@app.get("/api/boards/{board_id}/snapshot")
async def board_snapshot(board_id: str, me: dict = Depends(get_current_person)) -> dict:
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    board = await db.get_board(board_id)
    strokes = await db.load_all(board_id)
    return {"ok": True, "board": board, "strokes": strokes}


@app.post("/api/boards/{board_id}/strokes")
async def upsert_stroke(board_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    stroke = body.get("stroke")
    if not isinstance(stroke, dict) or not stroke.get("id"):
        raise HTTPException(status_code=400, detail="stroke required")
    role = await db.board_role(me["id"], board_id) or "edit"
    if not await _writable_ids(role, me["id"], [str(stroke["id"])]):
        raise HTTPException(status_code=403, detail="read only")
    allowed = await db.filter_owner_protected(board_id, me["id"], [str(stroke["id"])])
    if not allowed:
        return {"ok": True, "skipped": True}
    stroke["board_id"] = board_id
    await db.insert_stroke(stroke, me["id"])
    return {"ok": True}


@app.post("/api/boards/{board_id}/erase")
async def erase_board_strokes(board_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    body = await _json_body(request)
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    stroke_ids = [s for s in body.get("strokeIds", []) if s]
    role = await db.board_role(me["id"], board_id) or "edit"
    stroke_ids = await _writable_ids(role, me["id"], stroke_ids)
    stroke_ids = await db.filter_owner_protected(board_id, me["id"], stroke_ids)
    if stroke_ids:
        await db.delete_strokes(stroke_ids, me["id"])
    return {"ok": True}


@app.get("/api/boards/{board_id}/export.sofianotes")
async def export_board_file(board_id: str, me: dict = Depends(get_current_person)) -> Response:
    """Ganzes Blatt als .sofianotes-Datei (zum Sichern, Weitergeben, wieder Importieren)."""
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    board = await db.get_board(board_id)
    strokes = await db.load_all(board_id)
    data = board_file.build(board, strokes)
    title = (board.get("title") or "Blatt").strip()
    safe = "".join(c if c.isalnum() or c in " -_()" else "_" for c in title).strip() or "Blatt"
    from urllib.parse import quote

    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=\"blatt.sofianotes\"; filename*=UTF-8''{quote(safe)}.sofianotes"},
    )


@app.post("/api/import.sofianotes")
async def import_board_file(request: Request, me: dict = Depends(get_current_person)) -> dict:
    """Legt aus einer .sofianotes-Datei ein neues Blatt an (Body = Dateiinhalt)."""
    folder = request.query_params.get("folder") or None
    data = await request.body()
    try:
        parsed = board_file.parse(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await _create_from_parsed(me["id"], parsed, folder)


async def _create_from_parsed(person_id: str, parsed: dict, folder: str | None) -> dict:
    """Neues Blatt aus einer gelesenen .sofianotes-Datei (Import oder Senden an jemanden)."""
    board = await db.create_board(person_id, parsed["title"], folder, None)
    if board is None:
        raise HTTPException(status_code=400, detail="unknown person")
    me = {"id": person_id}
    bid = board["id"]
    await db.set_board_paper(bid, parsed["paper"])
    nb = db.clean_notebook(parsed.get("notebook")) if parsed.get("notebook") else None
    if nb:
        await db.set_board_notebook(bid, nb)
    if parsed["refs"]:
        await db.set_board_refs(bid, parsed["refs"])
    if parsed["strokes"]:
        await db.insert_strokes(bid, parsed["strokes"])
    # War das Blatt einer Sofia-Hausaufgabe zugeordnet und sieht dieses Konto die Aufgabe
    # auch, wird die Zuordnung mit uebernommen - aber nur, wenn es dafuer noch kein Blatt gibt.
    homework = None
    hw_id = parsed.get("sofiaHomeworkId")
    if hw_id and sofia_sync.enabled():
        if hw_id in await db.homework_boards(me["id"]):
            homework = "exists"
        elif await sofia_sync.homework_get(me["id"], hw_id):
            await db.link_homework_board(me["id"], hw_id, bid)
            homework = "linked"
        else:
            homework = "no_access"
    return {"ok": True, "board": await db.get_board(bid), "strokes": len(parsed["strokes"]), "homework": homework}


def _safe_filename(title: str) -> str:
    return "".join(c if c.isalnum() or c in " -_()" else "_" for c in (title or "Blatt")).strip() or "Blatt"


@app.post("/api/boards/{board_id}/send")
async def send_board(board_id: str, request: Request, me: dict = Depends(get_current_person)) -> dict:
    """Blatt an andere Personen schicken - als eigene Kopie (sofianotes) oder als PDF.
    Keine Zusammenarbeit: Aenderungen danach bleiben getrennt."""
    if not await db.can_access(me["id"], board_id):
        raise HTTPException(status_code=404, detail="not found")
    body = await _json_body(request)
    fmt = body.get("format")
    known = {p["id"] for p in await db.people()}
    to = [str(t) for t in (body.get("to") or []) if str(t) in known and str(t) != me["id"]]
    if fmt not in ("pdf", "sofianotes") or not to:
        raise HTTPException(status_code=400, detail="format und Empfänger nötig")
    board = await db.get_board(board_id)
    strokes = await db.load_all(board_id)
    title = board.get("title") or "Blatt"
    if fmt == "pdf":
        pdf = goodnotes_export.build_board_pdf(board, strokes)
        for pid in to:
            meta = files.save(pdf, _safe_filename(title) + ".pdf", "application/pdf")
            await db.inbox_add(pid, me["id"], "pdf", title, file_id=meta["id"])
    else:
        data = board_file.build(board, strokes)
        for pid in to:
            parsed = board_file.parse(data)
            res = await _create_from_parsed(pid, parsed, None)
            await db.inbox_add(pid, me["id"], "board", title, board_id=res["board"]["id"])
    return {"ok": True, "sent": len(to)}


@app.get("/api/inbox")
async def get_inbox(me: dict = Depends(get_current_person)) -> dict:
    return await db.inbox_list(me["id"])


@app.post("/api/inbox/seen")
async def inbox_seen(me: dict = Depends(get_current_person)) -> dict:
    await db.inbox_seen(me["id"])
    return {"ok": True}


@app.delete("/api/inbox/{item_id}")
async def inbox_remove(item_id: int, me: dict = Depends(get_current_person)) -> dict:
    if not await db.inbox_remove(me["id"], item_id):
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


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
async def download_pdf(board: str, me: dict = Depends(get_current_person)) -> Response:
    if not await db.can_access(me["id"], board):
        raise HTTPException(status_code=404, detail="not found")
    b = await db.get_board(board)
    pdf = goodnotes_export.build_board_pdf(b, await db.load_all(board))
    from urllib.parse import quote

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=\"blatt.pdf\"; filename*=UTF-8''{quote(_safe_filename(b.get('title') or 'Blatt'))}.pdf"},
    )


# Nacharbeiten nach Aenderungen (Export-Datei, Sofia-Loesung) gesammelt und verzoegert -
# nicht nach jedem einzelnen Strich, damit die Verbindung frei fuer neue Striche bleibt.
_after_change: dict[str, asyncio.Task] = {}


def _board_changed(board_id: str) -> None:
    t = _after_change.get(board_id)
    if t and not t.done():
        return

    async def later() -> None:
        await asyncio.sleep(1.5)
        _after_change.pop(board_id, None)
        try:
            await goodnotes_export.schedule_write(lambda: db.load_all(board_id))
            if sofia_sync.enabled():
                b = await db.get_board(board_id)
                if b and b.get("sofiaHomeworkId"):
                    owner_settings = await db.person_settings(b["ownerId"])
                    if owner_settings["solutionMode"] == "auto":
                        sofia_sync.schedule_solution(board_id)
        except Exception:  # noqa: BLE001 - Nacharbeit darf die Verbindung nie stoeren
            pass

    _after_change[board_id] = asyncio.get_event_loop().create_task(later())


async def _writable_ids(role: str, person: str, ids: list[str]) -> list[str]:
    """Welche Striche diese Person aendern/loeschen darf (nach Freigabe-Rolle)."""
    if role in ("owner", "edit"):
        return ids
    if role != "add":
        return []
    owners = await db.stroke_owners(ids)
    # neue Striche (noch nicht da) und eigene ja, fremde nein
    return [i for i in ids if i not in owners or owners[i] == person]


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    board_id = websocket.query_params.get("board") or ""
    me = await get_current_person_ws(websocket)
    # Erst annehmen, dann mit eigenem Code schliessen: wird schon der Handshake
    # abgelehnt, sieht der Browser nur 1006 und versucht es endlos weiter.
    if me is None:
        await websocket.accept()
        await websocket.close(code=4401)
        return
    person = me["id"]
    if not await db.can_access(person, board_id):
        await websocket.accept()
        await websocket.close(code=4403)
        return
    await websocket.accept()
    client = manager.connect(websocket)
    client.person_id = person
    client.board_id = board_id
    client.color = (await db.person_color(person)) or color_for(person) or client.color
    client.role = (await db.board_role(person, board_id)) or "edit"

    strokes = await db.load_all(board_id)
    board = await db.get_board(board_id)
    await websocket.send_json(
        {
            "type": "init",
            "clientId": client.id,
            "color": client.color,
            "personId": person,
            "role": client.role,
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
            # Nur ansehen: nichts aendern (Cursor ist ok)
            if client.role == "view" and msg_type in ("stroke_start", "stroke_points", "stroke_end", "stroke_replace", "stroke_move", "erase"):
                if msg_type in ("stroke_end", "stroke_move", "erase"):
                    await websocket.send_json({"type": "board_reload"})
                continue

            if msg_type == "cursor":
                await manager.broadcast(
                    {
                        "type": "cursor",
                        "id": client.id,
                        "color": client.color,
                        "person": client.person_id,
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
                        "author": person,
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
                if client.role == "add" and stroke_id and not await _writable_ids("add", person, [stroke_id]):
                    client.in_progress.pop(stroke_id, None)
                    await websocket.send_json({"type": "board_reload"})
                    continue
                entry = client.in_progress.pop(stroke_id, None)
                extra = msg.get("extra")
                if entry is not None and extra is not None:
                    entry["extra"] = extra
                # erst an die anderen Geraete, dann in die Datenbank (schnellere Live-Anzeige)
                await manager.broadcast(
                    {"type": "stroke_end", "id": client.id, "strokeId": stroke_id},
                    exclude=websocket,
                    board_id=room,
                )
                if entry is not None and len(entry["points"]) >= 1:
                    entry["board_id"] = room
                    await db.insert_stroke(entry, person)
                    persist_changed = True

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
                if stroke and stroke.get("id") and client.role == "add" and not await _writable_ids("add", person, [stroke["id"]]):
                    await websocket.send_json({"type": "board_reload"})
                    continue
                if stroke and stroke.get("id"):
                    stroke["board_id"] = room
                    await manager.broadcast(
                        {"type": "stroke_move", "id": client.id, "stroke": stroke},
                        exclude=websocket,
                        board_id=room,
                    )
                    await db.insert_stroke(stroke, person)
                    persist_changed = True

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
                allowed = await _writable_ids(client.role, person, stroke_ids)
                if len(allowed) != len(stroke_ids):
                    await websocket.send_json({"type": "board_reload"})
                stroke_ids = allowed
                if stroke_ids:
                    await manager.broadcast(
                        {"type": "erase", "id": client.id, "strokeIds": stroke_ids},
                        exclude=websocket,
                        board_id=room,
                    )
                    await db.delete_strokes(stroke_ids, person)
                    persist_changed = True

            if persist_changed:
                _board_changed(room)

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
        # Blatt verlassen: anstehende Loesung gleich hochladen statt zu warten
        if sofia_sync.solution_pending(board_id):
            sofia_sync.schedule_solution(board_id, delay=3)
        await manager.broadcast({"type": "presence_leave", "id": client.id}, board_id=board_id)


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
