"""Carte sur table (conception 2026-11-26-carte-sur-table) : agent.access montre ce que Fulmar
fait sur le NAS sans secret ni adresse d'appelant ; agent.detach le détache du moteur."""

import json
import sys
import types
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from nas_agent.updates import UpdateService
from tests.conftest import needs_relay
from tests.test_fleet import (
    CIDR,
    CONSOLE,
    FakeDsmLogin,
    add,
    client_of,
    hub_headers,
    member_headers,
    runtime_of,
)


@pytest.fixture
def login():
    return FakeDsmLogin()


@pytest.fixture
def project(settings, tmp_path):
    return replace(
        settings,
        console_token_file=tmp_path / "shared" / "console-token",
        console_cidrs=[CIDR],
        public_hosts=["agent"],
    )


def a_phone(runtime, name="iPhone de test"):
    from nas_agent.relay import protocol as p

    k = p.KeyPair.generate()
    runtime.relay.store.add_device(
        k.id, k.sign_public, k.box_public, name, "direct", datetime.now(UTC), 0
    )
    return k.id


def fake_credentials(project):
    path = project.credentials_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"username": "fulmar", "password": "x"}))
    return path


@needs_relay
def test_access_shows_everything_but_secrets_and_caller_addresses(project, login):
    runtime = runtime_of(project, login)
    _info, claude = runtime.tokens.create("claude-mcp", ["system:read"], cidrs=["100.64.0.0/10"])
    a_phone(runtime)
    with client_of(runtime) as c:
        c.get("/v1/system/info", headers=hub_headers(project))
        r = c.get("/v1/agent/access", headers=hub_headers(project))
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["dsm"]["host"] == project.dsm.host and data["dsm"]["tls_mode"] == "pin"
    labels = {t["label"]: t for t in data["tokens"]}
    assert set(labels) == {"console-projet", "claude-mcp"}
    assert labels["console-projet"]["changes_dsm"] is True
    assert labels["claude-mcp"]["changes_dsm"] is False
    assert labels["claude-mcp"]["networks"] == ["100.64.0.0/10"]
    assert labels["console-projet"]["last_used_at"] is not None
    assert {w["scope"] for w in data["writes"]} == {"packages:update", "dsm:update", "access:close"}
    assert data["reads"]["system:read"] > 0 and "packages:update" not in data["reads"]
    assert data["phones"] == 1
    assert data["outbound"] == [{"to": "www.synology.com", "why": "synology_advisories"}]
    assert data["fleet_members"] == 0
    assert data["can_detach"] is True and data["journal_ok"] is True
    lines = [e for e in data["journal"] if e["op"] == "system.info"]
    assert lines and lines[0]["token"] == "console-projet"
    # Jamais un secret, jamais l'adresse d'un appelant.
    text = r.text
    console_secret = project.console_token_file.read_text().strip()
    assert console_secret.split("_")[-1] not in text and claude.split("_")[-1] not in text
    assert CONSOLE[0] not in text and "secret_hash" not in text and "client_ip" not in text


def test_a_read_token_sees_the_table_but_cannot_detach(project, login):
    runtime = runtime_of(project, login)
    _info, raw = runtime.tokens.create("lecture", ["system:read"], cidrs=[])
    headers = {"Authorization": f"Bearer {raw}"}
    with client_of(runtime) as c:
        data = c.get("/v1/agent/access", headers=headers).json()["data"]
        assert data["can_detach"] is False
        assert c.post("/v1/agent/detach", headers=headers).status_code == 403
    assert not runtime.control.detached


