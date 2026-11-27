"""services.list et les ajouts de security.settings, system.time et dsm.update."""

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmUnsupported
from nas_agent.engine import Engine
from tests.conftest import FakeDsm, load_fixture, principal


def real(name):
    return load_fixture(f"ds420p_dsm741_{name}")


SERVICES = {
    "SYNO.Core.FileServ.SMB.get": real("service_smb"),
    "SYNO.Core.FileServ.AFP.get": real("service_afp"),
    "SYNO.Core.FileServ.NFS.get": real("service_nfs"),
    "SYNO.Core.FileServ.FTP.get": real("service_ftp"),
    "SYNO.Core.FileServ.FTP.SFTP.get": real("service_sftp"),
    "SYNO.Backup.Service.NetworkBackup.get": real("service_rsync"),
    "SYNO.Core.SNMP.get": real("service_snmp"),
    "SYNO.Core.Web.DSM.get": real("service_web_dsm"),
}


async def run(responses, audit, settings, op, scope):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    env = await engine.run(op, {}, principal(scope), channel="rest", client_ip=None)
    return env.data, dsm


async def test_real_ds420p_services(audit, settings):
    data, _ = await run(SERVICES, audit, settings, "services.list", "security:read")
    assert data == {
        "smb": {"enabled": True, "min_protocol": "SMB2", "max_protocol": "SMB3", "ntlmv1": False},
        "afp_enabled": False,
        "nfs_enabled": False,
        "ftp": {"enabled": False, "ftps_enabled": False, "port": 21},
        "sftp": {"enabled": False, "port": 22},
        "rsync": {"enabled": False, "rsync_accounts": False},
        "snmp": {"enabled": False, "v1v2c": False, "v3": False, "community_set": False},
        "web": {
            "http_port": 5000,
            "https_port": 5001,
            "https_redirect": False,
            "hsts": False,
        },
    }


async def test_smb1_ntlmv1_snmp_community_never_shown(audit, settings):
    smb = {**real("service_smb"), "smb_min_protocol": 0, "enable_ntlmv1_auth": True}
    snmp = {
        **real("service_snmp"),
        "enable_snmp": True,
        "enable_snmp_v1v2": True,
        "rocommunity": "public-secret",
    }
    responses = {**SERVICES, "SYNO.Core.FileServ.SMB.get": smb, "SYNO.Core.SNMP.get": snmp}
    data, _ = await run(responses, audit, settings, "services.list", "security:read")
    assert data["smb"]["min_protocol"] == "SMB1" and data["smb"]["ntlmv1"] is True
    assert data["snmp"] == {"enabled": True, "v1v2c": True, "v3": False, "community_set": True}
    assert "public-secret" not in str(data)


async def test_services_missing_on_a_nas_keep_the_others(audit, settings):
    responses = {**SERVICES, "SYNO.Core.FileServ.AFP.get": DsmUnsupported("absent")}
    data, _ = await run(responses, audit, settings, "services.list", "security:read")
    assert data["afp_enabled"] is None and data["smb"]["enabled"] is True


SECURITY = {
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


async def test_real_ds420p_password_policy(audit, settings):
    data, _ = await run(SECURITY, audit, settings, "security.settings", "security:read")
    assert data["password_policy"] == {
        "min_length": 8,
        "mixed_case": True,
        "numbers": True,
        "special_chars": False,
        "exclude_common": False,
        "exclude_username": True,
    }
    assert data["password_expiry_enabled"] is False


async def test_password_policy_unreadable_keeps_the_settings(audit, settings):
    responses = {**SECURITY, "SYNO.Core.User.PasswordPolicy.get": DsmUnsupported("absent")}
    data, _ = await run(responses, audit, settings, "security.settings", "security:read")
    assert data["password_policy"] is None and data["firewall"] is not None


async def test_real_ds420p_ntp_synced_and_no_reboot_pending(audit, settings):
    base = {
        "SYNO.Core.System.info": real("system_info"),
        "SYNO.Core.Region.NTP.status": real("ntp_status"),
    }
    data, _ = await run(base, audit, settings, "system.time", "system:read")
    assert (data["ntp_enabled"], data["ntp_synced"]) == (True, True)
    unsynced = {**base, "SYNO.Core.Region.NTP.status": {"ntp_status": False}}
    data, _ = await run(unsynced, audit, settings, "system.time", "system:read")
    assert data["ntp_synced"] is False
    absent = {**base, "SYNO.Core.Region.NTP.status": DsmUnsupported("absent")}
    data, _ = await run(absent, audit, settings, "system.time", "system:read")
    assert data["ntp_synced"] is None


async def test_real_ds420p_reboot_pending(audit, settings):
    base = {
        "SYNO.Core.Upgrade.Server.check": real("upgrade_server_check"),
        "SYNO.Core.Upgrade.Setting.get": real("upgrade_setting"),
        "SYNO.DSM.Info.getinfo": real("dsm_info"),
        "SYNO.Core.Hardware.NeedReboot.get": real("need_reboot"),
    }
    data, _ = await run(base, audit, settings, "dsm.update", "system:read")
    assert data["reboot_pending"] is False
    pending = {**base, "SYNO.Core.Hardware.NeedReboot.get": {"need_reboot": True}}
    data, _ = await run(pending, audit, settings, "dsm.update", "system:read")
    assert data["reboot_pending"] is True
