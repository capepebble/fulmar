"""Les contrôles du 2026-11-26 (conception 2026-11-26-meilleur-produit) : un test par verdict,
sur des variantes des vraies réponses du NAS d'essai, historique compris."""

import copy
from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.catalog.ops.checks_vitals import silence
from nas_agent.dsm.gateway import DsmUnsupported
from nas_agent.engine import Engine
from nas_agent.history import FailingRead, HistoryStore
from tests.conftest import FakeDsm, principal
from tests.real_nas import nas_responses, real

AT = datetime(2026, 11, 9, 9, 37, 57, tzinfo=UTC)


async def audit_of(audit, settings, responses=None, *, history=None, lang=None):
    engine = Engine(
        build_catalog(),
        FakeDsm(nas_responses() if responses is None else responses),
        audit,
        settings,
        wall_clock=lambda: AT,
        service_account="claude",
        history=history,
    )
    env = await engine.run(
        "audit.checks", {}, principal("audit:checks"), channel="rest", client_ip=None, lang=lang
    )
    return {c["id"]: c for c in env.data["checks"]}


@pytest.fixture
def store(tmp_path):
    return HistoryStore(tmp_path / "history.db")


def record(store, metric, subject, values, *, step=timedelta(minutes=1), end=AT):
    for i, value in enumerate(values):
        store.record(end - step * (len(values) - 1 - i), [(metric, subject, value)])


# Constantes ---------------------------------------------------------------------------------


async def test_cpu_average_over_15_minutes(audit, settings, store):
    record(store, "cpu_pct", "", [95.0] * 15)
    checks = await audit_of(audit, settings, history=store)
    assert checks["system.cpu"]["status"] == "warning"
    assert checks["system.cpu"]["observed"] == "Processeur à 95 % en moyenne sur 15 min."


async def test_cpu_below_threshold_and_memory_in_english(audit, settings, store):
    record(store, "cpu_pct", "", [40.0] * 15)
    record(store, "memory_pct", "", [93.0] * 15)
    checks = await audit_of(audit, settings, history=store, lang="en")
    assert checks["system.cpu"]["status"] == "ok"
    assert checks["system.memory"]["status"] == "warning"
    assert checks["system.memory"]["observed"] == "Memory at 93 % on average over 15 min."


async def test_temperatures_warn_then_fail(audit, settings):
    responses = nas_responses()
    storage = copy.deepcopy(real("storage_load_info"))
    storage["disks"][0]["temp"] = 54
    responses["SYNO.Storage.CGI.Storage.load_info"] = storage
    checks = await audit_of(audit, settings, responses)
    assert checks["system.temperature"]["status"] == "warning"
    assert checks["system.temperature"]["items"] == ["Drive 1 : 54 °C"]
    storage["disks"][0]["temp"] = 61
    checks = await audit_of(audit, settings, responses)
    assert checks["system.temperature"]["status"] == "failed"


def test_silence_waits_five_minutes_then_rings():
    since = AT - timedelta(minutes=3)
    failing = [("system.utilization", "dsm_unreachable", since)]
    assert silence(failing, AT, 5, "fr").status == "ok"
    late = [("system.utilization", "dsm_unreachable", AT - timedelta(minutes=37))]
    verdict = silence(late, AT, 5, "fr")
    assert (verdict.status, verdict.observed) == ("failed", "DSM ne répond plus depuis 37 min.")
    assert silence(late, AT, 5, "en").observed == "DSM has not answered for 37 min."
    # Une lecture refusée par DSM n'est pas un silence.
    assert silence([("system.info", "dsm_error", since)], AT, 5, "fr").status == "ok"


def test_silence_on_a_changed_certificate_says_why():
    failing = [("storage.overview", "dsm_certificate", AT - timedelta(hours=3))]
    verdict = silence(failing, AT, 5, "fr")
    assert verdict.status == "failed"
    assert verdict.observed == (
        "Le certificat de DSM a changé il y a 3 h : l'agent refuse de lui parler."
    )
    assert "empreinte" in verdict.advice


