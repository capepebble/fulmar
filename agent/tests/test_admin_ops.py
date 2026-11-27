import json

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmError
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

PACKAGES = "SYNO.Core.Package.list"
CATALOG = "SYNO.Core.Package.Server.list"
PKG_SETTING = "SYNO.Core.Package.Setting.get"
CHECK = "SYNO.Core.Upgrade.Server.check"
UPD_SETTING = "SYNO.Core.Upgrade.Setting.get"
DSM_INFO = "SYNO.DSM.Info.getinfo"
REBOOT = "SYNO.Core.Hardware.NeedReboot.get"


def real(name):
    return load_fixture(f"ds420p_dsm741_{name}")


async def run(responses, audit, settings, op, *scopes):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    p = principal(*(scopes or ("system:read", "security:read")))
    env = await engine.run(op, {}, p, channel="rest", client_ip=None)
    return env.data, dsm


def package_responses():
    return {
        PACKAGES: real("package_list"),
        CATALOG: real("package_server_list"),
        PKG_SETTING: real("package_setting"),
    }


def by_id(data):
    return {p["id"]: p for p in data["packages"]}


# Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées : la forme qui fait foi.


async def test_packages_real_ds420p_dsm741(audit, settings):
    data, dsm = await run(package_responses(), audit, settings, "packages.list")
    assert data["summary"] == {
        "total": 13,
        "running": 13,
        "updates_available": 0,
        "security_updates": 0,
    }
    assert (data["auto_update_all"], data["auto_update_important"]) == (False, True)
    assert data["catalog_available"] is True
    assert by_id(data)["HyperBackup"] == {
        "id": "HyperBackup",
        "name": "Hyper Backup",
        "version": "4.2.2-4262",
        "status": "running",
        "system": False,
        "available_version": "4.2.2-4262",
        "update_available": False,
        "security_update": False,
    }
    assert by_id(data)["FileStation"]["system"] is True
    # Le catalogue est lu comme le Centre de paquets, sans forcer son rechargement.
    catalog_call = next(c for c in dsm.calls if c[0] == "SYNO.Core.Package.Server")
    assert catalog_call[2] == {"blforcereload": "false", "blloadothers": "false"}


async def test_packages_update_and_security_update(audit, settings):
    responses = package_responses()
    for p in responses[PACKAGES]["packages"]:
        if p["id"] in ("HyperBackup", "SMBService"):
            p["version"] = "1.0.0-0001"
    for p in responses[CATALOG]["packages"]:
        if p["id"] == "SMBService":
            p["is_security_version"] = True
    data, _ = await run(responses, audit, settings, "packages.list")
    assert data["summary"]["updates_available"] == 2
    assert data["summary"]["security_updates"] == 1
    assert by_id(data)["HyperBackup"]["update_available"] is True
    assert by_id(data)["HyperBackup"]["security_update"] is False
    assert by_id(data)["SMBService"]["security_update"] is True


async def test_package_versions_compare_numerically(audit, settings):
    responses = {
        PACKAGES: {"packages": [{"id": "A", "version": "4.2.10-100"}, {"id": "B", "version": "x"}]},
        CATALOG: {
            "packages": [
                {"id": "A", "version": "4.2.9-999"},
                {"id": "A", "version": "4.2.11-1", "beta": True},
            ]
        },
        PKG_SETTING: {},
    }
    data, _ = await run(responses, audit, settings, "packages.list")
    a, b = by_id(data)["A"], by_id(data)["B"]
    # Une bêta ne compte pas comme mise à jour ; un paquet absent du catalogue reste inconnu.
    assert (a["available_version"], a["update_available"]) == ("4.2.9-999", False)
    assert (b["available_version"], b["update_available"], b["security_update"]) == (
        None,
        None,
        None,
    )


async def test_packages_without_synology_catalog(audit, settings):
    # NAS sans accès à Internet : la liste reste lisible, les mises à jour sont inconnues.
    responses = package_responses()
    responses[CATALOG] = DsmError(4501)
    data, _ = await run(responses, audit, settings, "packages.list")
    assert data["catalog_available"] is False
    assert data["summary"]["total"] == 13
    hb = by_id(data)["HyperBackup"]
    assert (hb["available_version"], hb["update_available"], hb["security_update"]) == (
        None,
        None,
        None,
    )


