"""Moteur installable (conception 2026-11-25) : jeton de la console, attente, enrôlement par la console."""

import os
import tomllib

import pytest
from fastapi.testclient import TestClient
from synology_dsm.exceptions import (
    SynologyDSMLoginInvalidException,
    SynologyDSMRequestException,
)

from nas_agent.audit import AuditLog
from nas_agent.config import ConfigError
from nas_agent.db import open_db
from nas_agent.dsm.credentials import load_credentials
from nas_agent.setup import (
    CONSOLE_LABEL,
    CONSOLE_SCOPES,
    Enroller,
    OtpRequired,
    create_setup_app,
    ensure_console_token,
    is_enrolled,
    load_setup_settings,
)
from nas_agent.tokens import TokenStore

FP = "ab" * 32
CIDR = "172.29.54.0/24"
CONSOLE_IP = "172.29.54.3"


@pytest.fixture
def store(tmp_path):
    conn = open_db(tmp_path / "agent.db")
    return TokenStore(conn), AuditLog(conn)


# Le jeton de la console


def test_console_token_is_created_private_and_bound_to_the_project(tmp_path, store):
    tokens, _ = store
    path = tmp_path / "shared" / "console-token"
    assert ensure_console_token(tokens, path, [CIDR]) is True
    raw = path.read_text().strip()
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    principal = tokens.authenticate(raw, CONSOLE_IP)
    assert principal is not None and principal.scopes == CONSOLE_SCOPES
    assert "agent:setup" in principal.scopes
    assert principal.label == CONSOLE_LABEL
    # Hors du réseau du projet, le jeton ne vaut rien.
    assert tokens.authenticate(raw, "192.168.1.20") is None


def test_valid_console_token_is_kept(tmp_path, store):
    tokens, _ = store
    path = tmp_path / "console-token"
    ensure_console_token(tokens, path, [CIDR])
    first = path.read_text()
    assert ensure_console_token(tokens, path, [CIDR]) is False
    assert path.read_text() == first
    assert len([t for t in tokens.list() if t.label == CONSOLE_LABEL]) == 1


def test_revoked_console_token_is_replaced_and_old_ones_revoked(tmp_path, store):
    tokens, _ = store
    path = tmp_path / "console-token"
    ensure_console_token(tokens, path, [CIDR])
    old = path.read_text().strip()
    tokens.revoke(old.split("_")[1])
    assert ensure_console_token(tokens, path, [CIDR]) is True
    new = path.read_text().strip()
    assert new != old and tokens.authenticate(new, CONSOLE_IP) is not None
    live = [t for t in tokens.list() if t.label == CONSOLE_LABEL and t.revoked_at is None]
    assert len(live) == 1


def test_lost_token_file_revokes_the_previous_console_token(tmp_path, store):
    tokens, _ = store
    path = tmp_path / "console-token"
    ensure_console_token(tokens, path, [CIDR])
    old = path.read_text().strip()
    path.unlink()
    ensure_console_token(tokens, path, [CIDR])
    assert tokens.authenticate(old, CONSOLE_IP) is None


# Réglages du mode d'attente


def test_setup_settings_need_the_console_token_file(tmp_path):
    assert load_setup_settings({"NAS_AGENT_DATA_DIR": str(tmp_path)}) is None


def test_setup_settings_from_the_project(tmp_path):
    s = load_setup_settings(
        {
            "NAS_AGENT_DATA_DIR": str(tmp_path),
            "NAS_AGENT_CONSOLE_TOKEN_FILE": "/shared/console-token",
            "NAS_AGENT_CONSOLE_CIDR": CIDR,
            "NAS_AGENT_BIND_HOST": "0.0.0.0",
            "NAS_AGENT_ALLOW_NON_LOOPBACK": "1",
            "NAS_AGENT_PUBLIC_HOSTS": "agent",
        }
    )
    assert s is not None
    assert (s.bind_host, s.public_hosts, s.console_cidrs) == ("0.0.0.0", ["agent"], [CIDR])
    assert str(s.console_token_file) == "/shared/console-token"


def test_setup_settings_refuse_an_open_bind_without_the_flag(tmp_path):
    with pytest.raises(ConfigError):
        load_setup_settings(
            {
                "NAS_AGENT_DATA_DIR": str(tmp_path),
                "NAS_AGENT_CONSOLE_TOKEN_FILE": "/shared/console-token",
                "NAS_AGENT_BIND_HOST": "0.0.0.0",
            }
        )


