from dataclasses import replace
from datetime import UTC, datetime

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.catalog.ops.checks import _ago
from nas_agent.config import AuditThresholds
from nas_agent.dsm.gateway import DsmError, DsmUnreachable, DsmUnsupported
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, principal
from tests.real_nas import SynologyPages, nas_responses, real

# Heure UTC de la dernière lecture du NAS d'essai (10:37:57 à l'heure du NAS, UTC+1).
READ_AT = datetime(2026, 11, 9, 9, 37, 57, tzinfo=UTC)


async def run(audit, settings, responses=None, *scopes, at=READ_AT):
    dsm = FakeDsm(nas_responses() if responses is None else responses)
    engine = Engine(
        build_catalog(), dsm, audit, settings, wall_clock=lambda: at, service_account="claude"
    )
    engine.synology = SynologyPages()
    env = await engine.run(
        "audit.checks",
        {},
        principal(*(scopes or ("audit:checks",))),
        channel="rest",
        client_ip=None,
    )
    return env.data


def by_id(data):
    return {c["id"]: c for c in data["checks"]}


def statuses(data):
    return {c["id"]: c["status"] for c in data["checks"]}


# Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées : la forme qui fait foi.


async def test_audit_real_ds420p_dsm741(audit, settings):
    data = await run(audit, settings)
    assert statuses(data) == {
        "system.reachable": "ok",
        "system.cpu": "ok",
        "system.memory": "ok",
        "system.temperature": "ok",
        "system.ntp": "ok",
        "updates.dsm": "ok",
        "updates.packages": "ok",
        "updates.reboot": "ok",
        "updates.advisories": "failed",
        "updates.lifecycle": "ok",
        "accounts.admin_two_factor": "failed",
        "accounts.builtin_admin": "ok",
        "accounts.guest": "ok",
        "accounts.password_policy": "warning",
        "accounts.protection": "warning",
        "access.ssh": "warning",
        "access.telnet": "ok",
        "access.firewall": "failed",
        "access.auto_block": "ok",
        "access.quickconnect": "ok",
        "access.smb1": "ok",
        "access.cleartext": "ok",
        "access.https": "warning",
        "access.closing": "ok",
        "access.logins": "ok",
        "certificates.validity": "ok",
        "backup.recent_success": "failed",
        "backup.last_result": "failed",
        "backup.integrity": "warning",
        "backup.offsite": "warning",
        "backup.coverage": "warning",
        "backup.encryption": "ok",
        "backup.abb_devices": "ok",
        "backup.cloud_accounts": "ok",
        "backup.abb_offsite": "ok",
        "storage.volume_usage": "ok",
        "storage.disks": "ok",
        "storage.pools": "ok",
        "storage.disk_wear": "ok",
        "storage.smart_tests": "warning",
        "storage.scrubbing": "ok",
        "storage.redundancy": "warning",
        "containers.state": "ok",
        "ups.configured": "warning",
        "security_advisor.critical": "failed",
        "shares.recycle_bin": "warning",
        "shares.snapshots": "warning",
        "shares.file_activity": "ok",
    }
    assert data["summary"] == {
        "status": "failed",
        "total": 48,
        "ok": 30,
        "warning": 12,
        "failed": 6,
        "unknown": 0,
    }
    # Active Backup for Business n'était pas installé lors de ces lectures.
    assert data["unavailable"] == [
        {"op": "backup.activebackup", "reason": "unsupported", "dsm_code": None}
    ]
    assert data["thresholds"] == {
        "volume_warning_pct": 80,
        "volume_failure_pct": 90,
        "certificate_min_days": 30,
        "backup_max_age_hours": 26,
        "integrity_max_age_days": 35,
        "advisor_max_age_days": 30,
        "cpu_warning_pct": 90,
        "memory_warning_pct": 90,
        "disk_temperature_warning_c": 50,
        "disk_temperature_failure_c": 60,
        "system_temperature_warning_c": 70,
        "unreachable_minutes": 5,
        "scrubbing_max_age_days": 180,
        "password_min_length": 10,
        "login_failures_warning": 10,
        "login_burst": 20,
        "mass_change_count": 200,
        "pc_backup_max_age_days": 7,
    }
    checks = by_id(data)
    # Lu en Update 1 le 2026-11-09 : SA-26:21 (2026-11-19) le touche, l'Update 2 le corrige.
    assert checks["updates.advisories"]["items"] == [
        "Synology-SA-26:21, critique : DSM 7.4.1-90080-2 la corrige, annoncée pour le 2026-11-20"
    ]
    assert checks["updates.lifecycle"]["observed"] == (
        "Synology suit le DS420+ : mises à jour complètes."
    )
    assert checks["accounts.admin_two_factor"] == {
        "id": "accounts.admin_two_factor",
        "category": "accounts",
        "title": "Double authentification des administrateurs",
        "severity": "high",
        "status": "failed",
        "observed": "1 administrateur actif sans double authentification, compte de l'agent "
        "exclu ; double authentification imposée : à personne.",
        "expected": "Tous les administrateurs actifs ont la double authentification.",
        "advice": "Activer la double authentification sur chaque compte administrateur. "
        "L'imposer aux administrateurs bloquerait aussi le compte de l'agent, tant qu'il n'a pas "
        "de jeton d'appareil.",
        "items": [],
        "sources": ["users.list", "security.settings"],
    }
    # « Essai local » : planifiée chaque jour, dernière réussite le 6 à 16 h 15 (heure du NAS).
    assert checks["backup.recent_success"]["items"] == [
        "Essai en échec : sans planning, dernière réussite il y a 18 h",
        "Essai local : dernière réussite il y a 3 jours, au plus 26 h attendues",
    ]
    assert checks["backup.last_result"]["items"] == ["Essai en échec : failed_checking"]
    assert checks["backup.integrity"]["items"] == ["Essai en échec : jamais contrôlée"]
    assert checks["security_advisor.critical"]["items"] == [
        "ruleDB.Terminal.SSH.sshPortCheck (risk)"
    ]
    assert checks["access.ssh"]["observed"] == "SSH ouvert, port 22."
    # Accord au singulier, vu en direct sur le NAS d'essai.
    assert checks["certificates.validity"]["observed"] == "1 certificat utilisé, valide."
    assert checks["storage.disks"]["observed"] == "1 disque, sain."
    # Ajouts du 2026-11-26, vus sur le NAS d'essai : un disque de 5 ans, seul, sans protection.
    assert checks["storage.disk_wear"]["observed"] == (
        "1 disque sans signe d'usure, le plus ancien en marche depuis 5,4 ans."
    )
    assert checks["storage.redundancy"]["items"] == ["/volume1 : SHR sans protection"]
    assert checks["backup.coverage"]["items"] == ["Compta été", "docker", "homes"]
    assert checks["accounts.password_policy"]["items"] == [
        "longueur minimale 8 (au moins 10 attendus)",
        "mots de passe courants acceptés",
    ]
    assert checks["containers.state"]["observed"] == (
        "5 conteneurs, 5 en marche, aucun en difficulté."
    )
    assert checks["system.cpu"]["observed"] == "Processeur à 3 % en ce moment."
    assert checks["access.logins"]["observed"] == "3 échecs de connexion en 24 h."
    # Sans personal:read, les adresses ne sortent pas.
    assert checks["access.logins"]["items"] == []
    assert checks["shares.file_activity"]["observed"] == (
        "2 suppressions et 2 renommages en 24 h, aucune rafale."
    )
    assert checks["shares.snapshots"]["severity"] == "info"
    assert checks["shares.snapshots"]["items"] == ["Compta été", "docker", "homes", "sauvegardes"]
    assert checks["access.firewall"]["advice"]
    assert checks["updates.dsm"]["advice"] is None


