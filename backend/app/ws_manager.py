"""WebSocket connection + presence management for the shared whiteboard."""
import itertools
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

# Distinct, readable colors used to identify each connected participant's
# live cursor/presence marker (independent of whatever pen color they draw
# with).
PRESENCE_PALETTE = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231",
    "#911eb4", "#42d4f4", "#f032e6", "#bfef45",
    "#fabed4", "#469990", "#dcbeff", "#9a6324",
]


@dataclass
class ClientState:
    id: str
    color: str
    websocket: WebSocket
    in_progress: dict[str, dict[str, Any]] = field(default_factory=dict)


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: dict[WebSocket, ClientState] = {}
        self._color_cycle = itertools.cycle(PRESENCE_PALETTE)

    def connect(self, websocket: WebSocket) -> ClientState:
        state = ClientState(
            id=str(uuid.uuid4()), color=next(self._color_cycle), websocket=websocket
        )
        self._clients[websocket] = state
        return state

    def disconnect(self, websocket: WebSocket) -> ClientState | None:
        return self._clients.pop(websocket, None)

    def get(self, websocket: WebSocket) -> ClientState | None:
        return self._clients.get(websocket)

    async def broadcast(self, message: dict[str, Any], exclude: WebSocket | None = None) -> None:
        dead: list[WebSocket] = []
        for ws in list(self._clients.keys()):
            if ws is exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.pop(ws, None)