@needs_relay
def test_detach_removes_phones_tokens_and_credentials_then_stops(project, login):
    runtime = runtime_of(project, login)
    _info, claude = runtime.tokens.create("claude-mcp", ["system:read"])
    a_phone(runtime)
    a_phone(runtime, "iPad")
    creds = fake_credentials(project)
    stopped: list[bool] = []
    runtime.control.stop = lambda: stopped.append(True)
    with client_of(runtime) as c:
        r = c.post("/v1/agent/detach", headers=hub_headers(project))
        assert r.status_code == 200, r.text
        assert r.json()["data"] == {
            "phones_removed": 2,
            "tokens_revoked": 1,
            "credentials_removed": True,
            "restarting": True,
        }
        # Le jeton de Claude n'ouvre plus rien ; celui de la console, si (l'attente le reprend).
        assert (
            c.get("/v1/system/info", headers={"Authorization": f"Bearer {claude}"}).status_code
            == 401
        )
        assert c.get("/v1/agent/access", headers=hub_headers(project)).status_code == 200
    assert not creds.exists() and runtime.control.detached and stopped == [True]
    assert runtime.relay.devices() == []
    detach = [e for e in runtime.audit.tail(50) if e.op == "agent.detach"]
    assert [e.outcome for e in detach] == ["ok"]


def test_detach_is_refused_while_nas_are_added_to_the_hub(project, login):
    runtime = runtime_of(project, login)
    creds = fake_credentials(project)
    with client_of(runtime) as c:
        member_id = add(c, project).json()["nas"]["id"]
        assert (
            c.get("/v1/agent/access", headers=hub_headers(project)).json()["data"]["fleet_members"]
            == 1
        )
        r = c.post("/v1/agent/detach", headers=hub_headers(project))
        assert r.status_code == 409 and r.json()["code"] == "fleet_not_empty"
        # Un NAS ajouté se retire par « Retirer du parc » : son propre jeton ne détache rien.
        mine = member_headers(project, member_id)
        data = c.get(f"/nas/{member_id}/v1/agent/access", headers=mine).json()["data"]
        assert data["can_detach"] is False and data["fleet_members"] is None
        assert c.post(f"/nas/{member_id}/v1/agent/detach", headers=mine).status_code == 403
    assert creds.exists() and not runtime.control.detached


def test_detach_is_refused_while_an_update_runs(project, login, monkeypatch):
    monkeypatch.setattr(UpdateService, "busy", property(lambda self: True))
    runtime = runtime_of(project, login)
    creds = fake_credentials(project)
    with client_of(runtime) as c:
        r = c.post("/v1/agent/detach", headers=hub_headers(project))
    assert r.status_code == 409 and r.json()["code"] == "update_running"
    assert creds.exists() and not runtime.control.detached


def test_detach_cancels_the_waiting_schedules(project, login):
    runtime = runtime_of(project, login)
    updates = runtime.engine.updates
    at = datetime.now(UTC) + timedelta(days=1)
    item = updates.schedule("dsm", [], at, False, by="tok00001")
    with client_of(runtime) as c:
        assert c.post("/v1/agent/detach", headers=hub_headers(project)).status_code == 200
    assert updates.find(item.id).state == "cancelled"


def test_detach_is_not_offered_outside_the_engine_project(settings, tmp_path):
    from fastapi.testclient import TestClient

    from nas_agent.app_factory import build_runtime
    from tests.conftest import FIXTURES

    runtime = build_runtime(settings, fixtures=FIXTURES)
    _info, raw = runtime.tokens.create("tout", ["system:read", "agent:setup"])
    headers = {"Authorization": f"Bearer {raw}"}
    with TestClient(runtime.app, base_url=f"http://{settings.public_hosts[0]}") as c:
        assert c.get("/v1/agent/access", headers=headers).json()["data"]["can_detach"] is False
        r = c.post("/v1/agent/detach", headers=headers)
    assert r.status_code == 409 and r.json()["code"] == "not_offered"


def test_credentials_are_not_written_again_once_detached(project, tmp_path):
    from nas_agent.app_factory import build_runtime
    from nas_agent.dsm.credentials import DsmCredentials, save_credentials

    save_credentials(project.credentials_path, DsmCredentials("fulmar", "x"))
    runtime = build_runtime(project)
    runtime.control.detached = True
    project.credentials_path.unlink()
    # Une connexion à DSM encore en cours rend un jeton d'appareil : il n'est plus gardé.
    runtime.engine._dsm._on_device_token("jeton-tardif")
    assert not project.credentials_path.exists()
    runtime.close()


# Le serveur : détaché, il revient en attente d'installation, sans redémarrer le conteneur.


