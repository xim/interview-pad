import asyncio
import logging
import mimetypes
import os
import secrets
import stat
from dataclasses import dataclass, field
from pathlib import Path

import anyio
from pycrdt import (
    Awareness,
    Doc,
    Map,
    Text,
    YMessageType,
    create_awareness_message,
    create_sync_message,
    create_update_message,
    handle_sync_message,
    read_message,
)
from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.requests import HTTPConnection, Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

log = logging.getLogger("uvicorn.error")

COOKIE = "session"
MAX_NAME = 40
MAX_PENDING = 10  # anyone with the URL can ask to join
MAX_DEMOS = 20  # solo sandboxes, each with its own room; the oldest is evicted
STATIC_DIR = os.environ.get("STATIC_DIR", Path(__file__).parent.parent / "web" / "dist")
ROOM = "/ws/pad"  # y-websocket connects to <url>/<room name>

TEMPLATES = {
    "c": """#include <stdio.h>

int main(void) {
    printf("Hello from %s\\n", "C");
}
""",
    "cpp": """#include <iostream>
#include <string>

std::string greet(const std::string& name) {
    return "Hello from " + name;
}

int main() {
    std::cout << greet("C++") << '\\n';
}
""",
    "python": """def greet(name: str) -> str:
    return f"Hello from {name}"


print(greet("Python"))
""",
    "ts": """function greet(name: string): string {
    return `Hello from ${name}`;
}

console.log(greet("TypeScript"));
""",
}


# Cross-origin isolation enables SharedArrayBuffer, which the threaded clangd build needs.
ISOLATION_HEADERS = [(b"cross-origin-opener-policy", b"same-origin"), (b"cross-origin-embedder-policy", b"require-corp")]


class CrossOriginIsolation:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        async def send_isolated(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), *ISOLATION_HEADERS]}
            await send(message)

        await self.app(scope, receive, send_isolated)


class Static(StaticFiles):
    """Serves the build's precompressed siblings (.br/.gz, from web/scripts/precompress.mjs) when accepted, and sets
    caching: content-hashed assets/ forever, everything else revalidated, so a rebuild never mixes old and new."""

    ENCODINGS = (("br", ".br"), ("gzip", ".gz"))

    async def get_response(self, path: str, scope) -> Response:
        accepted = Headers(scope=scope).get("accept-encoding", "")
        response = None
        for encoding, suffix in self.ENCODINGS:
            if encoding not in accepted:
                continue
            full_path, stat_result = await anyio.to_thread.run_sync(self.lookup_path, path + suffix)
            if stat_result and stat.S_ISREG(stat_result.st_mode):
                response = self.file_response(full_path, stat_result, scope)
                media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
                response.headers["content-type"] = media_type + ("; charset=utf-8" if media_type.startswith("text/") else "")
                response.headers["content-encoding"] = encoding
                break
        response = response or await super().get_response(path, scope)
        response.headers["vary"] = "Accept-Encoding"
        response.headers["cache-control"] = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
        return response


class Room:
    """The shared Y.Doc, served with the y-websocket protocol: sync steps and updates for the document, awareness
    (cursors, names) relayed between clients and dropped when a client's socket closes."""

    def __init__(self, doc: Doc):
        self.doc = doc
        self.awareness = Awareness(doc)
        self.awareness.set_local_state(None)  # the server isn't a participant
        self.clients: dict[WebSocket, tuple[asyncio.Queue, set[int]]] = {}  # socket -> (send queue, awareness ids)
        doc.observe(lambda event: self.broadcast(create_update_message(event.update)))
        self.awareness.observe(self._track)

    def _track(self, topic: str, event) -> None:
        changes, origin = event
        if topic == "update" and origin in self.clients:
            self.clients[origin][1].update(changes["added"], changes["updated"])

    def broadcast(self, message: bytes, exclude: WebSocket | None = None) -> None:
        for ws, (queue, _) in self.clients.items():
            if ws is not exclude:
                queue.put_nowait(message)

    async def serve(self, ws: WebSocket) -> None:
        queue: asyncio.Queue = asyncio.Queue()  # per client, so a slow one doesn't hold up the rest
        self.clients[ws] = (queue, set())

        async def send():
            while True:
                await ws.send_bytes(await queue.get())

        sender = asyncio.create_task(send())
        try:
            queue.put_nowait(create_sync_message(self.doc))
            if self.awareness.states:
                queue.put_nowait(create_awareness_message(self.awareness.encode_awareness_update(list(self.awareness.states))))
            async for message in ws.iter_bytes():
                if message[0] == YMessageType.SYNC:
                    if reply := handle_sync_message(message[1:], self.doc):  # updates are broadcast via doc.observe
                        queue.put_nowait(reply)
                elif message[0] == YMessageType.AWARENESS:
                    self.awareness.apply_awareness_update(read_message(message[1:]), ws)
                    self.broadcast(message, exclude=ws)
        finally:
            sender.cancel()
            ids = list(self.clients.pop(ws)[1])
            # a client can't announce leaving when it's kicked or its connection drops
            self.awareness.remove_awareness_states(ids, None)
            if ids:
                self.broadcast(create_awareness_message(self.awareness.encode_awareness_update(ids)))


