"""Contrôles d'Active Backup for Business (conception 2026-11-26-meilleur-produit, section 3.8).

Le reste du NAS vient des vraies réponses du NAS d'essai ; Active Backup, des réponses
synthétiques de test_activebackup_ops.
"""

import copy
from datetime import UTC, datetime

from nas_agent.dsm.gateway import DsmUnsupported
from tests.real_nas import nas_responses, real
from tests.test_activebackup_ops import ACTIVATION, synthetic, task
from tests.test_checks_2026_11_26 import AT, audit_of

DAY = 86_400
NOW = int(AT.timestamp())


def with_abb(tasks, last=(), **kw):
    responses = nas_responses()
    responses.update(synthetic(tasks, last, **kw))
    return responses


def device(device_id, name):
    return {"device_id": device_id, "host_name": name}


def backed_up(device_id, days_ago):
    return {"device_id": device_id, "time_start": NOW - int(days_ago * DAY)}


async def test_without_the_package_both_checks_are_not_applicable(audit, settings):
    responses = nas_responses()
    responses[ACTIVATION] = DsmUnsupported("SYNO.ActiveBackup.Activation")
    checks = await audit_of(audit, settings, responses)
    assert checks["backup.abb_devices"]["status"] == "ok"
    assert checks["backup.abb_devices"]["observed"] == (
        "Sans objet : Active Backup for Business n'est pas installé."
    )
    assert checks["backup.abb_offsite"]["status"] == "ok"


async def test_no_task_is_not_applicable(audit, settings):
    checks = await audit_of(audit, settings, with_abb([], activated=False), lang="en")
    assert checks["backup.abb_devices"]["observed"] == "Not applicable: no Active Backup task."
    assert checks["backup.abb_offsite"]["status"] == "ok"


async def test_tasks_without_activation_fail(audit, settings):
    tasks = [task(1, "Postes", 2, 2, [device(7, "atelier-mac")])]
    checks = await audit_of(audit, settings, with_abb(tasks, activated=False))
    found = checks["backup.abb_devices"]
    assert found["status"] == "failed"
    assert found["observed"] == "Active Backup n'est pas activé : aucune sauvegarde ne part."
    assert found["advice"].startswith("Ouvrir Active Backup for Business et l'activer")


async def test_devices_on_time(audit, settings):
    tasks = [
        task(1, "Postes", 2, 2, [device(7, "atelier-mac"), device(9, "accueil-pc")]),
        task(2, "Serveur", 3, 2, [device(8, "srv-01")], next_trigger_time=NOW + DAY),
    ]
    last = [backed_up(7, 3), backed_up(9, 6.5), backed_up(8, 0.5)]
    checks = await audit_of(audit, settings, with_abb(tasks, last))
    found = checks["backup.abb_devices"]
    assert (found["status"], found["items"]) == ("ok", [])
    assert found["observed"] == "3 appareils sauvegardés à temps."


async def test_a_late_computer_warns_a_late_server_fails(audit, settings):
    tasks = [
        task(1, "Postes", 2, 2, [device(7, "atelier-mac")]),
        task(2, "Serveur", 3, 2, [device(8, "srv-01")], next_trigger_time=NOW + DAY),
    ]
    late_pc = await audit_of(audit, settings, with_abb(tasks, [backed_up(7, 9), backed_up(8, 1)]))
    assert late_pc["backup.abb_devices"]["status"] == "warning"
    assert late_pc["backup.abb_devices"]["items"] == [
        "atelier-mac : dernière réussite il y a 9 jours"
    ]
    late_server = await audit_of(
        audit, settings, with_abb(tasks, [backed_up(7, 1), backed_up(8, 3)]), lang="en"
    )
    assert late_server["backup.abb_devices"]["status"] == "failed"
    assert late_server["backup.abb_devices"]["items"] == ["srv-01: last success 3 days ago"]
    assert late_server["backup.abb_devices"]["observed"] == "1 device late or failed out of 2."


async def test_failed_partial_never_and_unscheduled(audit, settings):
    tasks = [
        task(1, "Postes", 2, 4, [device(7, "atelier-mac")]),
        task(2, "Fichiers", 4, 3, [device(8, "partage")]),
        task(3, "Serveur", 3, None, [device(9, "srv-01")]),
        task(4, "Machine", 1, 2, [device(10, "vm-01")]),
    ]
    last = [backed_up(7, 1), backed_up(8, 1), backed_up(10, 2)]
    checks = await audit_of(audit, settings, with_abb(tasks, last))
    found = checks["backup.abb_devices"]
    assert found["status"] == "failed"
    assert found["items"] == [
        "atelier-mac : dernière sauvegarde en échec",
        "partage : dernière sauvegarde partielle",
        "srv-01 : jamais sauvegardé",
        "vm-01 : sans planning, dernière réussite il y a 2 jours",
    ]


async def test_a_running_first_backup_is_not_a_fault(audit, settings):
    first = task(1, "Postes", 2, None, [device(7, "atelier-mac")], progress={"job_status": 3})
    checks = await audit_of(audit, settings, with_abb([first]))
    assert checks["backup.abb_devices"]["status"] == "ok"


