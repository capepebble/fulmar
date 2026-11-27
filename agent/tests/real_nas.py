"""Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées, appel par appel.

Elles viennent de lectures faites du 2026-11-06 au 2026-11-09 : chacune est réelle, leur
assemblage donne un NAS plausible, pas un instantané unique.
"""

from __future__ import annotations

import json
from pathlib import Path

from nas_agent.dsm.gateway import DsmUnsupported
from nas_agent.synology import Snapshot, parse_advisory, parse_feed, parse_models
from tests.conftest import load_fixture

SHARE_SLUGS = {
    "Compta été": "compta_ete",
    "docker": "docker",
    "essai": "essai",
    "homes": "homes",
    "sauvegardes": "sauvegardes",
}


SYNOLOGY = Path(__file__).parent / "fixtures" / "synology"


class SynologyPages:
    """Lecteur des pages de Synology nourri des extraits réels du 2026-11-26 (tests)."""

    def snapshot(self) -> Snapshot:
        items = parse_feed((SYNOLOGY / "rssfeed_security.xml").read_text(encoding="utf-8"))
        advisories = [
            parse_advisory(path.read_text(encoding="utf-8"), item)
            for item in items
            if (path := SYNOLOGY / f"{item.url.rsplit('/', 1)[1]}.html").exists()
        ]
        models = parse_models((SYNOLOGY / "products_status.html").read_text(encoding="utf-8"))
        return Snapshot(
            advisories=advisories,
            models=models,
            feed_read_at="2026-11-26T09:00:00+00:00",
            models_read_at="2026-11-26T09:00:00+00:00",
        )


def real(name: str) -> dict:
    return load_fixture(f"ds420p_dsm741_{name}")


def by_task(prefix: str):
    """Réponse de la tâche Hyper Backup demandée, comme DSM la donne pour une seule tâche."""
    return lambda params: real(f"{prefix}_{params['task_id']}")


def by_share(kind: str):
    """Réponse du dossier demandé ; le nom arrive encodé en JSON, comme DSM l'attend."""
    return lambda params: real(f"snapshot_{kind}_{SHARE_SLUGS[json.loads(params['name'])]}")


def nas_responses() -> dict:
    return {
        "SYNO.DSM.Info.getinfo": real("dsm_info"),
        "SYNO.Core.System.info": real("system_info"),
        "SYNO.Core.System.Utilization.get": real("system_utilization"),
        "SYNO.Core.CurrentConnection.get": real("current_connection"),
        "SYNO.Storage.CGI.Storage.load_info": real("storage_load_info"),
        "SYNO.Core.Share.list": real("share_list"),
        "SYNO.Core.Share.Snapshot.list": by_share("list"),
        "SYNO.Core.Share.Snapshot.get_schedule": by_share("schedule"),
        "SYNO.Backup.Task.list": real("backup_sched_list"),
        "SYNO.Backup.Task.status": by_task("backup_sched_status"),
        "SYNO.Backup.Repository.list": real("backup_sched_repository_list"),
        "SYNO.Backup.Task.get": by_task("backup_sched_get"),
        "SYNO.Backup.Target.get": by_task("backup_sched_target"),
        "SYNO.Core.Package.list": real("package_list"),
        "SYNO.Core.Package.Server.list": real("package_server_list"),
        "SYNO.Core.Package.Setting.get": real("package_setting"),
        "SYNO.Core.Upgrade.Server.check": real("upgrade_server_check"),
        "SYNO.Core.Upgrade.Setting.get": real("upgrade_setting"),
        "SYNO.Core.Security.Firewall.get": real("security_firewall"),
        "SYNO.Core.Security.AutoBlock.get": real("security_autoblock"),
        "SYNO.Core.SmartBlock.get": real("security_smartblock"),
        "SYNO.Core.OTP.EnforcePolicy.get": real("security_otp_enforce"),
        "SYNO.Core.Terminal.get": real("security_terminal"),
        "SYNO.Core.QuickConnect.get": real("security_quickconnect"),
        "SYNO.Core.QuickConnect.status": real("security_quickconnect_status"),
        "SYNO.Core.Security.DSM.get": real("security_dsm"),
        "SYNO.Core.SecurityScan.Conf.get": real("advisor_conf"),
        "SYNO.Core.SecurityScan.Status.system_get": real("advisor_status"),
        "SYNO.Core.SecurityScan.Status.rule_get": real("advisor_rules"),
        "SYNO.Core.Certificate.CRT.list": real("certificate_list"),
        "SYNO.Core.ExternalDevice.UPS.get": real("ups_get"),
        "SYNO.Core.User.list": real("user_list"),
        "SYNO.Core.Group.Member.list": real("admin_members"),
        # Ajouts du 2026-11-26 (conception 2026-11-26-meilleur-produit).
        "SYNO.Core.Region.NTP.status": real("ntp_status"),
        "SYNO.Core.Hardware.NeedReboot.get": real("need_reboot"),
        "SYNO.Core.User.PasswordPolicy.get": real("password_policy"),
        "SYNO.Core.User.PasswordExpiry.get": real("password_expiry"),
        "SYNO.Core.FileServ.SMB.get": real("service_smb"),
        "SYNO.Core.FileServ.AFP.get": real("service_afp"),
        "SYNO.Core.FileServ.NFS.get": real("service_nfs"),
        "SYNO.Core.FileServ.FTP.get": real("service_ftp"),
        "SYNO.Core.FileServ.FTP.SFTP.get": real("service_sftp"),
        "SYNO.Backup.Service.NetworkBackup.get": real("service_rsync"),
        "SYNO.Core.SNMP.get": real("service_snmp"),
        "SYNO.Core.Web.DSM.get": real("service_web_dsm"),
        "SYNO.Docker.Container.list": real("docker_container_list"),
        "SYNO.Docker.Container.Resource.get": real("docker_container_resource"),
        "SYNO.Storage.CGI.Smart.get_health_info": lambda p: real("smart_health_sata1"),
        "SYNO.Core.Storage.Disk.get_smart_test_log": lambda p: real("smart_test_log_sata1"),
        "SYNO.Storage.CGI.Smart.Scheduler.list": real("smart_scheduler_list"),
        # Les deux journaux passent par la même API : la forme des paramètres les distingue.
        "SYNO.Core.SyslogClient.Log.list": lambda p: real(
            "log_connection_failures" if p.get("logtype") == "connection" else "log_files"
        ),
        "SYNO.Core.SyslogClient.FileTransfer.get": real("file_transfer_settings"),
        # Active Backup for Business n'était pas installé lors de ces lectures.
        **{
            f"SYNO.ActiveBackup.{call}": DsmUnsupported(f"SYNO.ActiveBackup.{call.split('.')[0]}")
            for call in (
                "Activation.get",
                "Task.list",
                "Device.list",
                "Overview.list_device_last_backup",
                "Share.list_storage",
            )
        },
        # Ni Active Backup for Microsoft 365 ni for Google Workspace non plus.
        **{
            f"{api}.{method}": DsmUnsupported(api)
            for api in ("SYNO.ActiveBackupOffice365", "SYNO.ActiveBackupGSuite")
            for method in ("get_activation", "list_tasks")
        },
    }
