"""backup.activebackup_cloud et son contrôle : Active Backup for Microsoft 365 et for Google
Workspace, sur des réponses synthétiques à la forme relevée le 2026-11-26 sur un vrai NAS
(`abb365_*`, `abbgw_*`, toutes valeurs remplacées)."""

import copy
from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmUnsupported
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal
from tests.real_nas import nas_responses

M365_ACT = "SYNO.ActiveBackupOffice365.get_activation"
M365_TASKS = "SYNO.ActiveBackupOffice365.list_tasks"
GW_ACT = "SYNO.ActiveBackupGSuite.get_activation"
GW_TASKS = "SYNO.ActiveBackupGSuite.list_tasks"
# Les réponses synthétiques datent la dernière exécution de 2026-11-25 23:30 UTC.
NOW = datetime(2026, 11, 26, 1, tzinfo=UTC)


def shaped():
    return {
        M365_ACT: load_fixture("abb365_activation"),
        M365_TASKS: load_fixture("abb365_list_tasks"),
        GW_ACT: load_fixture("abbgw_activation"),
        GW_TASKS: load_fixture("abbgw_list_tasks"),
    }


async def run(responses, audit, settings, op="backup.activebackup_cloud", at=NOW, **kw):
    engine = Engine(build_catalog(), FakeDsm(responses), audit, settings, wall_clock=lambda: at)
    scope = "audit:checks" if op == "audit.checks" else "backup:read"
    env = await engine.run(op, {}, principal(scope), channel="rest", client_ip=None, **kw)
    return env.data


async def test_the_real_shape(audit, settings):
    data = await run(shaped(), audit, settings)
    m365 = data["microsoft365"]
    assert m365["activated"] is True
    (task,) = m365["tasks"]
    assert task["name"] == "Microsoft 365 du cabinet"
    assert (task["state"], task["state_code"], task["continuous"]) == ("active", 2, True)
    assert (task["last_result"], task["errors"], task["warnings"]) == ("success", 0, 0)
    assert task["last_run_at"] == "2026-11-25T23:30:00+00:00"
    assert task["accounts"] == 3 and task["max_gap_hours"] is None
    assert data["google_workspace"] == {"activated": True, "tasks": []}


async def test_never_an_account_name_or_address(audit, settings):
    data = await run(shaped(), audit, settings)
    text = str(data)
    assert "compte" not in text.lower() and "@" not in text


async def test_missing_packages_give_null(audit, settings):
    responses = {k: DsmUnsupported(k) for k in shaped()}
    data = await run(responses, audit, settings)
    assert data == {"microsoft365": None, "google_workspace": None}


async def test_requires_backup_read(audit, settings):
    engine = Engine(build_catalog(), FakeDsm(shaped()), audit, settings)
    with pytest.raises(OpError) as err:
        await engine.run(
            "backup.activebackup_cloud",
            {},
            principal("system:read"),
            channel="rest",
            client_ip=None,
        )
    assert err.value.code == "forbidden"


async def check(responses, audit, settings, at=NOW, lang=None):
    full = nas_responses()
    full.update(responses)
    data = await run(full, audit, settings, op="audit.checks", at=at, lang=lang)
    return {c["id"]: c for c in data["checks"]}["backup.cloud_accounts"]


async def test_check_on_time_and_not_applicable(audit, settings):
    found = await check(shaped(), audit, settings)
    assert (found["status"], found["observed"]) == ("ok", "1 tâche sauvegardée à temps.")
    found = await check({k: DsmUnsupported(k) for k in shaped()}, audit, settings, lang="en")
    assert found["observed"] == (
        "Not applicable: neither Active Backup for Microsoft 365 nor for Google Workspace."
    )


async def test_check_errors_inactive_late_and_not_activated(audit, settings):
    responses = shaped()
    task = responses[M365_TASKS]["tasks"][0]
    task.update(status=5, error_mail=3)
    found = await check(responses, audit, settings)
    assert found["status"] == "failed"
    assert found["items"] == [
        "Microsoft 365 du cabinet : dernière sauvegarde en erreur, 3 éléments en cause"
    ]
    task.update(status=1, error_mail=0, task_status=-3)
    found = await check(responses, audit, settings)
    assert found["items"] == ["Microsoft 365 du cabinet : tâche inactive (état -3)"]
    task.update(task_status=2)
    late = await check(responses, audit, settings, at=NOW + timedelta(days=2), lang="en")
    assert late["items"] == ["Microsoft 365 du cabinet: last run 2 days ago"]
    responses[M365_ACT] = {"activated": False}
    found = await check(responses, audit, settings)
    assert found["items"] == ["Microsoft 365 : paquet pas activé, aucune sauvegarde ne part"]


async def test_a_scheduled_task_waits_for_its_schedule(audit, settings):
    responses = shaped()
    task = responses[M365_TASKS]["tasks"][0]
    task.update(backup_policy=1)
    task["schedule"].update(date_type=0, week_day="1,2,3,4,5")
    # Du lundi au vendredi : 74 h admises.
    found = await check(responses, audit, settings, at=NOW + timedelta(hours=60))
    assert found["status"] == "ok"
    data = await run(copy.deepcopy(responses), audit, settings)
    assert data["microsoft365"]["tasks"][0]["max_gap_hours"] == 72
