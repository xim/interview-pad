import logging
import os
import secrets
from dataclasses import dataclass, field

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

log = logging.getLogger("uvicorn.error")

COOKIE = "session"
MAX_NAME = 40


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

    def current(request: Request) -> Session | None:
        return sessions.get(request.cookies.get(COOKIE, ""))

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
        ]
    )
