"""Les surfaces publiques de l'agent parlent anglais : OpenAPI, outils MCP, erreurs et ligne de
commande (conception du moteur en anglais, section 3). Les verdicts et les alertes, eux, existent
dans les deux langues (test_i18n)."""

import argparse
import re

import pytest
from fastapi.testclient import TestClient

from nas_agent.app_factory import build_runtime
from nas_agent.catalog.ops import build_catalog
from nas_agent.cli import _parser
from nas_agent.mcp_server import INSTRUCTIONS, tool_for
from nas_agent.tokens import KNOWN_SCOPES
from tests.conftest import FIXTURES

# Accents, guillemets et mots courants du français ; aucun n'a sa place dans un texte anglais.
FRENCH = re.compile(
    r"[éèêàùçôîûâëœ«»]|\b(le|la|les|des|du|une|est|pour|sur|aucun|aucune|avec|sans|ou|et|dans|"
    r"par|qui|que|cette|chaque|jeton|lecture|selon|heure|jours|absent|faux|nombre|compte|"
    r"comptes|dernier|dernière|tâche|tâches|réglage|activé|coupé)\b",
    re.IGNORECASE,
)


def _french(texts):
    return [t for t in texts if isinstance(t, str) and FRENCH.search(t)]


def _described(node, keys=("description", "summary", "title")):
    """Les textes d'un document JSON (OpenAPI, schéma) rangés sous ces clés."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in keys and isinstance(value, str):
                yield value
            yield from _described(value, keys)
    elif isinstance(node, list):
        for value in node:
            yield from _described(value, keys)


@pytest.fixture
def full(settings):
    runtime = build_runtime(settings, fixtures=FIXTURES)
    _, raw = runtime.tokens.create("t", sorted(KNOWN_SCOPES))
    with TestClient(runtime.app, base_url="http://127.0.0.1") as c:
        yield c, {"Authorization": f"Bearer {raw}"}


def test_openapi_is_english(full):
    client, auth = full
    doc = client.get("/v1/openapi.json", headers=auth).json()
    assert _french(_described(doc)) == []


def test_operation_list_is_english(full):
    client, auth = full
    ops = client.get("/v1/ops", headers=auth).json()
    assert len(ops) == len(build_catalog())
    assert _french(t for op in ops for t in (op["title"], op["description"])) == []


def test_mcp_tools_are_english():
    assert not FRENCH.search(INSTRUCTIONS)
    for op in build_catalog():
        tool = tool_for(op).model_dump(mode="json", by_alias=True)
        assert _french(_described(tool)) == [], op.id


def test_errors_are_english(full):
    client, auth = full
    replies = [
        client.get("/v1/system/info"),
        client.get("/v1/system/info", headers={"Authorization": "Bearer nag_x_y"}),
        client.get("/v1/nothing-here", headers=auth),
        client.get("/v1/agent/audit?limit=0", headers=auth),
        client.post("/v1/system/info", headers=auth),
    ]
    details = [r.json()["detail"] for r in replies]
    assert all(r.status_code >= 400 for r in replies)
    assert _french(details) == [], details


def _help_texts(parser: argparse.ArgumentParser):
    yield parser.format_help()
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for sub in action.choices.values():
                yield from _help_texts(sub)


def test_command_line_help_is_english():
    assert _french(_help_texts(_parser())) == []
