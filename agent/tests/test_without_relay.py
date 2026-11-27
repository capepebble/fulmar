"""Le moteur sans le chiffrement du relais : tant que l'ANSSI n'a pas classé Fulmar « grand
public », le moteur publié dans le monde ne porte ni PyNaCl ni le code du relais. Il doit alors
tourner comme avant, relais en moins : lectures, alertes du moteur, console ; les téléphones et
la lecture directe répondent qu'ils ne sont pas là."""

import json
import subprocess
import sys
from pathlib import Path

from tests.conftest import FIXTURES, needs_relay

AGENT = Path(__file__).resolve().parents[1]

SCRIPT = r"""
import json, sys
from pathlib import Path

# PyNaCl absent, comme dans l'image publique : tout `import nacl` lève ImportError.
sys.modules["nacl"] = None

from fastapi.testclient import TestClient

from nas_agent import relay
from nas_agent.app_factory import build_runtime
from nas_agent.catalog.ops import build_catalog
from nas_agent.config import DsmSettings, NotifySettings, NtfySettings, Settings

data, fixtures = Path(sys.argv[1]), Path(sys.argv[2])
settings = Settings(
    dsm=DsmSettings(host="172.17.0.1", tls_mode="pin", tls_fingerprint="ab" * 32),
    data_dir=data,
    public_hosts=["nas-agent-test.example.ts.net"],
    notify=NotifySettings(ntfy=NtfySettings(url="https://ntfy.example.org/fulmar-test")),
)
rt = build_runtime(settings, fixtures=fixtures)
_, raw = rt.tokens.create("t", ["system:read", "devices:pair"])
h = {"Authorization": f"Bearer {raw}"}
devices = build_catalog().get("devices.list").path
with TestClient(rt.app, base_url="http://127.0.0.1") as c:
    out = {
        "available": relay.available(),
        "runtime_relay": rt.relay is None,
        "notify": rt.notify is not None,
        "info": c.get("/v1/system/info", headers=h).status_code,
        "devices": c.get(f"/v1{devices}", headers=h).status_code,
        "direct": c.get("/v1/direct/state").status_code,
    }
from nas_agent.cli import _parser
out["cli_relay"] = "relay" in _parser().format_help()
out["loaded"] = sorted(
    m for m in sys.modules
    if m.split(".")[0] == "nacl" and sys.modules[m] is not None
    or m in ("nas_agent.relay.protocol", "nas_agent.relay.service", "nas_agent.relay.identity",
             "nas_agent.relay.direct", "nas_agent.relay.cli", "nas_agent.relay.demo")
)
print(json.dumps(out))
"""


def run_without_nacl(tmp_path) -> dict:
    # Arguments fixés par le test : l'interpréteur de l'agent et deux chemins du test.
    done = subprocess.run(  # noqa: S603
        [sys.executable, "-c", SCRIPT, str(tmp_path), str(FIXTURES)],
        cwd=AGENT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr[-3000:]
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_the_engine_runs_without_the_relay_crypto(tmp_path):
    out = run_without_nacl(tmp_path)
    assert out["available"] is False
    # Aucun module du chiffrement chargé : ni PyNaCl, ni le protocole, ni le service du relais.
    assert out["loaded"] == []
    assert out["runtime_relay"] is True
    # Les lectures et les alertes du moteur restent là.
    assert out["info"] == 200
    assert out["notify"] is True
    # Les téléphones disent qu'ils ne sont pas là ; la lecture directe n'existe pas.
    assert out["devices"] == 501
    assert out["direct"] == 404
    # La ligne de commande n'offre pas `nas-agent relay`.
    assert out["cli_relay"] is False


@needs_relay
def test_the_relay_is_there_when_nacl_is(settings):
    from nas_agent import relay
    from nas_agent.app_factory import build_runtime

    assert relay.available() is True
    runtime = build_runtime(settings, fixtures=FIXTURES)
    assert runtime.relay is not None
