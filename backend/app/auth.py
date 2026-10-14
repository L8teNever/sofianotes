"""Auth ueber Cloudflare Access.

Cloudflare Access sitzt als Reverse Proxy vor der App und laesst nur
Requests durch, die seine eigene Login-Pruefung bestanden haben. Bei jedem
durchgelassenen Request haengt Access den Header
`Cf-Access-Authenticated-User-Email` mit der verifizierten E-Mail-Adresse
an - dem kann vertraut werden, er kommt nie direkt vom Client (Access
verwirft/ueberschreibt einen vom Client selbst gesetzten gleichnamigen
Header).

Welche Person (Simon/Franz/Die Jungen/...) zu welcher E-Mail gehoert,
verwaltet ein Admin (siehe db.person_emails). Alle bisherigen `personId`/
`person`-Parameter aus dem Frontend werden fuer Zugriffsentscheidungen NICHT
mehr vertraut - massgeblich ist ausschliesslich die hier aufgeloeste
Identitaet.

Fuer lokale Entwicklung ohne Cloudflare Access kann stattdessen
DEV_BYPASS_EMAIL gesetzt werden.
"""
import os

from fastapi import HTTPException, Request, WebSocket

ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email"
DEV_BYPASS_EMAIL = os.environ.get("DEV_BYPASS_EMAIL", "").strip().lower() or None


def _extract_email(headers) -> str | None:
    email = headers.get(ACCESS_EMAIL_HEADER)
    if email:
        return email.strip().lower()
    return DEV_BYPASS_EMAIL


async def get_current_person(request: Request) -> dict:
    from . import db

    email = _extract_email(request.headers)
    if not email:
        raise HTTPException(status_code=401, detail="Keine Cloudflare-Access-Anmeldung gefunden.")
    person = await db.person_by_email(email)
    if person is None:
        # vielleicht gerade erst in Sofia angelegt: einmal abgleichen und nochmal schauen
        from . import sofia_sync

        if sofia_sync.enabled():
            await sofia_sync.sync_once()
            person = await db.person_by_email(email)
    if person is None:
        raise HTTPException(
            status_code=403,
            detail=f"Kein Zugriff fuer {email}. Ein Admin muss diese Mail-Adresse erst einer Person zuordnen.",
        )
    return person


async def require_admin(request: Request) -> dict:
    person = await get_current_person(request)
    if not person["isAdmin"]:
        raise HTTPException(status_code=403, detail="Nur Admins duerfen das.")
    return person


async def get_current_person_ws(websocket: WebSocket) -> dict | None:
    from . import db

    email = _extract_email(websocket.headers)
    if not email:
        return None
    return await db.person_by_email(email)
