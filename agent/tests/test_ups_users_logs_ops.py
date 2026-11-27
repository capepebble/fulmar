import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

UPS = "SYNO.Core.ExternalDevice.UPS.get"
USERS = "SYNO.Core.User.list"
ADMINS = "SYNO.Core.Group.Member.list"
LOGS = "SYNO.Core.SyslogClient.Log.list"


def real(name):
    return load_fixture(f"ds420p_dsm741_{name}")


async def run(responses, audit, settings, op, *scopes, service_account="claude", **params):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings, service_account=service_account)
    p = principal(*(scopes or ("system:read", "personal:read")))
    env = await engine.run(op, params, p, channel="rest", client_ip=None)
    return env.data, dsm


# Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées : la forme qui fait foi.


async def test_ups_real_ds420p_dsm741_not_configured(audit, settings):
    data, dsm = await run({UPS: real("ups_get")}, audit, settings, "ups.status")
    assert data == {
        "enabled": False,
        "mode": None,
        "status": "unknown",
        "on_battery": None,
        "charge_percent": None,
        "runtime_seconds": None,
        "manufacturer": None,
        "model": None,
        "usb_detected": False,
        "network_server": None,
    }
    assert dsm.calls == [("SYNO.Core.ExternalDevice.UPS", "get", {})]


async def test_ups_usb_online_and_on_battery(audit, settings):
    # Forme du NAS d'essai, valeurs d'un onduleur USB branché (le NAS d'essai n'en a pas).
    online = {
        **real("ups_get"),
        "enable": True,
        "mode": "USB",
        "status": "usb_ups_status_online",
        "charge": 100,
        "runtime": 1800,
        "manufacture": "EATON",
        "model": "Ellipse PRO 650",
        "usb_ups_connect": True,
        "snmp_community": "secret",
    }
    data, _ = await run({UPS: online}, audit, settings, "ups.status")
    assert (data["enabled"], data["mode"], data["status"], data["on_battery"]) == (
        True,
        "usb",
        "online",
        False,
    )
    assert (data["charge_percent"], data["runtime_seconds"]) == (100, 1800)
    assert (data["manufacturer"], data["model"]) == ("EATON", "Ellipse PRO 650")
    assert "secret" not in str(data)

    battery = {**online, "status": "usb_ups_status_low_batt", "charge": 12, "runtime": -1}
    data, _ = await run({UPS: battery}, audit, settings, "ups.status")
    assert (data["status"], data["on_battery"]) == ("low_battery", True)
    assert (data["charge_percent"], data["runtime_seconds"]) == (12, None)


async def test_ups_network_client(audit, settings):
    client = {**real("ups_get"), "enable": True, "mode": "SLAVE", "net_server_ip": "192.0.2.9"}
    data, _ = await run({UPS: client}, audit, settings, "ups.status")
    assert (data["mode"], data["network_server"]) == ("network", "192.0.2.9")


def user_responses():
    return {USERS: real("user_list"), ADMINS: real("admin_members")}


async def test_users_real_ds420p_dsm741(audit, settings):
    data, dsm = await run(user_responses(), audit, settings, "users.list")
    assert data["summary"] == {
        "total": 4,
        "active": 2,
        "active_admins": 2,
        "admins_without_two_factor": 1,
        "builtin_admin_enabled": False,
        "guest_enabled": False,
    }
    assert data["accounts"] == [
        {
            "name": "admin",
            "admin": True,
            "disabled": True,
            "expires_on": None,
            "two_factor": False,
            "agent_account": False,
        },
        {
            "name": "utilisateur",
            "admin": True,
            "disabled": False,
            "expires_on": None,
            "two_factor": False,
            "agent_account": False,
        },
        {
            "name": "claude",
            "admin": True,
            "disabled": False,
            "expires_on": None,
            "two_factor": False,
            "agent_account": True,
        },
        {
            "name": "guest",
            "admin": False,
            "disabled": True,
            "expires_on": None,
            "two_factor": False,
            "agent_account": False,
        },
    ]
    # Ni adresse de messagerie ni description : seulement ce que demandent les contrôles.
    users_call = next(c for c in dsm.calls if c[0] == "SYNO.Core.User")
    assert users_call[2]["additional"] == '["expired","2fa_status"]'
    admins_call = next(c for c in dsm.calls if c[0] == "SYNO.Core.Group.Member")
    assert admins_call[2]["group"] == '"administrators"'


