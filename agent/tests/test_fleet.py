"""Plusieurs NAS dans le moteur (conception 2026-11-26-parc-du-moteur) : le hub ajoute un NAS par
l'adresse de son DSM, le sert sous /nas/<id>/, le reprend au démarrage et le retire."""

import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from synology_dsm.exceptions import SynologyDSMLoginInvalidException

from nas_agent.app_factory import build_runtime
from nas_agent.config import AuditThresholds
from nas_agent.dsm.credentials import load_credentials
from nas_agent.fleet import member_settings
from nas_agent.setup import MEMBER_SCOPES, Enroller, OtpRequired
from tests.conftest import FIXTURES

CIDR = "172.29.54.0/24"
CONSOLE = ("172.29.54.3", 50000)
HUB_FP = "ab" * 32  # celle du DSM du hub (conftest)
FPS = {"192.168.1.20": "cd" * 32, "192.168.1.30": "ef" * 32, "192.168.1.10": HUB_FP}
PASSWORD = "mot-de-passe-du-compte-de-service"


class FakeDsmLogin:
    """La connexion à DSM : un jeton d'appareil, ou l'exception donnée."""

    def __init__(self):
        self.calls: list[str] = []
        self.error: BaseException | None = None

    async def __call__(self, dsm, creds, otp):
        self.calls.append(dsm.host)
        if self.error is not None:
            raise self.error
        return "jeton-d-appareil"


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


def runtime_of(project, login):
    enroller = Enroller(
        fetch=lambda host, port: ("pem", FPS[host]),
        verifies=lambda host, port, name: False,
        login=login,
        gateway=lambda: "172.29.54.1",
    )
    return build_runtime(project, fixtures=FIXTURES, member_fixtures=FIXTURES, enroller=enroller)


def hub_headers(project):
    return {"Authorization": f"Bearer {project.console_token_file.read_text().strip()}"}


def member_headers(project, member_id):
    path = project.console_token_file.parent / "nas" / member_id
    return {"Authorization": f"Bearer {path.read_text().strip()}"}


def client_of(runtime):
    return TestClient(runtime.app, base_url="http://agent", client=CONSOLE)


def add(client, project, host="192.168.1.20", **extra):
    body = {
        "host": host,
        "port": 5001,
        "fingerprint": FPS.get(host, "00" * 32),
        "username": "svc-nas-agent",
        "password": PASSWORD,
        **extra,
    }
    return client.post("/v1/fleet", json=body, headers=hub_headers(project))


def test_added_nas_is_served_under_its_prefix_with_its_own_token(project, login):
    runtime = runtime_of(project, login)
    with client_of(runtime) as c:
        r = add(c, project)
        assert r.status_code == 201, r.text
        member_id = r.json()["nas"]["id"]
        assert r.json()["tls_mode"] == "pin" and len(member_id) == 8
        mine = member_headers(project, member_id)
        info = c.get(f"/nas/{member_id}/v1/system/info", headers=mine)
        assert info.status_code == 200 and info.json()["op"] == "system.info"
        # Chaque NAS a ses propres jetons : ni le hub ni le NAS ajouté ne s'ouvrent l'un l'autre.
        assert c.get("/v1/system/info", headers=mine).status_code == 401
        assert (
            c.get(f"/nas/{member_id}/v1/system/info", headers=hub_headers(project)).status_code
            == 401
        )
        # Son serveur MCP est sous le même préfixe.
        assert c.post(f"/nas/{member_id}/mcp", json={}).status_code == 401
        listed = c.get("/v1/fleet", headers=hub_headers(project)).json()
    assert listed["max"] == 50
    assert [(n["id"], n["host"], n["running"]) for n in listed["nas"]] == [
        (member_id, "192.168.1.20", True)
    ]
    assert login.calls == ["192.168.1.20"]

    directory = project.data_dir / "nas" / member_id
    creds = load_credentials(directory / "secrets" / "dsm.json")
    assert (creds.username, creds.password, creds.device_token) == (
        "svc-nas-agent",
        PASSWORD,
        "jeton-d-appareil",
    )
    assert member_settings(project, directory, member_id).dsm.host == "192.168.1.20"
    # La console lit la liste et le jeton dans le volume partagé, sans appeler l'agent.
    shared = project.console_token_file.parent
    manifest = json.loads((shared / "fleet.json").read_text())
    assert manifest == {
        "nas": [{k: listed["nas"][0][k] for k in ("id", "host", "port", "added_at")}]
    }
    assert oct((shared / "nas" / member_id).stat().st_mode & 0o777) == "0o600"
    # Arrêté avec le hub, à la sortie du client.
    assert runtime.fleet is not None and runtime.fleet.running(member_id) is False


