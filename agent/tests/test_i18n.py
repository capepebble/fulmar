"""Langues des textes de l'agent (conception du moteur en anglais, 2026-11-25)."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from nas_agent.app_factory import build_runtime
from nas_agent.config import ConfigError, load_settings
from nas_agent.i18n import pick_lang, requested_lang
from tests.conftest import FIXTURES


@pytest.mark.parametrize(
    ("header", "lang"),
    [
        ("fr-FR,fr;q=0.9,en;q=0.8", "fr"),
        ("en-US,en;q=0.9", "en"),
        ("de-DE,fr;q=0.5,en;q=0.7", "en"),
        ("de-DE,fr;q=0.5", "fr"),
        ("es", "en"),
        ("", "en"),
        (None, "en"),
        ("fr;q=0", "en"),
    ],
)
def test_pick_lang_follows_the_weights(header, lang):
    assert pick_lang(header) == lang


def test_no_known_language_means_the_agent_decides():
    assert requested_lang("de-DE,es;q=0.8") is None
    assert requested_lang(None) is None
    assert requested_lang("fr-CA") == "fr"


def test_language_setting(tmp_path):
    base = tmp_path / "config.toml"
    base.write_text('[dsm]\nhost = "h"\ntls_mode = "pin"\ntls_fingerprint = "' + "ab" * 32 + '"\n')
    assert load_settings(base, env={}).language == "en"
    assert load_settings(base, env={"NAS_AGENT_LANGUAGE": "fr"}).language == "fr"
    with pytest.raises(ConfigError):
        load_settings(base, env={"NAS_AGENT_LANGUAGE": "de"})


FRENCH = ("é", "è", "à ", "«", " sur ", " aucun", "Aucun")


def _checks(client, token, lang=None):
    headers = {"Authorization": f"Bearer {token}"}
    if lang:
        headers["Accept-Language"] = lang
    r = client.get("/v1/audit/checks", headers=headers)
    assert r.status_code == 200
    return {c["id"]: c for c in r.json()["data"]["checks"]}


def test_checks_follow_the_language_of_the_request(settings):
    runtime = build_runtime(settings, fixtures=FIXTURES)  # agent réglé en français
    _, raw = runtime.tokens.create("t", ["audit:checks"])
    with TestClient(runtime.app, base_url="http://127.0.0.1") as c:
        fr = _checks(c, raw)
        en = _checks(c, raw, "en-US,en;q=0.9")
        assert _checks(c, raw, "fr-FR") == fr
    assert fr.keys() == en.keys()
    for check_id, check in en.items():
        assert check["status"] == fr[check_id]["status"]
        for field in ("title", "observed", "expected", "advice"):
            text = check[field] or ""
            assert not any(mark in text for mark in FRENCH), (check_id, field, text)


def test_the_agent_language_applies_without_a_request_language(settings):
    runtime = build_runtime(replace(settings, language="en"), fixtures=FIXTURES)
    _, raw = runtime.tokens.create("t", ["audit:checks"])
    with TestClient(runtime.app, base_url="http://127.0.0.1") as c:
        checks = _checks(c, raw, "de-DE")
    assert checks["access.ssh"]["title"] == "SSH"
    assert checks["updates.dsm"]["title"] == "DSM up to date"
    assert checks["storage.disks"]["expected"] == "Healthy disks (normal state and SMART)."