def test_enrolled_means_credentials_and_config(tmp_path):
    assert is_enrolled(tmp_path) is False
    (tmp_path / "secrets").mkdir()
    (tmp_path / "secrets" / "dsm.json").write_text("{}")
    assert is_enrolled(tmp_path) is False
    (tmp_path / "config.toml").write_text("")
    assert is_enrolled(tmp_path) is True


# L'enrôlement par la console


class FakeDsmLogin:
    """Faux DSM : exige un code si `otp` est posé, lève les erreurs données, puis accepte."""

    def __init__(self, *errors, otp=None):
        self.errors = list(errors)
        self.otp = otp
        self.calls = []

    async def __call__(self, dsm, creds, otp):
        self.calls.append((dsm, creds.username, creds.password, otp))
        if self.errors:
            raise self.errors.pop(0)
        if self.otp and otp != self.otp:
            raise OtpRequired()
        return "did-1"


def client_for(tmp_path, store, login, *, fingerprint=FP, verifies=False, enrolled=None):
    tokens, audit = store
    token_file = tmp_path / "console-token"
    ensure_console_token(tokens, token_file, [CIDR])
    settings = load_setup_settings(
        {
            "NAS_AGENT_DATA_DIR": str(tmp_path / "data"),
            "NAS_AGENT_CONSOLE_TOKEN_FILE": str(token_file),
            "NAS_AGENT_CONSOLE_CIDR": CIDR,
            "NAS_AGENT_PUBLIC_HOSTS": "agent",
        }
    )
    events = enrolled if enrolled is not None else []
    enroller = Enroller(
        fetch=lambda host, port: ("pem", fingerprint),
        verifies=lambda host, port, name: verifies,
        login=login,
        gateway=lambda: "172.29.54.1",
    )
    app = create_setup_app(
        settings, tokens, audit, enroller, on_enrolled=lambda: events.append(True)
    )
    client = TestClient(app, base_url="http://agent", client=(CONSOLE_IP, 50000))
    client.headers["authorization"] = f"Bearer {token_file.read_text().strip()}"
    return client, events


ENROLL = {
    "host": "172.29.54.1",
    "port": 5001,
    "server_name": None,
    "fingerprint": FP,
    "username": "svc",
    "password": "secret-pw",
    "otp": None,
}


def test_waiting_agent_says_it_is_not_enrolled(tmp_path, store):
    c, _ = client_for(tmp_path, store, FakeDsmLogin())
    assert c.get("/healthz").json() == {"status": "ok", "enrolled": False}
    body = c.get("/v1/setup").json()
    assert body == {"enrolled": False, "dsm": {"host": "172.29.54.1", "port": 5001}}


def test_setup_needs_the_console_token(tmp_path, store):
    c, _ = client_for(tmp_path, store, FakeDsmLogin())
    del c.headers["authorization"]
    assert c.get("/v1/setup").status_code == 401


def test_setup_needs_the_setup_scope(tmp_path, store):
    tokens, _ = store
    c, _ = client_for(tmp_path, store, FakeDsmLogin())
    _, raw = tokens.create("lecture", ["system:read"], cidrs=[CIDR])
    c.headers["authorization"] = f"Bearer {raw}"
    assert c.get("/v1/setup").status_code == 403


def test_setup_refuses_an_unknown_host_name(tmp_path, store):
    c, _ = client_for(tmp_path, store, FakeDsmLogin())
    assert c.get("/v1/setup", headers={"host": "evil.example"}).status_code == 400


def test_certificate_is_read_for_confirmation(tmp_path, store):
    c, _ = client_for(tmp_path, store, FakeDsmLogin(), verifies=True)
    r = c.post(
        "/v1/setup/certificate", json={"host": "172.29.54.1", "port": 5001, "server_name": "nas"}
    )
    assert r.status_code == 200
    assert r.json() == {"fingerprint": FP, "verifies": True}


def test_enroll_writes_pinned_config_and_credentials_then_switches(tmp_path, store):
    login = FakeDsmLogin()
    c, events = client_for(tmp_path, store, login)
    r = c.post("/v1/setup/enroll", json=ENROLL)
    assert r.status_code == 200 and r.json() == {"enrolled": True, "tls_mode": "pin"}
    data = tmp_path / "data"
    config = tomllib.loads((data / "config.toml").read_text())
    assert config["dsm"] == {
        "host": "172.29.54.1",
        "port": 5001,
        "tls_mode": "pin",
        "tls_fingerprint": FP,
    }
    creds = load_credentials(data / "secrets" / "dsm.json")
    assert (creds.username, creds.password, creds.device_token) == ("svc", "secret-pw", "did-1")
    assert events == [True]
    assert c.post("/v1/setup/enroll", json=ENROLL).status_code == 409