async def test_dsm_update_real_ds420p_dsm741(audit, settings):
    responses = {
        CHECK: real("upgrade_server_check"),
        UPD_SETTING: real("upgrade_setting"),
        DSM_INFO: real("dsm_info"),
        REBOOT: real("need_reboot"),
    }
    data, dsm = await run(responses, audit, settings, "dsm.update")
    assert data == {
        "current_version": "DSM 7.4.1-90080 Update 1",
        "check_ok": True,
        "update_available": False,
        "update_version": None,
        "major_upgrade_available": False,
        "major_upgrade_version": None,
        "auto_update": "hotfix-security",
        "schedule": {"week_day": "2", "hour": 5, "minute": 50},
        "reboot_pending": False,
    }
    check = next(c for c in dsm.calls if c[0] == "SYNO.Core.Upgrade.Server")
    # Sans `user_reading` : l'agent ne marque pas la mise à jour comme vue dans DSM.
    assert check[2] == {"need_auto_smallupdate": "true", "need_promotion": "true"}


async def test_dsm_update_available(audit, settings):
    check = {
        "update": {"available": True, "version": "DSM 7.4.2-90100", "rss_result": "success"},
        "promotion": {"available": True, "version": "DSM 8.0-10000", "rss_result": "success"},
    }
    responses = {CHECK: check, UPD_SETTING: {}, DSM_INFO: {}, REBOOT: {}}
    data, _ = await run(responses, audit, settings, "dsm.update")
    assert (data["update_available"], data["update_version"]) == (True, "DSM 7.4.2-90100")
    assert (data["major_upgrade_available"], data["major_upgrade_version"]) == (
        True,
        "DSM 8.0-10000",
    )


def security_responses():
    return {
        "SYNO.Core.Security.Firewall.get": real("security_firewall"),
        "SYNO.Core.Security.AutoBlock.get": real("security_autoblock"),
        "SYNO.Core.SmartBlock.get": real("security_smartblock"),
        "SYNO.Core.OTP.EnforcePolicy.get": real("security_otp_enforce"),
        "SYNO.Core.Terminal.get": real("security_terminal"),
        "SYNO.Core.QuickConnect.get": real("security_quickconnect"),
        "SYNO.Core.QuickConnect.status": real("security_quickconnect_status"),
        "SYNO.Core.Security.DSM.get": real("security_dsm"),
        "SYNO.Core.User.PasswordPolicy.get": real("password_policy"),
        "SYNO.Core.User.PasswordExpiry.get": real("password_expiry"),
    }


async def test_security_settings_real_ds420p_dsm741(audit, settings):
    data, _ = await run(security_responses(), audit, settings, "security.settings")
    assert data == {
        "firewall": {"enabled": False, "profile": "default"},
        "auto_block": {"enabled": True, "attempts": 10, "within_minutes": 5, "block_days": 0},
        "account_protection_enabled": False,
        "two_factor_enforced": "none",
        "ssh": {"enabled": True, "port": 22},
        "telnet_enabled": False,
        "quickconnect": {"enabled": False, "status": "not_running"},
        "session": {"timeout_minutes": 15, "csrf_protection": True},
        "password_policy": {
            "min_length": 8,
            "mixed_case": True,
            "numbers": True,
            "special_chars": False,
            "exclude_common": False,
            "exclude_username": True,
        },
        "password_expiry_enabled": False,
    }


async def test_security_settings_never_show_quickconnect_identity(audit, settings):
    responses = security_responses()
    responses["SYNO.Core.QuickConnect.get"] = {
        "enabled": True,
        "server_alias": "mon-nas",
        "server_id": "123456789",
        "myds_account": "jean@example.org",
    }
    data, _ = await run(responses, audit, settings, "security.settings")
    text = json.dumps(data)
    assert data["quickconnect"]["enabled"] is True
    assert "mon-nas" not in text and "123456789" not in text and "jean@" not in text


async def test_security_settings_need_security_read(audit, settings):
    with pytest.raises(OpError) as info:
        await run(security_responses(), audit, settings, "security.settings", "system:read")
    assert info.value.status == 403


def test_admin_ops_scopes_and_verification():
    catalog = build_catalog()
    expected = {
        "packages.list": "system:read",
        "dsm.update": "system:read",
        "security.settings": "security:read",
    }
    for op_id, scope in expected.items():
        op = catalog.get(op_id)
        assert op.scope == scope and op.kind == "read" and not op.personal
        assert "DS420+" in (op.verified_on or "")
