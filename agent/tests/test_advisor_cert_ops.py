from datetime import UTC, datetime

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

CONF = "SYNO.Core.SecurityScan.Conf.get"
STATUS = "SYNO.Core.SecurityScan.Status.system_get"
RULES = "SYNO.Core.SecurityScan.Status.rule_get"
CERTS = "SYNO.Core.Certificate.CRT.list"
NOW = datetime(2026, 11, 9, 7, 0, tzinfo=UTC)


def real(name):
    return load_fixture(f"ds420p_dsm741_{name}")


async def run(responses, audit, settings, op, *scopes):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings, wall_clock=lambda: NOW)
    p = principal(*(scopes or ("security:read",)))
    env = await engine.run(op, {}, p, channel="rest", client_ip=None)
    return env.data, dsm


def advisor_responses():
    return {
        CONF: real("advisor_conf"),
        STATUS: real("advisor_status"),
        RULES: real("advisor_rules"),
    }


# Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées : la forme qui fait foi.


async def test_advisor_real_ds420p_dsm741(audit, settings):
    data, dsm = await run(advisor_responses(), audit, settings, "security.advisor")
    assert data["status"] == "risk"
    assert data["scanning"] is False
    assert data["last_scan_at"] == "2026-11-09T06:39:26Z"
    assert data["group"] == "home"
    assert data["schedule"] == {"enabled": True, "week_day": "0", "hour": 9, "minute": 58}
    assert data["summary"] == {"rules": 31, "passed": 21, "failed": 2, "skipped": 8, "errors": 0}
    # Du plus grave au moins grave, comme l'interface de Security Advisor.
    assert data["failed_rules"] == [
        {"id": "ruleDB.Terminal.SSH.sshPortCheck", "category": "network", "severity": "risk"},
        {
            "id": "ruleDB.Update.DSM.enable_notification_v3",
            "category": "updates",
            "severity": "info",
        },
    ]
    network = next(c for c in data["categories"] if c["category"] == "network")
    assert network == {
        "category": "network",
        "status": "risk",
        "rules": 5,
        "failed": {"danger": 0, "risk": 1, "warning": 0, "out_of_date": 0, "info": 0},
    }
    assert [c["category"] for c in data["categories"]] == [
        "malware",
        "network",
        "system",
        "updates",
        "accounts",
    ]
    rules_call = next(c for c in dsm.calls if c[1] == "rule_get")
    assert rules_call[2] == {"items": "ALL"}


async def test_advisor_few_rules_are_visible(audit, settings):
    # Groupe « personnalisé » d'origine du NAS d'essai : 2 règles sur 48, statut « sûr ».
    responses = advisor_responses()
    responses[CONF] = {**responses[CONF], "defaultGroup": "custom"}
    kept = ("ruleDB.User.Availability.disable_admin", "ruleDB.User.Password.top50000StrengthCheck")
    rules = responses[RULES]["items"]
    responses[RULES] = {"items": {k: rules[k] for k in kept}}
    data, _ = await run(responses, audit, settings, "security.advisor")
    assert data["group"] == "custom"
    assert data["summary"] == {"rules": 2, "passed": 2, "failed": 0, "skipped": 0, "errors": 0}


async def test_advisor_never_scanned_or_running(audit, settings):
    responses = {
        CONF: {},
        STATUS: {"sysStatus": "firstScan", "sysProgress": 40, "lastScanTime": ""},
        RULES: {"isUpdating": True},
    }
    data, _ = await run(responses, audit, settings, "security.advisor")
    assert (data["status"], data["scanning"], data["last_scan_at"]) == ("firstScan", True, None)
    assert data["summary"] == {"rules": 0, "passed": 0, "failed": 0, "skipped": 0, "errors": 0}
    assert data["categories"] == [] and data["failed_rules"] == []


async def test_advisor_needs_security_read(audit, settings):
    with pytest.raises(OpError) as info:
        await run(advisor_responses(), audit, settings, "security.advisor", "system:read")
    assert info.value.status == 403


async def test_certificates_real_ds420p_dsm741(audit, settings):
    data, dsm = await run({CERTS: real("certificate_list")}, audit, settings, "certificates.list")
    assert data["summary"] == {"total": 1, "expired": 0, "expiring_within_30_days": 0}
    assert data["certificates"] == [
        {
            "id": "da11rP",
            "description": None,
            "common_name": "synology",
            "alt_names": ["synology"],
            "issuer": "Synology Inc. CA",
            "self_signed": True,
            "is_default": True,
            "renewable": False,
            "broken": False,
            "valid_from": "2026-11-06T11:56:52Z",
            "valid_until": "2027-11-07T11:56:52Z",
            "expires_in_days": 363,
            "expired": False,
            "services": [
                "KMIP",
                "FTPS",
                "DSM Desktop Service",
                "Synology Storage Console Server",
            ],
        }
    ]
    assert dsm.calls == [("SYNO.Core.Certificate.CRT", "list", {})]


async def test_certificates_expiring_and_expired(audit, settings):
    def cert(cid, until, **extra):
        return {
            "id": cid,
            "subject": {"common_name": "nas.example.org"},
            "issuer": {"common_name": "R11", "organization": "Let's Encrypt"},
            "valid_till": until,
            **extra,
        }

    responses = {
        CERTS: {
            "certificates": [
                cert("a", "Nov 20 10:00:00 2026 GMT", renewable=True),
                cert("b", "Nov  1 10:00:00 2026 GMT"),
                cert("c", "pas une date"),
            ]
        }
    }
    data, _ = await run(responses, audit, settings, "certificates.list")
    a, b, c = data["certificates"]
    assert (a["expires_in_days"], a["expired"], a["self_signed"]) == (11, False, False)
    assert (b["expires_in_days"], b["expired"]) == (-8, True)
    assert (c["valid_until"], c["expires_in_days"], c["expired"]) == (None, None, None)
    assert data["summary"] == {"total": 3, "expired": 1, "expiring_within_30_days": 1}


def test_advisor_and_certificates_scopes_and_verification():
    catalog = build_catalog()
    for op_id in ("security.advisor", "certificates.list"):
        op = catalog.get(op_id)
        assert op.scope == "security:read" and op.kind == "read" and not op.personal
        assert "DS420+" in (op.verified_on or "")
