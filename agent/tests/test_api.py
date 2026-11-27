import pytest
from fastapi.testclient import TestClient

from nas_agent.api import create_app
from nas_agent.auth import Authenticator, client_ip
from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmUnreachable
from nas_agent.engine import Engine
from tests.conftest import FakeDsm, load_fixture

RESPONSES = {
    "SYNO.DSM.Info.getinfo": load_fixture("dsm_info"),
    "SYNO.Storage.CGI.Storage.load_info": load_fixture("storage_load_info"),
}


@pytest.fixture
def app_parts(settings, audit, tokens):
    catalog = build_catalog()
    dsm = FakeDsm(RESPONSES)
    engine = Engine(catalog, dsm, audit, settings)
    auth = Authenticator(tokens, audit, settings.limits)
    return create_app(settings, engine, catalog, auth), dsm


@pytest.fixture
def client(app_parts):
    with TestClient(app_parts[0], base_url="http://127.0.0.1") as c:
        yield c


def bearer(tokens, *scopes):
    _, raw = tokens.create("test", scopes or ["system:read"])
    return raw, {"Authorization": f"Bearer {raw}"}


def test_no_token_is_401_problem(client):
    r = client.get("/v1/system/info")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "unauthorized"
    assert r.headers["www-authenticate"].startswith("Bearer")


def test_token_in_query_is_ignored_and_never_logged(client, tokens, conn):
    raw, _ = bearer(tokens)
    r = client.get(f"/v1/system/info?token={raw}")
    assert r.status_code == 401
    assert raw.split("_", 2)[2] not in "\n".join(conn.iterdump())


def test_malformed_header_is_401(client, tokens):
    raw, _ = bearer(tokens)
    for header in (f"Token {raw}", raw, "Bearer", "Bearer nag_x"):
        assert client.get("/v1/system/info", headers={"Authorization": header}).status_code == 401


def test_missing_scope_is_403(client, tokens):
    _, h = bearer(tokens, "system:read")
    r = client.get("/v1/storage/overview", headers=h)
    assert r.status_code == 403 and r.json()["code"] == "forbidden"


def test_ok_envelope(client, tokens):
    _, h = bearer(tokens, "system:read")
    r = client.get("/v1/system/info", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["op"] == "system.info" and body["cached"] is False
    assert body["data"]["model"] == "DS918+" and "fetched_at" in body


def test_ops_lists_only_permitted(client, tokens):
    _, h = bearer(tokens, "system:read")
    ids = {o["id"] for o in client.get("/v1/ops", headers=h).json()}
    assert "system.info" in ids and "storage.overview" not in ids and "agent.audit" not in ids


def test_openapi_requires_token(client, tokens):
    assert client.get("/v1/openapi.json").status_code == 401
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404
    _, h = bearer(tokens)
    schema = client.get("/v1/openapi.json", headers=h).json()
    assert "/v1/system/info" in schema["paths"]
    assert schema["components"]["securitySchemes"]["bearer"]["scheme"] == "bearer"
    params = schema["paths"]["/v1/agent/audit"]["get"]["parameters"]
    assert params[0]["name"] == "limit"


def test_healthz_is_open_and_minimal(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_dsm_unreachable_is_503_without_internals(app_parts, tokens):
    app, dsm = app_parts
    dsm.responses["SYNO.DSM.Info.getinfo"] = DsmUnreachable("x")
    with TestClient(app, base_url="http://127.0.0.1") as c:
        _, h = bearer(tokens)
        r = c.get("/v1/system/info", headers=h)
    assert r.status_code == 503 and r.json()["code"] == "dsm_unreachable"
    assert "Traceback" not in r.text and "172.17.0.1" not in r.text


def test_lockout_after_repeated_failures(client, tokens):
    for _ in range(10):
        client.get("/v1/system/info", headers={"Authorization": "Bearer nope"})
    _, h = bearer(tokens)
    r = client.get("/v1/system/info", headers=h)
    assert r.status_code == 429 and r.json()["code"] == "rate_limited"


def test_invalid_params_is_422(client, tokens):
    _, h = bearer(tokens, "audit:read")
    r = client.get("/v1/agent/audit?limit=9999", headers=h)
    assert r.status_code == 422 and r.json()["code"] == "invalid_params"
    r = client.get("/v1/system/info?api=SYNO.Core.User", headers=bearer(tokens)[1])
    assert r.status_code == 422


def test_unknown_route_is_problem_404(client):
    r = client.get("/v1/nope")
    assert r.status_code == 404 and r.json()["code"] == "not_found"


def test_forwarded_for_only_from_trusted_proxy():
    trusted = ["127.0.0.1"]
    assert client_ip("127.0.0.1", {"x-forwarded-for": "100.101.1.2"}, trusted) == "100.101.1.2"
    assert client_ip("100.64.0.9", {"x-forwarded-for": "100.101.1.2"}, trusted) == "100.64.0.9"
    assert client_ip(None, {}, trusted) == "unknown"


def test_forwarded_for_must_be_an_ip_and_last_hop_wins():
    from starlette.datastructures import Headers

    trusted = ["127.0.0.2"]
    h = Headers(raw=[(b"x-forwarded-for", b"1.2.3.4, 100.101.1.2")])
    assert client_ip("127.0.0.2", h, trusted) == "100.101.1.2"
    h = Headers(raw=[(b"x-forwarded-for", b"<script>")])
    assert client_ip("127.0.0.2", h, trusted) == "127.0.0.2"


def test_foreign_host_refused_on_rest(app_parts, tokens):
    with TestClient(app_parts[0], base_url="http://evil.example.com") as c:
        r = c.get("/v1/system/info", headers=bearer(tokens)[1])
    assert r.status_code == 400


def test_trailing_slash_is_not_redirected(client, tokens):
    r = client.get("/v1/system/info/", headers=bearer(tokens)[1], follow_redirects=False)
    assert r.status_code == 404


def test_meta_calls_are_journaled(client, tokens, audit):
    client.get("/v1/ops", headers=bearer(tokens)[1])
    assert audit.tail()[0].op == "meta.ops"


def test_lockout_is_logged_once(client, tokens, audit):
    for _ in range(30):
        client.get("/v1/system/info", headers={"Authorization": "Bearer nope"})
    codes = [e.code for e in audit.tail(100)]
    assert codes.count("unauthorized") == 10 and codes.count("rate_limited") == 1
