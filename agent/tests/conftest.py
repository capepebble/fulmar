import asyncio
import json
from pathlib import Path

import pytest

from nas_agent import relay as relay_module
from nas_agent.audit import AuditLog
from nas_agent.config import DsmSettings, Settings
from nas_agent.db import open_db
from nas_agent.tokens import Principal, TokenStore

FIXTURES = Path(__file__).parent / "fixtures" / "dsm"

# Les tests qui ont besoin des téléphones : sautés dans le moteur publié sans le chiffrement du
# relais, tant que l'ANSSI n'a pas classé Fulmar « grand public ».
needs_relay = pytest.mark.skipif(
    not relay_module.available(), reason="moteur sans le chiffrement du relais"
)


@pytest.fixture(autouse=True)
def _synology_offline(monkeypatch):
    """Aucun test ne joint www.synology.com : le lecteur par défaut échoue tout de suite."""
    import nas_agent.synology as synology

    async def offline(url: str) -> str:
        raise synology.FetchError("offline in tests")

    monkeypatch.setattr(synology, "http_fetch", offline)


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


class FakeDsm:
    """Faux DsmCaller : rend des réponses par « api.method », ou lève l'exception donnée.

    Une réponse peut être une fonction des paramètres de l'appel.
    """

    def __init__(self, responses=None, delay=0.0):
        self.responses = dict(responses or {})
        self.delay = delay
        self.calls: list[tuple[str, str, dict]] = []

    async def call(self, api, method, *, max_version, min_version=1, params=None):
        self.calls.append((api, method, dict(params or {})))
        await asyncio.sleep(self.delay)
        value = self.responses.get(f"{api}.{method}")
        if isinstance(value, BaseException):
            raise value
        if value is None:
            raise KeyError(f"pas de réponse factice pour {api}.{method}")
        return value(dict(params or {})) if callable(value) else value


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        dsm=DsmSettings(host="172.17.0.1", tls_mode="pin", tls_fingerprint="ab" * 32),
        data_dir=tmp_path,
        public_hosts=["nas-agent-test.example.ts.net"],
        # Les tests lisent les textes en français ; l'anglais, langue par défaut, a les siens.
        language="fr",
    )


@pytest.fixture
def conn(settings):
    return open_db(settings.db_path)


@pytest.fixture
def audit(conn) -> AuditLog:
    return AuditLog(conn)


@pytest.fixture
def tokens(conn) -> TokenStore:
    return TokenStore(conn)


def principal(*scopes: str, token_id: str = "tok00001") -> Principal:
    return Principal(token_id=token_id, label="test", scopes=frozenset(scopes))


@pytest.fixture
def relay_settings(settings) -> Settings:
    """Un agent configuré pour un relais (faux, en mémoire : fixture `fake`)."""
    from dataclasses import replace

    from nas_agent.config import RelaySettings

    return replace(settings, relay=RelaySettings(url="https://relay.test"))


@pytest.fixture
def fake():
    from tests.relay_fakes import FakeRelay

    return FakeRelay()
