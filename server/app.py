import logging
import os
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from pycrdt import Map, Text
from pycrdt.websocket import ASGIServer, WebsocketServer
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import HTTPConnection, Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket

log = logging.getLogger("uvicorn.error")

COOKIE = "session"
MAX_NAME = 40
ROOM = "/ws/pad"  # y-websocket connects to <url>/<room>; pycrdt-websocket names rooms by path

TEMPLATES = {
    "cpp": """#include <print>
#include <vector>

int main() {
    std::vector<int> v{3, 1, 2};
    std::println("Hello from C++: {}", v);
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


@dataclass
class Session:
    name: str
    role: str  # "interviewer" | "candidate"
    status: str  # "pending" | "admitted" | "denied"
    id: str = field(default_factory=lambda: secrets.token_urlsafe(8))


def create_app(password: str | None = None, secure_cookies: bool | None = None) -> Starlette:
    if password is None:
        password = os.environ.get("INTERVIEWER_PASSWORD")
    if not password:
        password = secrets.token_urlsafe(12)
        log.warning("INTERVIEWER_PASSWORD not set, generated: %s", password)
    if secure_cookies is None:
        secure_cookies = not os.environ.get("INSECURE_COOKIES")

    sessions: dict[str, Session] = {}
    yserver = WebsocketServer(auto_clean_rooms=False, log=log)

    def current(conn: HTTPConnection) -> Session | None:
        return sessions.get(conn.cookies.get(COOKIE, ""))

    yasgi = ASGIServer(yserver)

    async def ws(websocket: WebSocket):
        s = current(websocket)
        if s is None or s.status != "admitted":
            await websocket.close(1008)
            return
        await yasgi(websocket.scope, websocket.receive, websocket.send)

    @asynccontextmanager
    async def lifespan(app: Starlette):
        async with yserver:
            doc = (await yserver.get_room(ROOM)).ydoc
            for lang, code in TEMPLATES.items():
                doc[f"code:{lang}"] = Text(code)
            doc["state"] = Map({"lang": "cpp"})
            doc["output"] = Text()
            yield

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

    async def login(request: Request) -> Response:
        given = (await json_body(request)).get("password")
        if not isinstance(given, str) or not secrets.compare_digest(given.encode(), password.encode()):
            raise HTTPException(401, "wrong password")
        return start_session(Session("Interviewer", "interviewer", "admitted"))

    async def join(request: Request) -> Response:
        name = (await json_body(request)).get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not 1 <= len(name) <= MAX_NAME:
            raise HTTPException(400, f"name must be 1-{MAX_NAME} characters")
        return start_session(Session(name, "candidate", "pending"))

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

    return Starlette(
        routes=[
            Route("/api/login", login, methods=["POST"]),
            Route("/api/join", join, methods=["POST"]),
            Route("/api/me", me),
            Route("/api/pending", pending),
            Route("/api/admit/{id}", admit, methods=["POST"]),
            WebSocketRoute(ROOM, ws),
        ],
        lifespan=lifespan,
    )