async def test_reachable_reads_the_sampler(audit, settings, store):
    store.status.failing["system.utilization"] = FailingRead(
        "dsm_unreachable", None, AT - timedelta(minutes=8)
    )
    checks = await audit_of(audit, settings, history=store)
    assert checks["system.reachable"]["status"] == "failed"


async def test_containers_in_trouble(audit, settings):
    responses = nas_responses()
    listing = copy.deepcopy(real("docker_container_list"))
    listing["containers"][0]["State"].update(Running=False, Status="exited", ExitCode=1)
    listing["containers"][1]["State"]["Restarting"] = True
    responses["SYNO.Docker.Container.list"] = listing
    checks = await audit_of(audit, settings, responses)
    c = checks["containers.state"]
    assert c["status"] == "failed"
    assert c["items"] == [
        "nas-moteur-essai-agent-1 : redémarre en boucle",
        "nas-moteur-essai-console-1 : arrêté seul (code 1)",
    ]


async def test_containers_without_container_manager(audit, settings):
    responses = nas_responses()
    responses["SYNO.Docker.Container.list"] = DsmUnsupported("SYNO.Docker.Container")
    checks = await audit_of(audit, settings, responses)
    assert checks["containers.state"]["status"] == "ok"
    assert checks["containers.state"]["observed"] == "Container Manager n'est pas installé."


# Disques ------------------------------------------------------------------------------------


def smart_with(**raw):
    health = copy.deepcopy(real("smart_health_sata1"))
    ids = {"reallocated": "5", "pending": "197", "uncorrectable": "198", "crc": "199"}
    for name, value in raw.items():
        for attr in health["healthInfo"]["smartInfo"]:
            if attr["id"] == ids[name]:
                attr["raw"] = str(value)
    return health


async def test_pending_sectors_fail(audit, settings):
    responses = nas_responses()
    responses["SYNO.Storage.CGI.Smart.get_health_info"] = lambda p: smart_with(pending=8)
    checks = await audit_of(audit, settings, responses)
    assert checks["storage.disk_wear"]["status"] == "failed"
    assert checks["storage.disk_wear"]["items"] == ["Drive 1 : 8 secteurs en attente"]
    assert "remplacer" in checks["storage.disk_wear"]["advice"]


async def test_stable_reallocated_warn_rising_fail(audit, settings, store):
    responses = nas_responses()
    responses["SYNO.Storage.CGI.Smart.get_health_info"] = lambda p: smart_with(reallocated=12)
    checks = await audit_of(audit, settings, responses, history=store)
    assert checks["storage.disk_wear"]["status"] == "warning"
    record(store, "disk_reallocated", "sata1", [2.0, 12.0], step=timedelta(days=20))
    checks = await audit_of(audit, settings, responses, history=store)
    assert checks["storage.disk_wear"]["status"] == "failed"
    assert checks["storage.disk_wear"]["items"] == [
        "Drive 1 : 12 secteurs réalloués (+10 en 30 jours)"
    ]


async def test_failed_smart_test_and_scheduled_tests(audit, settings):
    responses = nas_responses()
    log = copy.deepcopy(real("smart_test_log_sata1"))
    log["testInfo"][0]["latest_test_result"] = "damage"
    responses["SYNO.Core.Storage.Disk.get_smart_test_log"] = lambda p: log
    checks = await audit_of(audit, settings, responses)
    assert checks["storage.smart_tests"]["status"] == "failed"
    responses = nas_responses()
    responses["SYNO.Storage.CGI.Smart.Scheduler.list"] = {
        "items": [{"enabled": True, "task_name": "Rapide", "action": "Quick test"}],
        "total": 1,
    }
    checks = await audit_of(audit, settings, responses, lang="en")
    assert checks["storage.smart_tests"]["status"] == "ok"
    assert checks["storage.smart_tests"]["observed"] == "1 SMART test scheduled."