def hyper_backup(path, kind="image:image_remote"):
    listing = copy.deepcopy(real("backup_sched_list"))
    listing["task_list"][0]["type"] = kind
    listing["task_list"][0]["source"]["file_list"] = [{"folderPath": path}]
    return listing


async def test_device_backups_must_be_copied_off_the_nas(audit, settings):
    tasks = [task(1, "Postes", 2, 2, [device(7, "atelier-mac")])]
    responses = with_abb(tasks, [backed_up(7, 1)])
    checks = await audit_of(audit, settings, responses)
    found = checks["backup.abb_offsite"]
    assert found["status"] == "warning"
    assert found["items"] == ["ActiveBackupforBusiness"]
    assert found["observed"].startswith("Sauvegardes des appareils dans 1 dossier sans copie")
    # Une copie locale ne compte pas ; une copie distante du dossier @ActiveBackup, si.
    responses["SYNO.Backup.Task.list"] = hyper_backup(
        "/ActiveBackupforBusiness/@ActiveBackup", "image:image_local"
    )
    assert (await audit_of(audit, settings, responses))["backup.abb_offsite"]["status"] == (
        "warning"
    )
    for path in ("/ActiveBackupforBusiness/@ActiveBackup", "/ActiveBackupforBusiness"):
        responses["SYNO.Backup.Task.list"] = hyper_backup(path)
        assert (await audit_of(audit, settings, responses))["backup.abb_offsite"]["status"] == "ok"
    # Le dossier virtuel des versions ne contient aucune donnée : il ne compte pas.
    responses["SYNO.Backup.Task.list"] = hyper_backup("/ActiveBackupforBusiness/ActiveBackupData")
    assert (await audit_of(audit, settings, responses))["backup.abb_offsite"]["status"] == (
        "warning"
    )


async def test_coverage_leaves_the_active_backup_folders_out(audit, settings):
    tasks = [task(1, "Postes", 2, 2, [device(7, "atelier-mac")])]
    responses = with_abb(tasks, [backed_up(7, 1)], storages=("docker",))
    checks = await audit_of(audit, settings, responses)
    assert "docker" not in checks["backup.coverage"]["items"]


def test_now_is_the_report_time():
    assert datetime.fromtimestamp(NOW, UTC) == AT.replace(microsecond=0)


async def test_recycle_bin_leaves_backup_destinations_out(audit, settings):
    tasks = [task(1, "Postes", 2, 2, [device(7, "atelier-mac")])]
    # « essai » tient lieu ici de dossier d'Active Backup ; « sauvegardes » reçoit Hyper Backup.
    responses = with_abb(tasks, [backed_up(7, 1)], storages=("essai",))
    checks = await audit_of(audit, settings, responses)
    assert checks["shares.recycle_bin"]["items"] == ["docker", "homes"]


# Sur la forme réelle (réponses synthétiques `abb_*`) ------------------------------------------

FIXTURE_NOW = datetime(2026, 11, 26, tzinfo=UTC)


async def shaped_checks(audit, settings, *, hours_later=0, change=None, lang=None):
    from datetime import timedelta

    from nas_agent.catalog.ops import build_catalog
    from nas_agent.engine import Engine
    from tests.conftest import FakeDsm, principal
    from tests.test_activebackup_ops import shaped

    responses = nas_responses()
    responses.update(shaped())
    if change:
        change(responses)
    at = FIXTURE_NOW + timedelta(hours=hours_later)
    engine = Engine(build_catalog(), FakeDsm(responses), audit, settings, wall_clock=lambda: at)
    env = await engine.run(
        "audit.checks", {}, principal("audit:checks"), channel="rest", client_ip=None, lang=lang
    )
    return {c["id"]: c for c in env.data["checks"]}


async def test_shaped_all_on_time_even_the_canceled_laptop(audit, settings):
    checks = await shaped_checks(audit, settings)
    assert checks["backup.abb_devices"]["status"] == "ok"
    assert checks["backup.abb_devices"]["observed"] == "5 appareils sauvegardés à temps."


async def test_shaped_one_virtual_machine_fails_alone(audit, settings):
    def fail_erp(responses):
        for d in responses["SYNO.ActiveBackup.Device.list"]["devices"]:
            if d["host_name"] == "vm-erp":
                d["last_result"]["status"] = 4

    checks = await shaped_checks(audit, settings, change=fail_erp)
    assert checks["backup.abb_devices"]["status"] == "failed"
    assert checks["backup.abb_devices"]["items"] == ["vm-erp : dernière sauvegarde en échec"]


async def test_shaped_lateness_follows_the_schedule(audit, settings):
    # Deux jours plus tard : les machines virtuelles, sauvegardées chaque jour, sont en retard ;
    # le poste de l'accueil, du lundi au vendredi, a droit à 74 h ; le portable, à 7 jours.
    checks = await shaped_checks(audit, settings, hours_later=48, lang="en")
    found = checks["backup.abb_devices"]
    assert found["status"] == "failed"
    assert found["items"] == [
        "vm-compta: last success 2 days ago",
        "vm-erp: last success 2 days ago",
        "vm-messagerie: last success 2 days ago",
    ]