def test_member_token_reads_and_pairs_but_does_not_manage(project, login):
    with client_of(runtime_of(project, login)) as c:
        member_id = add(c, project).json()["nas"]["id"]
        mine = member_headers(project, member_id)
        assert c.get("/v1/fleet", headers=mine).status_code == 401
    assert "fleet:manage" not in MEMBER_SCOPES and "agent:setup" not in MEMBER_SCOPES
    assert {"system:read", "audit:checks", "devices:pair"} <= MEMBER_SCOPES


def test_fleet_needs_the_fleet_right(project, login):
    runtime = runtime_of(project, login)
    _, raw = runtime.tokens.create("lecture", ["system:read"], cidrs=[CIDR])
    with client_of(runtime) as c:
        assert c.get("/v1/fleet").status_code == 401
        r = c.get("/v1/fleet", headers={"Authorization": f"Bearer {raw}"})
        assert r.status_code == 403 and r.json()["code"] == "forbidden"
        body = {"host": "192.168.1.20", "port": 5001}
        r = c.post("/v1/fleet/certificate", json=body, headers={"Authorization": f"Bearer {raw}"})
        assert r.status_code == 403


def test_certificate_is_read_as_at_setup(project, login):
    with client_of(runtime_of(project, login)) as c:
        r = c.post(
            "/v1/fleet/certificate",
            json={"host": "192.168.1.30", "port": 5001, "server_name": ""},
            headers=hub_headers(project),
        )
    assert r.status_code == 200 and r.json() == {"fingerprint": "ef" * 32, "verifies": False}


def test_hub_itself_and_a_nas_added_twice_are_refused(project, login):
    with client_of(runtime_of(project, login)) as c:
        # Le NAS du hub, par son adresse du réseau local : même certificat.
        r = add(c, project, host="192.168.1.10")
        assert r.status_code == 409 and r.json()["code"] == "already_followed"
        assert login.calls == []  # refusé avant toute connexion à DSM
        assert add(c, project).status_code == 201
        again = add(c, project)
        assert again.status_code == 409 and again.json()["code"] == "already_followed"
        assert len(c.get("/v1/fleet", headers=hub_headers(project)).json()["nas"]) == 1


def test_fleet_has_a_ceiling(project, login):
    with client_of(runtime_of(replace(project, fleet_max=1), login)) as c:
        assert add(c, project).status_code == 201
        r = add(c, project, host="192.168.1.30")
        assert r.status_code == 409 and r.json()["code"] == "fleet_full"


def test_refusals_of_dsm_are_said_and_attempts_limited(project, login):
    with client_of(runtime_of(project, login)) as c:
        login.error = OtpRequired()
        r = add(c, project)
        assert r.status_code == 400 and r.json()["code"] == "otp_required"
        login.error = SynologyDSMLoginInvalidException("svc-nas-agent")
        for _ in range(3):
            r = add(c, project)
            assert r.status_code == 400 and r.json()["code"] == "login_failed"
        r = add(c, project)
        assert r.status_code == 429 and r.json()["code"] == "rate_limited"
        listed = c.get("/v1/fleet", headers=hub_headers(project)).json()
    assert listed["nas"] == []
    assert not (project.data_dir / "nas").exists() or not any((project.data_dir / "nas").iterdir())


def test_changed_certificate_is_refused(project, login):
    with client_of(runtime_of(project, login)) as c:
        r = add(c, project, fingerprint="12" * 32)
    assert r.status_code == 409 and r.json()["code"] == "certificate_changed"
    assert login.calls == []


def test_address_with_foreign_characters_is_refused(project, login):
    with client_of(runtime_of(project, login)) as c:
        r = add(c, project, host='192.168.1.20"\n[relay]')
        assert r.status_code == 422
        r = c.post(
            "/v1/fleet/certificate",
            json={"host": "nas.local", "port": 5001, "server_name": "a b"},
            headers=hub_headers(project),
        )
        assert r.status_code == 422
    assert login.calls == []


