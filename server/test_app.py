import gzip

import pytest
from starlette.testclient import TestClient

from pycrdt import Doc, Map, Text, YMessageType, YSyncMessageType, create_sync_message, handle_sync_message
from starlette.websockets import WebSocketDisconnect

from app import ROOM, TEMPLATES, create_app


@pytest.fixture
def app():
    return create_app(password="pw", secure_cookies=False)


@pytest.fixture
def interviewer(app):
    c = TestClient(app)
    assert c.post("/api/login", json={"password": "pw"}).status_code == 200
    return c


def test_login(app):
    c = TestClient(app)
    assert c.post("/api/login", json={"password": "nope"}).status_code == 401
    assert c.get("/api/me").status_code == 401
    assert c.post("/api/login", json={"password": "pw"}).json()["role"] == "interviewer"
    assert c.get("/api/me").json() == {"name": "Interviewer", "role": "interviewer", "status": "admitted"}


@pytest.mark.parametrize("name, expected", [(" Grace ", "Grace"), ("", "Interviewer"), (None, "Interviewer")])
def test_login_name(app, name, expected):
    r = TestClient(app).post("/api/login", json={"password": "pw", "name": name})
    assert r.json()["name"] == expected


def test_login_name_too_long(app):
    assert TestClient(app).post("/api/login", json={"password": "pw", "name": "x" * 41}).status_code == 400


@pytest.mark.parametrize("body", [{}, {"password": 1}, [], "x"])
def test_login_bad_body(app, body):
    assert TestClient(app).post("/api/login", json=body).status_code in (400, 401)


def test_login_invalid_json(app):
    assert TestClient(app).post("/api/login", content=b"{").status_code == 400


def test_cross_origin_isolation_headers(app):
    r = TestClient(app).get("/api/me")
    assert r.headers["cross-origin-opener-policy"] == "same-origin"
    assert r.headers["cross-origin-embedder-policy"] == "require-corp"


@pytest.fixture
def static(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "a-123.js").write_text("plain")
    (tmp_path / "assets" / "a-123.js.br").write_bytes(b"brotli")
    (tmp_path / "assets" / "a-123.js.gz").write_bytes(gzip.compress(b"from gz"))
    (tmp_path / "index.html").write_text("<html>")
    return TestClient(create_app(password="pw", secure_cookies=False, static_dir=tmp_path))


# httpx decodes gzip itself; without the brotli package it passes br through as-is
@pytest.mark.parametrize("accept, body, encoding", [("br, gzip", b"brotli", "br"), ("gzip", b"from gz", "gzip"), ("identity", b"plain", None)])
def test_static_precompressed(static, accept, body, encoding):
    r = static.get("/assets/a-123.js", headers={"accept-encoding": accept})
    assert r.headers.get("content-encoding") == encoding
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.content == body


def test_static_caching(static):
    assert static.get("/assets/a-123.js").headers["cache-control"] == "public, max-age=31536000, immutable"
    assert static.get("/").headers["cache-control"] == "no-cache"
    assert static.get("/index.html").headers["cache-control"] == "no-cache"


def test_cookie_secure_by_default():
    r = TestClient(create_app(password="pw")).post("/api/login", json={"password": "pw"})
    cookie = r.headers["set-cookie"].lower()
    assert "secure" in cookie and "httponly" in cookie and "samesite=strict" in cookie


@pytest.mark.parametrize("name", ["", "   ", "x" * 41, None, 5])
def test_join_bad_name(app, name):
    assert TestClient(app).post("/api/join", json={"name": name}).status_code == 400


@pytest.mark.parametrize("admit, status", [(True, "admitted"), (False, "denied")])
def test_admit_flow(app, interviewer, admit, status):
    cand = TestClient(app)
    assert cand.post("/api/join", json={"name": " Ada "}).json() == {"name": "Ada", "role": "candidate", "status": "pending"}
    pending = interviewer.get("/api/pending").json()
    assert [p["name"] for p in pending] == ["Ada"]
    assert interviewer.post(f"/api/admit/{pending[0]['id']}", json={"admit": admit}).status_code == 200
    assert cand.get("/api/me").json()["status"] == status
    assert interviewer.get("/api/pending").json() == []
    # decided sessions can't be re-decided
    assert interviewer.post(f"/api/admit/{pending[0]['id']}", json={"admit": True}).status_code == 404


def test_pending_limit(app):
    from app import MAX_PENDING

    for i in range(MAX_PENDING):
        assert TestClient(app).post("/api/join", json={"name": f"c{i}"}).status_code == 200
    assert TestClient(app).post("/api/join", json={"name": "late"}).status_code == 429


def test_candidate_cannot_admit(app, interviewer):
    cand = TestClient(app)
    cand.post("/api/join", json={"name": "Ada"})
    assert cand.get("/api/pending").status_code == 403
    pid = interviewer.get("/api/pending").json()[0]["id"]
    assert cand.post(f"/api/admit/{pid}", json={"admit": True}).status_code == 403
    assert TestClient(app).get("/api/pending").status_code == 403


def test_admit_bad_body(app, interviewer):
    TestClient(app).post("/api/join", json={"name": "Ada"})
    pid = interviewer.get("/api/pending").json()[0]["id"]
    assert interviewer.post(f"/api/admit/{pid}", json={"admit": "yes"}).status_code == 400


def test_end_requires_interviewer(app):
    cand = TestClient(app)
    cand.post("/api/join", json={"name": "Ada"})
    assert cand.post("/api/end").status_code == 403


def test_end_kicks_candidates(app, interviewer):
    with TestClient(app) as cand:
        cand.post("/api/join", json={"name": "Ada"})
        pid = interviewer.get("/api/pending").json()[0]["id"]
        interviewer.post(f"/api/admit/{pid}", json={"admit": True})
        with cand.websocket_connect(ROOM) as ws:
            sync_doc(ws)
            assert interviewer.post("/api/end").status_code == 200
            with pytest.raises(WebSocketDisconnect):
                while True:
                    ws.receive_bytes()
        assert cand.get("/api/me").json()["status"] == "ended"
        with pytest.raises(WebSocketDisconnect):
            cand.websocket_connect(ROOM).__enter__()
        assert interviewer.get("/api/me").json()["status"] == "admitted"


def sync_doc(ws) -> Doc:
    doc = Doc()
    ws.send_bytes(create_sync_message(doc))
    while True:
        msg = ws.receive_bytes()
        if msg[0] == YMessageType.SYNC and msg[1] == YSyncMessageType.SYNC_STEP2:
            handle_sync_message(msg[1:], doc)
            return doc


def test_ws_requires_admitted(app):
    with TestClient(app) as c:
        with pytest.raises(WebSocketDisconnect):
            c.websocket_connect(ROOM).__enter__()
        c.post("/api/join", json={"name": "Ada"})
        with pytest.raises(WebSocketDisconnect):
            c.websocket_connect(ROOM).__enter__()


def test_ws_sync_seeded_doc(app):
    with TestClient(app) as c:
        c.post("/api/login", json={"password": "pw"})
        with c.websocket_connect(ROOM) as ws:
            doc = sync_doc(ws)
        assert str(doc.get("code:python", type=Text)) == TEMPLATES["python"]
        assert doc.get("state", type=Map)["lang"] == "cpp"
