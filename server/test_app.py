import pytest
from starlette.testclient import TestClient

from app import create_app


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


@pytest.mark.parametrize("body", [{}, {"password": 1}, [], "x"])
def test_login_bad_body(app, body):
    assert TestClient(app).post("/api/login", json=body).status_code in (400, 401)


def test_login_invalid_json(app):
    assert TestClient(app).post("/api/login", content=b"{").status_code == 400


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