async def test_audit_names_accounts_only_with_personal_read(audit, settings):
    data = await run(audit, settings, None, "audit:checks", "personal:read")
    assert by_id(data)["accounts.admin_two_factor"]["items"] == ["utilisateur"]
    data = await run(audit, settings, None, "audit:checks", "system:read", "security:read")
    assert by_id(data)["accounts.admin_two_factor"]["items"] == []


async def test_audit_needs_audit_checks_only(audit, settings):
    with pytest.raises(OpError) as info:
        await run(audit, settings, None, "system:read", "storage:read", "personal:read")
    assert info.value.status == 403


async def test_audit_journal_scope_does_not_open_checks(audit, settings):
    # Un jeton fait pour lire le journal de l'agent ne voit pas l'état de sécurité du NAS.
    with pytest.raises(OpError) as info:
        await run(audit, settings, None, "audit:read")
    assert info.value.status == 403


async def test_audit_unavailable_read_gives_unknown(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.SecurityScan.Conf.get"] = DsmUnsupported("SYNO.Core.SecurityScan.Conf")
    responses["SYNO.Core.ExternalDevice.UPS.get"] = DsmError(105)
    data = await run(audit, settings, responses)
    checks = by_id(data)
    assert checks["security_advisor.critical"]["status"] == "unknown"
    assert checks["security_advisor.critical"]["observed"] == (
        "Lecture impossible : security.advisor n'est pas pris en charge par ce NAS."
    )
    assert checks["ups.configured"]["observed"] == (
        "Lecture impossible : DSM a refusé ups.status (code 105)."
    )
    assert data["unavailable"] == [
        {"op": "ups.status", "reason": "dsm_error", "dsm_code": 105},
        {"op": "security.advisor", "reason": "unsupported", "dsm_code": None},
        {"op": "backup.activebackup", "reason": "unsupported", "dsm_code": None},
    ]
    assert data["summary"]["unknown"] == 2


async def test_audit_without_hyper_backup(audit, settings):
    responses = nas_responses()
    responses["SYNO.Backup.Task.list"] = DsmUnsupported("SYNO.Backup.Task")
    checks = by_id(await run(audit, settings, responses))
    assert checks["backup.recent_success"]["status"] == "warning"
    assert checks["backup.recent_success"]["observed"] == "Aucune tâche Hyper Backup."
    assert checks["backup.last_result"]["status"] == "unknown"
    assert checks["backup.integrity"]["status"] == "unknown"


async def test_audit_fails_when_dsm_is_unreachable(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.User.list"] = DsmUnreachable("x")
    with pytest.raises(OpError) as info:
        await run(audit, settings, responses)
    assert info.value.status == 503


async def test_backup_age_needs_the_nas_offset(audit, settings):
    # Sans l'heure du NAS, les heures locales de Hyper Backup ne se comparent à rien.
    responses = nas_responses()
    responses["SYNO.Core.System.info"] = DsmUnsupported("SYNO.Core.System")
    checks = by_id(await run(audit, settings, responses))
    assert checks["backup.recent_success"]["items"] == [
        "Essai en échec : sans planning",
        "Essai local : âge inconnu, heure du NAS illisible",
    ]
    assert checks["backup.recent_success"]["status"] == "warning"
    # « Jamais contrôlée » se lit sans l'heure : un avertissement certain passe avant l'inconnu.
    assert checks["backup.integrity"]["items"] == [
        "Essai en échec : jamais contrôlée",
        "Essai local : âge inconnu, heure du NAS illisible",
    ]
    assert checks["backup.integrity"]["status"] == "warning"


async def test_backup_weekly_schedule_allows_a_week(audit, settings):
    responses = nas_responses()
    status = real("backup_sched_status_1")
    status["schedule"]["schedule"]["week_name"] = "4"  # le jeudi
    responses["SYNO.Backup.Task.status"] = lambda p: (
        status if p["task_id"] == 1 else real("backup_sched_status_2")
    )
    checks = by_id(await run(audit, settings, responses))
    assert checks["backup.recent_success"]["items"] == [
        "Essai en échec : sans planning, dernière réussite il y a 18 h"
    ]
    assert checks["backup.recent_success"]["status"] == "warning"


async def test_integrity_check_too_old(audit, settings):
    later = datetime(2026, 12, 20, 9, 0, tzinfo=UTC)
    # L'heure du NAS suit l'horloge (UTC+1) : sinon l'agent la juge fausse et l'âge est inconnu.
    responses = nas_responses()
    responses["SYNO.Core.System.info"] = {**real("system_info"), "time": "2026-12-20 10:00:00"}
    checks = by_id(await run(audit, settings, responses, at=later))
    assert checks["backup.integrity"]["items"] == [
        "Essai en échec : jamais contrôlée",
        "Essai local : dernier contrôle il y a 41 jours, au plus 35 attendus",
    ]


@pytest.mark.parametrize(("used_pct", "status"), [(79, "ok"), (85, "warning"), (95, "failed")])
async def test_volume_thresholds(audit, settings, used_pct, status):
    responses = nas_responses()
    storage = real("storage_load_info")
    storage["volumes"][0]["size"].update(total="1000", used=str(used_pct * 10))
    responses["SYNO.Storage.CGI.Storage.load_info"] = storage
    check = by_id(await run(audit, settings, responses))["storage.volume_usage"]
    assert check["status"] == status
    assert check["items"] == ([] if status == "ok" else [f"/volume1 : {used_pct} %"])


async def test_thresholds_come_from_settings(audit, settings):
    responses = nas_responses()
    storage = real("storage_load_info")
    storage["volumes"][0]["size"].update(total="1000", used="750")
    responses["SYNO.Storage.CGI.Storage.load_info"] = storage
    tuned = replace(settings, audit=AuditThresholds(volume_warning_pct=70, volume_failure_pct=75))
    data = await run(audit, tuned, responses)
    assert by_id(data)["storage.volume_usage"]["status"] == "failed"
    assert data["thresholds"]["volume_warning_pct"] == 70


@pytest.mark.parametrize(
    ("valid_till", "status"),
    [("Nov 20 11:56:52 2026 GMT", "warning"), ("Nov  1 11:56:52 2026 GMT", "failed")],
)
async def test_certificate_in_use_expiring(audit, settings, valid_till, status):
    responses = nas_responses()
    certs = real("certificate_list")
    certs["certificates"][0]["valid_till"] = valid_till
    responses["SYNO.Core.Certificate.CRT.list"] = certs
    check = by_id(await run(audit, settings, responses))["certificates.validity"]
    assert check["status"] == status and check["items"][0].startswith("synology : ")


async def test_two_factor_enforced_is_only_a_warning(audit, settings):
    # Imposée : chaque administrateur la règle à sa prochaine connexion.
    responses = nas_responses()
    responses["SYNO.Core.OTP.EnforcePolicy.get"] = {"otp_enforce_option": "admin"}
    check = by_id(await run(audit, settings, responses))["accounts.admin_two_factor"]
    assert check["status"] == "warning"
    assert check["observed"].endswith("double authentification imposée : aux administrateurs.")


async def test_security_advisor_never_or_long_ago(audit, settings):
    responses = nas_responses()
    status = real("advisor_status")
    status["lastScanTime"] = ""
    responses["SYNO.Core.SecurityScan.Status.system_get"] = status
    assert by_id(await run(audit, settings, responses))["security_advisor.critical"]["status"] == (
        "unknown"
    )
    later = datetime(2027, 1, 15, 9, 0, tzinfo=UTC)
    check = by_id(await run(audit, settings, at=later))["security_advisor.critical"]
    assert check["status"] == "failed" and "il y a 67 jours" in check["observed"]


def test_audit_checks_scope_and_composition():
    catalog = build_catalog()
    op = catalog.get("audit.checks")
    assert op.scope == "audit:checks" and op.personal is False and op.calls == ()
    assert set(op.composes) == {
        "system.time",
        "dsm.update",
        "packages.list",
        "users.list",
        "security.settings",
        "certificates.list",
        "backup.hyperbackup.tasks",
        "storage.overview",
        "ups.status",
        "security.advisor",
        "shares.list",
        "system.info",
        "system.utilization",
        "containers.list",
        "storage.smart",
        "services.list",
        "security.logins",
        "files.activity",
        "backup.activebackup",
        "backup.activebackup_cloud",
        "updates.synology",
        "access.watch",
    }


@pytest.mark.parametrize(
    ("hours", "text"),
    [
        (0.4, "0 h"),
        (18.2, "18 h"),
        (47.4, "47 h"),
        (48, "2 jours"),
        (66, "3 jours"),
        (387, "16 jours"),
    ],
)
def test_ago_reads_hours_then_days(hours, text):
    # Au-delà de deux jours, « il y a 387 h » se lit mal : on passe en jours.
    assert _ago(hours) == text
