import time
from dataclasses import replace

from fastapi.testclient import TestClient

from nas_agent.app_factory import build_runtime
from nas_agent.config import HistorySettings
from tests.conftest import FIXTURES


def wait_for_series(client, headers, timeout=3.0):
    deadline = time.monotonic() + timeout
    while True:
        body = client.get("/v1/metrics/history?tier=1m", headers=headers).json()
        if body["data"]["series"] or time.monotonic() > deadline:
            return body["data"]
        time.sleep(0.05)


def test_serve_samples_at_start_and_serves_the_history(settings):
    runtime = build_runtime(settings, fixtures=FIXTURES)
    _, raw = runtime.tokens.create("test", ["system:read", "storage:read"])
    h = {"Authorization": f"Bearer {raw}"}
    with TestClient(runtime.app, base_url="http://127.0.0.1") as c:
        data = wait_for_series(c, h)
        assert data["sampling"]["running"] is True
    by = {(s["metric"], s["subject"]): s for s in data["series"]}
    # Réponses enregistrées de tests/fixtures/dsm (index.json).
    assert by[("cpu_pct", None)]["latest"]["value"] == 9.0
    assert by[("temperature_c", None)]["latest"]["value"] == 40.0
    assert by[("disk_temperature_c", "sdb")]["latest"]["value"] == 58.0
    assert settings.history_path.exists()
    assert runtime.history is not None and runtime.history.status.running is False
    starts = [e for e in runtime.audit.tail(20) if e.op == "metrics.sampler"]
    assert len(starts) == 1 and starts[0].channel == "internal"


def test_serve_without_history(settings):
    runtime = build_runtime(
        replace(settings, history=HistorySettings(enabled=False)), fixtures=FIXTURES
    )
    _, raw = runtime.tokens.create("test", ["system:read"])
    with TestClient(runtime.app, base_url="http://127.0.0.1") as c:
        body = c.get("/v1/metrics/history", headers={"Authorization": f"Bearer {raw}"}).json()
    assert body["data"]["sampling"]["enabled"] is False and body["data"]["series"] == []
    assert not settings.history_path.exists()
    assert all(e.op != "metrics.sampler" for e in runtime.audit.tail(20))


def test_project_agent_keeps_the_console_token_and_says_it_is_enrolled(settings, tmp_path):
    # Moteur installable (conception 2026-11-25) : jeton de la console tenu à jour au
    # démarrage, et « enrôlé » pour la console.
    token_file = tmp_path / "shared" / "console-token"
    project = replace(settings, console_token_file=token_file, console_cidrs=["172.29.54.0/24"])
    runtime = build_runtime(project, fixtures=FIXTURES)
    raw = token_file.read_text().strip()
    with TestClient(runtime.app, base_url="http://127.0.0.1", client=("172.29.54.3", 50000)) as c:
        r = c.get("/v1/setup", headers={"Authorization": f"Bearer {raw}"})
        assert r.status_code == 200 and r.json() == {"enrolled": True}
        assert c.get("/v1/setup").status_code == 401