@dataclass
class Session:
    name: str
    role: str  # "interviewer" | "candidate" | "demo"
    status: str  # "pending" | "admitted" | "denied" | "ended"
    id: str = field(default_factory=lambda: secrets.token_urlsafe(8))


def create_app(password: str | None = None, secure_cookies: bool = True, static_dir=STATIC_DIR) -> Starlette:
    if password is None:
        password = os.environ.get("INTERVIEWER_PASSWORD")
    if not password:
        password = secrets.token_urlsafe(12)
        log.warning("INTERVIEWER_PASSWORD not set, generated: %s", password)

    sessions: dict[str, Session] = {}
    sockets: dict[str, set[WebSocket]] = {}  # session token -> open sync websockets
    def new_room() -> Room:
        doc = Doc()
        for lang, code in TEMPLATES.items():
            doc[f"code:{lang}"] = Text(code)
        doc["state"] = Map({"lang": "cpp"})
        doc["output"] = Text()
        return Room(doc)

    room = new_room()
    demo_rooms: dict[str, Room] = {}  # demo session id -> its private room, oldest first

    def current(conn: HTTPConnection) -> Session | None:
        return sessions.get(conn.cookies.get(COOKIE, ""))

    async def ws(websocket: WebSocket):
        s = current(websocket)
        if s is None or s.status != "admitted":
            await websocket.close(1008)
            return
        token = websocket.cookies[COOKIE]
        sockets.setdefault(token, set()).add(websocket)
        await websocket.accept()
        try:
            await demo_rooms.get(s.id, room).serve(websocket)
        finally:
            sockets[token].discard(websocket)

    def require_interviewer(request: Request) -> None:
        s = current(request)
        if s is None or s.role != "interviewer":
            raise HTTPException(403)

    async def json_body(request: Request) -> dict:
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(400, "invalid JSON")
        if not isinstance(body, dict):
            raise HTTPException(400, "expected object")
        return body

    def start_session(s: Session) -> Response:
        token = secrets.token_urlsafe(32)
        sessions[token] = s
        response = JSONResponse(me_json(s))
        response.set_cookie(COOKIE, token, httponly=True, samesite="strict", secure=secure_cookies)
        return response

    def me_json(s: Session) -> dict:
        return {"name": s.name, "role": s.role, "status": s.status}

    def parse_name(body: dict, default: str | None = None) -> str:
        name = body.get("name")
        name = (name.strip() if isinstance(name, str) else "") or default or ""
        if not 1 <= len(name) <= MAX_NAME:
            raise HTTPException(400, f"name must be 1-{MAX_NAME} characters")
        return name

    async def login(request: Request) -> Response:
        body = await json_body(request)
        given = body.get("password")
        if not isinstance(given, str) or not secrets.compare_digest(given.encode(), password.encode()):
            raise HTTPException(401, "wrong password")
        return start_session(Session(parse_name(body, "Interviewer"), "interviewer", "admitted"))

    async def join(request: Request) -> Response:
        name = parse_name(await json_body(request))
        if sum(s.status == "pending" for s in sessions.values()) >= MAX_PENDING:
            raise HTTPException(429, "Too many people are waiting to join. Try again later.")
        return start_session(Session(name, "candidate", "pending"))

    async def demo(request: Request) -> Response:
        s = Session("Demo", "demo", "admitted")
        demo_rooms[s.id] = new_room()
        if len(demo_rooms) > MAX_DEMOS:
            evicted = next(iter(demo_rooms))
            del demo_rooms[evicted]
            for token in [t for t, other in sessions.items() if other.id == evicted]:
                del sessions[token]
        return start_session(s)

    async def me(request: Request) -> Response:
        s = current(request)
        if s is None:
            raise HTTPException(401)
        return JSONResponse(me_json(s))

    async def pending(request: Request) -> Response:
        require_interviewer(request)
        return JSONResponse([{"id": s.id, "name": s.name} for s in sessions.values() if s.status == "pending"])

    async def admit(request: Request) -> Response:
        require_interviewer(request)
        decision = (await json_body(request)).get("admit")
        if not isinstance(decision, bool):
            raise HTTPException(400, "admit must be a boolean")
        for s in sessions.values():
            if s.id == request.path_params["id"] and s.status == "pending":
                s.status = "admitted" if decision else "denied"
                return JSONResponse(me_json(s))
        raise HTTPException(404)

    async def end(request: Request) -> Response:
        require_interviewer(request)
        for token, s in sessions.items():
            if s.role == "candidate" and s.status in ("pending", "admitted"):
                s.status = "ended"
                for websocket in list(sockets.get(token, ())):
                    await websocket.close(1008)
        return JSONResponse({})

    return Starlette(
        routes=[
            Route("/api/login", login, methods=["POST"]),
            Route("/api/join", join, methods=["POST"]),
            Route("/api/me", me),
            Route("/api/pending", pending),
            Route("/api/admit/{id}", admit, methods=["POST"]),
            Route("/api/end", end, methods=["POST"]),
            Route("/api/demo", demo, methods=["POST"]),
            WebSocketRoute(ROOM, ws),
            Mount("/", Static(directory=static_dir, html=True, check_dir=False)),
        ],
        middleware=[Middleware(CrossOriginIsolation)],
    )