async def test_users_expiry_date_and_unknown_state(audit, settings):
    responses = {
        USERS: {
            "users": [
                {"name": "a", "expired": "2027/03/31", "2fa_status": True},
                {"name": "b", "expired": "bizarre"},
                {"expired": "normal"},
            ]
        },
        ADMINS: {"users": [{"name": "a"}]},
    }
    data, _ = await run(responses, audit, settings, "users.list", service_account=None)
    a, b = data["accounts"]
    assert (a["disabled"], a["expires_on"], a["two_factor"], a["admin"]) == (
        False,
        "2027-03-31",
        True,
        True,
    )
    assert (b["disabled"], b["expires_on"], b["two_factor"]) == (None, None, None)
    assert data["summary"]["admins_without_two_factor"] == 0


async def test_users_need_personal_read(audit, settings):
    with pytest.raises(OpError) as info:
        await run(user_responses(), audit, settings, "users.list", "system:read")
    assert info.value.status == 403


async def test_logs_real_ds420p_dsm741_system(audit, settings):
    data, dsm = await run({LOGS: real("log_system")}, audit, settings, "logs.recent", limit=200)
    assert data["kind"] == "system" and data["total"] == 66
    assert data["counts"] == {"info": 63, "warning": 0, "error": 3}
    assert data["entries"][0] == {
        "time": "2026-11-09T07:40:35",
        "level": "info",
        "account": "SYSTEM_ADMIN",
        "event": "Scheduled Task [Share [essai] Snapshot] was created.",
    }
    assert dsm.calls == [
        (
            "SYNO.Core.SyslogClient.Log",
            "list",
            {
                "target": "LOCAL",
                "logtype": "system,netbackup",
                "date_from": 0,
                "date_to": 0,
                "keyword": "",
                "level": "",
                "start": 0,
                "limit": 200,
            },
        )
    ]


async def test_logs_real_ds420p_dsm741_connection(audit, settings):
    data, dsm = await run(
        {LOGS: real("log_connection")}, audit, settings, "logs.recent", kind="connection", limit=200
    )
    assert data["kind"] == "connection" and data["counts"]["warning"] == 3
    refused = [e for e in data["entries"] if e["level"] == "warning"]
    assert refused[-1] == {
        "time": "2026-11-06T13:10:50",
        "level": "warning",
        "account": "ancien-compte",
        "event": "User [ancien-compte] from [192.0.2.1] failed to sign in to [DSM] via "
        "[password] due to authorization failure.",
    }
    assert dsm.calls[0][2]["logtype"] == "connection"


async def test_logs_params_are_bounded(audit, settings):
    for params in ({"limit": 0}, {"limit": 201}, {"kind": "ftp"}, {"other": 1}):
        with pytest.raises(OpError) as info:
            await run({LOGS: {}}, audit, settings, "logs.recent", **params)
        assert info.value.status == 422


async def test_logs_need_personal_read(audit, settings):
    with pytest.raises(OpError) as info:
        await run({LOGS: {}}, audit, settings, "logs.recent", "system:read")
    assert info.value.status == 403


def test_ups_users_logs_scopes_and_verification():
    catalog = build_catalog()
    expected = {
        "ups.status": ("system:read", False),
        "users.list": ("personal:read", True),
        "logs.recent": ("personal:read", True),
    }
    for op_id, (scope, personal) in expected.items():
        op = catalog.get(op_id)
        assert op.scope == scope and op.kind == "read" and op.personal is personal
        assert "DS420+" in (op.verified_on or "")