def test_journal_notes_the_add_without_the_password(project, login):
    runtime = runtime_of(project, login)
    with client_of(runtime) as c:
        add(c, project)
    entries = [e for e in runtime.audit.tail(50) if e.op == "agent.fleet.add"]
    assert [e.outcome for e in entries] == ["ok"]
    assert entries[0].params["host"] == "192.168.1.20"
    assert PASSWORD not in json.dumps([e.params for e in runtime.audit.tail(200)])


def test_removed_nas_is_erased(project, login):
    runtime = runtime_of(project, login)
    with client_of(runtime) as c:
        member_id = add(c, project).json()["nas"]["id"]
        mine = member_headers(project, member_id)
        r = c.delete(f"/v1/fleet/{member_id}", headers=hub_headers(project))
        assert r.status_code == 204
        assert c.get(f"/nas/{member_id}/v1/system/info", headers=mine).status_code == 404
        again = c.delete(f"/v1/fleet/{member_id}", headers=hub_headers(project))
        assert again.status_code == 404 and again.json()["code"] == "not_found"
        assert c.delete("/v1/fleet/..", headers=hub_headers(project)).status_code == 404
    shared = project.console_token_file.parent
    assert not (project.data_dir / "nas" / member_id).exists()
    assert not (shared / "nas" / member_id).exists()
    assert json.loads((shared / "fleet.json").read_text()) == {"nas": []}
    removed = [e for e in runtime.audit.tail(50) if e.op == "agent.fleet.remove"]
    assert len(removed) == 1 and removed[0].params["id"] == member_id


def test_added_nas_come_back_after_a_restart(project, login):
    with client_of(runtime_of(project, login)) as c:
        member_id = add(c, project).json()["nas"]["id"]
    token = member_headers(project, member_id)
    with client_of(runtime_of(project, login)) as c:
        # Même jeton : il est valide, l'agent le garde.
        assert member_headers(project, member_id) == token
        assert c.get(f"/nas/{member_id}/v1/system/info", headers=token).status_code == 200


def test_a_member_that_cannot_start_stays_listed(project, login):
    with client_of(runtime_of(project, login)) as c:
        member_id = add(c, project).json()["nas"]["id"]
    (project.data_dir / "nas" / member_id / "config.toml").write_text("[dsm]\n")
    with client_of(runtime_of(project, login)) as c:
        listed = c.get("/v1/fleet", headers=hub_headers(project)).json()["nas"]
        assert [(n["id"], n["running"]) for n in listed] == [(member_id, False)]
        r = c.get(f"/nas/{member_id}/v1/system/info", headers=hub_headers(project))
        assert r.status_code == 404


def test_tokens_of_unknown_nas_are_removed(project, login):
    stale = project.console_token_file.parent / "nas" / "0badc0de"
    stale.parent.mkdir(parents=True)
    stale.write_text("nag_old\n")
    with client_of(runtime_of(project, login)):
        pass
    assert not stale.exists()


def test_member_settings_keep_the_hub_settings_but_dsm(project, login, tmp_path):
    hub = replace(project, audit=AuditThresholds(volume_warning_pct=70))
    with client_of(runtime_of(hub, login)) as c:
        member_id = add(c, hub).json()["nas"]["id"]
    own = member_settings(hub, hub.data_dir / "nas" / member_id, member_id)
    assert own.dsm.host == "192.168.1.20" and own.dsm.tls_fingerprint == "cd" * 32
    assert own.audit.volume_warning_pct == 70 and own.language == hub.language
    assert own.console_token_file is None
    assert own.data_dir == hub.data_dir / "nas" / member_id
    assert own.direct_urls == [f"https://agent/nas/{member_id}"]


def test_no_fleet_outside_the_engine_project(settings):
    runtime = build_runtime(settings, fixtures=FIXTURES)
    assert runtime.fleet is None
    _, raw = runtime.tokens.create("t", ["system:read"])
    with TestClient(runtime.app, base_url="http://127.0.0.1") as c:
        assert c.get("/v1/fleet", headers={"Authorization": f"Bearer {raw}"}).status_code == 404