class FakeRuntime:
    def __init__(self, on_run):
        from nas_agent.access import Control

        self.app = object()
        self.control = Control()
        self.on_run = on_run
        self.closed = False

    def close(self):
        self.closed = True


def serve_with(monkeypatch, tmp_path, settings, on_run):
    import nas_agent.app_factory as app_factory
    import nas_agent.cli as cli

    (tmp_path / "secrets").mkdir(exist_ok=True)
    (tmp_path / "secrets" / "dsm.json").write_text("{}")
    (tmp_path / "config.toml").write_text("")
    monkeypatch.setenv("NAS_AGENT_CONSOLE_TOKEN_FILE", str(tmp_path / "shared" / "token"))
    runtimes: list[FakeRuntime] = []
    waits: list[bool] = []

    def build(_settings, fixtures=None):
        runtimes.append(FakeRuntime(on_run))
        return runtimes[-1]

    class Server:
        def __init__(self, config):
            self.runtime = runtimes[-1]
            self.should_exit = False

        def run(self):
            self.runtime.on_run(self.runtime, tmp_path)

    fake = types.ModuleType("uvicorn")
    fake.Server = Server  # type: ignore[attr-defined]
    fake.Config = lambda app, **kw: (app, kw)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "uvicorn", fake)
    monkeypatch.setattr(app_factory, "build_runtime", build)
    monkeypatch.setattr(cli, "load_settings", lambda path, env: settings)
    monkeypatch.setattr(cli, "_wait_for_enrollment", lambda env: waits.append(True) or False)
    code = cli._serve(tmp_path, None)
    return code, runtimes, waits


def test_serve_goes_back_to_waiting_once_detached(monkeypatch, tmp_path, settings):
    def detach(runtime, data_dir: Path):
        (data_dir / "secrets" / "dsm.json").unlink()
        runtime.control.detached = True

    code, runtimes, waits = serve_with(monkeypatch, tmp_path, settings, detach)
    assert code == 0 and len(runtimes) == 1 and runtimes[0].closed
    # L'attente d'installation reprend (ici arrêtée avant qu'on l'enrôle).
    assert waits == [True]


def test_serve_simply_ends_when_stopped(monkeypatch, tmp_path, settings):
    code, runtimes, waits = serve_with(monkeypatch, tmp_path, settings, lambda r, d: None)
    assert code == 0 and len(runtimes) == 1 and waits == []


def test_no_outbound_when_advisories_are_off(project, login):
    from nas_agent.config import SynologySettings

    runtime = runtime_of(replace(project, synology=SynologySettings(enabled=False)), login)
    with client_of(runtime) as c:
        data = c.get("/v1/agent/access", headers=hub_headers(project)).json()["data"]
    assert data["outbound"] == []


def test_a_read_token_sees_only_itself_and_its_own_calls(project, login):
    """Sans agent:setup ni audit:read, ni les autres jetons ni leurs appels : ce que garde
    agent.audit (droit audit:read) ne s'ouvre pas par system:read."""
    runtime = runtime_of(project, login)
    _info, raw = runtime.tokens.create("lecture", ["system:read"], cidrs=[CIDR])
    runtime.tokens.create("autre", ["system:read"], cidrs=["192.168.0.0/16"])
    headers = {"Authorization": f"Bearer {raw}"}
    with client_of(runtime) as c:
        c.get("/v1/system/info", headers=hub_headers(project))
        c.get("/v1/system/info", headers=headers)
        r = c.get("/v1/agent/access", headers=headers)
    data = r.json()["data"]
    assert [t["label"] for t in data["tokens"]] == ["lecture"]
    assert data["tokens_others"] == 2 and data["journal_all"] is False
    assert {line["token"] for line in data["journal"]} == {"lecture"}
    assert "192.168.0.0/16" not in r.text and "console-projet" not in r.text


def test_the_installer_sees_every_token_and_call(project, login):
    runtime = runtime_of(project, login)
    runtime.tokens.create("autre", ["system:read"])
    with client_of(runtime) as c:
        data = c.get("/v1/agent/access", headers=hub_headers(project)).json()["data"]
    assert data["tokens_others"] == 0 and data["journal_all"] is True
    assert {t["label"] for t in data["tokens"]} == {"console-projet", "autre"}