async def test_scrubbing_on_a_redundant_pool(audit, settings):
    responses = nas_responses()
    storage = copy.deepcopy(real("storage_load_info_20261126"))
    storage["storagePools"][0]["device_type"] = "raid_5"
    responses["SYNO.Storage.CGI.Storage.load_info"] = storage
    checks = await audit_of(audit, settings, responses)
    assert checks["storage.scrubbing"]["status"] == "warning"
    assert checks["storage.scrubbing"]["items"] == ["reuse_1 : jamais nettoyé"]
    assert checks["storage.redundancy"]["status"] == "ok"
    storage["env"]["data_scrubbing"]["sche_enabled"] = "1"
    checks = await audit_of(audit, settings, responses)
    assert checks["storage.scrubbing"]["status"] == "ok"


# Accès et comptes ---------------------------------------------------------------------------


async def test_smb1_fails_ntlmv1_warns(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.FileServ.SMB.get"] = {**real("service_smb"), "smb_min_protocol": 0}
    checks = await audit_of(audit, settings, responses)
    assert checks["access.smb1"]["status"] == "failed"
    responses["SYNO.Core.FileServ.SMB.get"] = {**real("service_smb"), "enable_ntlmv1_auth": True}
    checks = await audit_of(audit, settings, responses)
    assert checks["access.smb1"]["status"] == "warning"


async def test_cleartext_services_listed(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.FileServ.FTP.get"] = {**real("service_ftp"), "enable_ftp": True}
    responses["SYNO.Core.SNMP.get"] = {
        **real("service_snmp"),
        "enable_snmp": True,
        "enable_snmp_v1v2": True,
    }
    checks = await audit_of(audit, settings, responses)
    assert checks["access.cleartext"]["status"] == "warning"
    assert checks["access.cleartext"]["items"] == ["FTP sans chiffrement", "SNMP v1 ou v2c"]


async def test_https_policy_protection_ntp_reboot_good(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.Web.DSM.get"] = {**real("service_web_dsm"), "enable_https_redirect": True}
    policy = copy.deepcopy(real("password_policy"))
    policy["strong_password"].update(min_length=12, exclude_common_password=True)
    responses["SYNO.Core.User.PasswordPolicy.get"] = policy
    responses["SYNO.Core.SmartBlock.get"] = {**real("security_smartblock"), "enabled": True}
    checks = await audit_of(audit, settings, responses)
    assert checks["access.https"]["status"] == "ok"
    assert checks["accounts.password_policy"]["status"] == "ok"
    assert checks["accounts.password_policy"]["observed"] == (
        "Au moins 12 caractères, mots de passe courants refusés."
    )
    assert checks["accounts.protection"]["status"] == "ok"


async def test_ntp_and_reboot_warn(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.Region.NTP.status"] = {"ntp_status": False}
    responses["SYNO.Core.Hardware.NeedReboot.get"] = {"need_reboot": True}
    checks = await audit_of(audit, settings, responses)
    assert checks["system.ntp"]["status"] == "warning"
    assert checks["system.ntp"]["observed"] == "Synchronisation avec time.google.com en échec."
    assert checks["updates.reboot"]["status"] == "warning"
    responses["SYNO.Core.System.info"] = {**real("system_info"), "enabled_ntp": False}
    checks = await audit_of(audit, settings, responses)
    assert checks["system.ntp"]["observed"].startswith("Heure réglée à la main")


async def test_unreadable_policy_is_unknown(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.User.PasswordPolicy.get"] = DsmUnsupported("SYNO.Core.User.PasswordPolicy")
    checks = await audit_of(audit, settings, responses)
    assert checks["accounts.password_policy"]["status"] == "unknown"


# Sauvegardes --------------------------------------------------------------------------------


async def test_remote_copy_counts_off_site_and_must_be_encrypted(audit, settings):
    responses = nas_responses()
    listing = copy.deepcopy(real("backup_sched_list"))
    listing["task_list"][0]["type"] = "image:image_remote"
    responses["SYNO.Backup.Task.list"] = listing
    checks = await audit_of(audit, settings, responses)
    assert checks["backup.offsite"]["status"] == "ok"
    assert checks["backup.encryption"]["status"] == "warning"
    assert checks["backup.encryption"]["items"] == ["Essai en échec"]


async def test_backups_without_hyper_backup(audit, settings):
    responses = nas_responses()
    responses["SYNO.Backup.Task.list"] = DsmUnsupported("SYNO.Backup.Task")
    checks = await audit_of(audit, settings, responses)
    assert checks["backup.offsite"]["status"] == "warning"
    assert checks["backup.offsite"]["observed"] == "Hyper Backup n'est pas installé."
    assert checks["backup.encryption"]["status"] == "ok"


# Signes d'attaque ---------------------------------------------------------------------------


def connection_log(failures: int, *, minutes_apart: float):
    log = real("log_connection_failures")
    failure = next(i for i in log["items"] if i["level"] == "warn")
    items = []
    for n in range(failures):
        item = copy.deepcopy(failure)
        seconds = round(n * minutes_apart * 60)
        item["time"] = f"2026/11/26 03:{seconds // 60:02d}:{seconds % 60:02d}"
        items.append(item)
    return {**log, "items": items, "total": len(items)}


async def test_failed_sign_ins_warn_then_a_burst_fails(audit, settings):
    responses = nas_responses()
    responses["SYNO.Core.SyslogClient.Log.list"] = lambda p: (
        connection_log(12, minutes_apart=3)
        if p.get("logtype") == "connection"
        else real("log_files")
    )
    checks = await audit_of(audit, settings, responses)
    assert checks["access.logins"]["status"] == "warning"
    responses["SYNO.Core.SyslogClient.Log.list"] = lambda p: (
        connection_log(25, minutes_apart=0.2)
        if p.get("logtype") == "connection"
        else real("log_files")
    )
    checks = await audit_of(audit, settings, responses)
    assert checks["access.logins"]["status"] == "failed"
    assert checks["access.logins"]["observed"] == (
        "25 échecs de connexion en 24 h, dont 25 en 10 minutes : quelqu'un essaie des mots de "
        "passe."
    )


async def test_mass_deletion_fails_and_a_silent_log_is_unknown(audit, settings):
    files = real("log_files")
    delete = next(i for i in files["items"] if i["cmd"] == "delete")
    many = []
    for n in range(210):
        item = copy.deepcopy(delete)
        item["time"] = f"2026/11/26 02:0{n // 60}:{n % 60:02d}"
        many.append(item)
    responses = nas_responses()
    responses["SYNO.Core.SyslogClient.Log.list"] = lambda p: (
        real("log_connection_failures")
        if p.get("logtype") == "connection"
        else {**files, "items": many}
    )
    checks = await audit_of(audit, settings, responses)
    assert checks["shares.file_activity"]["status"] == "failed"
    responses["SYNO.Core.SyslogClient.FileTransfer.get"] = {
        **real("file_transfer_settings"),
        "cifs": False,
        "filestation": False,
    }
    checks = await audit_of(audit, settings, responses)
    assert checks["shares.file_activity"]["status"] == "unknown"
    assert "Journal des transferts coupé" in checks["shares.file_activity"]["observed"]


async def test_zero_is_plural_in_english_singular_in_french(audit, settings):
    responses = nas_responses()
    # Les deux journaux vides : aucune connexion, aucun transfert.
    responses["SYNO.Core.SyslogClient.Log.list"] = {"items": [], "total": 0}
    en = await audit_of(audit, settings, responses, lang="en")
    assert en["access.logins"]["observed"] == "0 failed sign-ins in 24 h."
    assert en["shares.file_activity"]["observed"] == (
        "0 deletions and 0 renames in 24 h, no burst."
    )
    fr = await audit_of(audit, settings, responses, lang="fr")
    assert fr["access.logins"]["observed"] == "0 échec de connexion en 24 h."