def test_enroll_with_a_verified_certificate_uses_the_host_name(tmp_path, store):
    c, _ = client_for(tmp_path, store, FakeDsmLogin(), verifies=True)
    r = c.post("/v1/setup/enroll", json=dict(ENROLL, server_name="nas.example.org"))
    assert r.json()["tls_mode"] == "hostname"
    config = tomllib.loads((tmp_path / "data" / "config.toml").read_text())
    assert config["dsm"]["tls_server_name"] == "nas.example.org"


def test_enroll_refuses_a_changed_certificate(tmp_path, store):
    login = FakeDsmLogin()
    c, events = client_for(tmp_path, store, login, fingerprint="cd" * 32)
    r = c.post("/v1/setup/enroll", json=ENROLL)
    assert r.status_code == 409 and r.json()["code"] == "certificate_changed"
    assert login.calls == [] and events == []
    assert not (tmp_path / "data" / "config.toml").exists()


def test_enroll_asks_for_the_two_factor_code(tmp_path, store):
    login = FakeDsmLogin(otp="123456")
    c, events = client_for(tmp_path, store, login)
    r = c.post("/v1/setup/enroll", json=ENROLL)
    assert r.status_code == 400 and r.json()["code"] == "otp_required"
    assert events == []
    r = c.post("/v1/setup/enroll", json=dict(ENROLL, otp="123456"))
    assert r.status_code == 200 and events == [True]


def test_enroll_reports_the_dsm_refusal_in_words(tmp_path, store):
    c, events = client_for(tmp_path, store, FakeDsmLogin(SynologyDSMLoginInvalidException("svc")))
    r = c.post("/v1/setup/enroll", json=ENROLL)
    assert r.status_code == 400
    body = r.json()
    assert body["code"] == "login_failed" and "wrong password" in body["detail"]
    assert events == [] and not (tmp_path / "data" / "config.toml").exists()


def test_enroll_attempts_are_limited(tmp_path, store):
    errors = [SynologyDSMLoginInvalidException("svc")] * 5
    c, _ = client_for(tmp_path, store, FakeDsmLogin(*errors))
    codes = [c.post("/v1/setup/enroll", json=ENROLL).status_code for _ in range(4)]
    assert codes == [400, 400, 400, 429]


def test_enroll_is_journaled_without_the_password(tmp_path, store):
    _, audit = store
    c, _ = client_for(tmp_path, store, FakeDsmLogin())
    c.post("/v1/setup/enroll", json=ENROLL)
    entries = [e for e in audit.tail() if e.op == "agent.setup.enroll"]
    assert [e.outcome for e in entries] == ["ok"]
    assert "secret-pw" not in repr(entries)


def test_enroll_files_are_private(tmp_path, store):
    c, _ = client_for(tmp_path, store, FakeDsmLogin())
    c.post("/v1/setup/enroll", json=ENROLL)
    mode = os.stat(tmp_path / "data" / "secrets" / "dsm.json").st_mode & 0o777
    assert mode == 0o600


# Le choix au démarrage


def test_serve_waits_only_in_the_project_and_before_enrollment(tmp_path):
    from nas_agent.cli import serve_mode

    project = {"NAS_AGENT_CONSOLE_TOKEN_FILE": str(tmp_path / "console-token")}
    assert serve_mode(tmp_path, project, fixtures=None) == "setup"
    assert serve_mode(tmp_path, {}, fixtures=None) == "normal"
    assert serve_mode(tmp_path, project, fixtures=tmp_path) == "normal"
    (tmp_path / "secrets").mkdir()
    (tmp_path / "secrets" / "dsm.json").write_text("{}")
    (tmp_path / "config.toml").write_text("")
    assert serve_mode(tmp_path, project, fixtures=None) == "normal"


def test_enroll_says_when_the_address_is_not_dsm(tmp_path, store):
    c, events = client_for(
        tmp_path, store, FakeDsmLogin(SynologyDSMRequestException(ValueError("404")))
    )
    r = c.post("/v1/setup/enroll", json=ENROLL)
    assert r.status_code == 502 and r.json()["code"] == "not_dsm"
    assert events == []
