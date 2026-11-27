import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmError, DsmUnsupported
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

LIST = "SYNO.Backup.Task.list"
STATUS = "SYNO.Backup.Task.status"
REPOS = "SYNO.Backup.Repository.list"
GET = "SYNO.Backup.Task.get"
TARGET = "SYNO.Backup.Target.get"
LOGS = "SYNO.SDS.Backup.Client.Common.Log.list"


def status_of(**by_id):
    """Réponse de `status` selon la tâche demandée, comme DSM la donne pour une seule tâche."""
    return lambda params: by_id[f"t{params['task_id']}"]


def real_responses():
    return {
        LIST: load_fixture("ds420p_dsm741_backup_task_list"),
        STATUS: status_of(t1=load_fixture("ds420p_dsm741_backup_task_status")),
        REPOS: load_fixture("ds420p_dsm741_backup_repository_list"),
        # Réponses du 2026-11-06 : pas encore de planning ni de contrôle d'intégrité.
        GET: {},
        TARGET: {},
    }


def sched(name):
    return load_fixture(f"ds420p_dsm741_backup_sched_{name}")


def scheduled_responses():
    return {
        LIST: sched("list"),
        STATUS: status_of(t1=sched("status_1"), t2=sched("status_2")),
        REPOS: sched("repository_list"),
        GET: status_of(t1=sched("get_1"), t2=sched("get_2")),
        TARGET: status_of(t1=sched("target_1"), t2=sched("target_2")),
    }


async def run(responses, audit, settings, op="backup.hyperbackup.tasks", **params):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    env = await engine.run(op, params, principal("backup:read"), channel="rest", client_ip=None)
    return env.data, dsm


# Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées : la forme qui fait foi.


async def test_tasks_real_ds420p_dsm741(audit, settings):
    data, dsm = await run(real_responses(), audit, settings)
    assert data["summary"] == {"tasks_total": 1, "tasks_running": 0, "tasks_failed": 0}
    assert data["restoring"] is False
    assert data["tasks"] == [
        {
            "id": 1,
            "name": "Essai local",
            "kind": "image:image_local",
            "destination_share": "sauvegardes",
            "destination_target": "essai.hbk",
            "encrypted": False,
            "sources": [{"path": "/essai", "missing": False}],
            "apps": [],
            "state": "backupable",
            "running": False,
            "last_result": "done",
            "last_started_at": "2026-11-06T16:08:29",
            "last_ended_at": "2026-11-06T16:08:41",
            "last_success_at": "2026-11-06T16:08:41",
            "last_error": None,
            "failed": False,
            "schedule": None,
            "integrity_check": {
                "last_at": None,
                "never_checked": True,
                "scheduled": False,
                "next_run_at": None,
            },
        }
    ]
    # La liste et l'état demandés comme l'interface de Hyper Backup, en version 1.
    status_calls = [c for c in dsm.calls if c[1] == "status"]
    assert [c[2]["task_id"] for c in status_calls] == [1]
    assert status_calls[0][2]["blOnline"] == "false"


async def test_tasks_without_any_task(audit, settings):
    responses = {
        LIST: {"task_list": [], "total": 0},
        STATUS: status_of(),
        REPOS: {"repo_list": []},
        GET: status_of(),
        TARGET: status_of(),
    }
    data, dsm = await run(responses, audit, settings)
    assert data["summary"] == {"tasks_total": 0, "tasks_running": 0, "tasks_failed": 0}
    assert data["tasks"] == [] and not [c for c in dsm.calls if c[1] == "status"]


async def test_tasks_running_is_not_failed(audit, settings):
    responses = real_responses()
    running = dict(load_fixture("ds420p_dsm741_backup_task_status"))
    running.update(status="backup", last_bkp_result="backingup")
    responses[STATUS] = status_of(t1=running)
    data, _ = await run(responses, audit, settings)
    assert data["summary"] == {"tasks_total": 1, "tasks_running": 1, "tasks_failed": 0}
    assert data["tasks"][0]["running"] is True and data["tasks"][0]["failed"] is False


async def test_tasks_odd_shapes_give_none(audit, settings):
    responses = {
        LIST: {"task_list": [{"task_id": 3, "name": "x", "source": "cassé"}, "pas une tâche"]},
        STATUS: status_of(t3={"last_bkp_time": "hier", "schedule": "cassé"}),
        REPOS: {"repo_list": "cassé"},
        GET: status_of(t3={"incheck_schedule": {"schedule": "cassé"}}),
        TARGET: status_of(t3={"last_detect_time": 12}),
    }
    data, _ = await run(responses, audit, settings)
    task = data["tasks"][0]
    assert (task["id"], task["sources"], task["destination_share"]) == (3, [], None)
    assert task["last_started_at"] is None and task["last_result"] is None
    assert task["schedule"] is None
    assert task["integrity_check"] == {
        "last_at": None,
        "never_checked": None,
        "scheduled": None,
        "next_run_at": None,
    }
    assert data["summary"]["tasks_total"] == 1


async def test_tasks_without_hyper_backup_is_unsupported(audit, settings):
    with pytest.raises(OpError) as info:
        await run({LIST: DsmUnsupported("SYNO.Backup.Task")}, audit, settings)
    assert info.value.status == 501 and info.value.code == "unsupported"


async def test_logs_real_ds420p_dsm741(audit, settings):
    responses = {LOGS: load_fixture("ds420p_dsm741_backup_log_list")}
    data, dsm = await run(responses, audit, settings, op="backup.hyperbackup.logs", limit=20)
    assert data["counts"] == {"info": 3, "warning": 0, "error": 0}
    assert data["total"] == 3
    assert data["entries"][0] == {
        "time": "2026-11-06T16:08:41",
        "level": "info",
        "event": "[Local][Essai local] Backup task finished successfully. "
        "[4 files scanned] [4 new files]",
        "task": "Essai local",
        "outcome": "success",
    }
    # Le compte qui a lancé l'action n'est pas rendu : `backup:read` ne donne pas les comptes.
    assert all("user" not in e for e in data["entries"])
    assert dsm.calls == [("SYNO.SDS.Backup.Client.Common.Log", "list", {"offset": 0, "limit": 20})]


async def test_logs_limit_is_bounded(audit, settings):
    with pytest.raises(OpError) as info:
        await run({LOGS: {}}, audit, settings, op="backup.hyperbackup.logs", limit=10_000)
    assert info.value.status == 422


def test_backup_ops_need_backup_read_and_are_verified():
    catalog = build_catalog()
    for op_id in ("backup.hyperbackup.tasks", "backup.hyperbackup.logs"):
        op = catalog.get(op_id)
        assert op.scope == "backup:read" and op.kind == "read" and not op.personal
        assert "DS420+" in (op.verified_on or "")


async def test_failed_task_real_ds420p_dsm741(audit, settings):
    # Destination rendue non modifiable pendant la sauvegarde : vraie panne, relevée le 2026-11-08.
    responses = {
        LIST: load_fixture("ds420p_dsm741_backup_2tasks_list"),
        STATUS: status_of(
            t1=load_fixture("ds420p_dsm741_backup_2tasks_status_1"),
            t2=load_fixture("ds420p_dsm741_backup_2tasks_status_2"),
        ),
        REPOS: load_fixture("ds420p_dsm741_backup_2tasks_repository_list"),
        GET: {},
        TARGET: {},
    }
    data, _ = await run(responses, audit, settings)
    assert data["summary"] == {"tasks_total": 2, "tasks_running": 0, "tasks_failed": 1}
    failed, ok = data["tasks"]
    assert (failed["name"], failed["failed"], ok["failed"]) == ("Essai en échec", True, False)
    assert failed["last_result"] == "failed_checking"
    assert failed["last_started_at"] == "2026-11-08T17:05:36"
    # DSM garde la dernière réussite, mais ne donne ni texte d'erreur ni code utile (4401).
    assert failed["last_success_at"] == "2026-11-08T16:57:38"
    assert failed["last_error"] is None


async def test_logs_errors_real_and_account_masked(audit, settings):
    responses = {LOGS: load_fixture("ds420p_dsm741_backup_2tasks_log_list")}
    data, _ = await run(responses, audit, settings, op="backup.hyperbackup.logs")
    assert data["counts"] == {"info": 13, "warning": 0, "error": 2}
    failure, cause = data["entries"][0], data["entries"][1]
    assert failure == {
        "time": "2026-11-08T17:05:46",
        "level": "error",
        "event": "[Local][Essai en échec] Failed to run backup task.",
        "task": "Essai en échec",
        "outcome": "failure",
    }
    # Le compte cité dans le texte est masqué, comme le champ `user`.
    assert "[User: <account>, Path: /volume1/sauvegardes/echec.hbk" in cause["event"]
    assert "Reason: disk I/O error" in cause["event"]


async def test_logs_mask_any_account_in_text(audit, settings):
    entry = {"event": "[Local][T] x [User: jean.dupont, Path: /a]", "level": "warn", "time": "?"}
    data, _ = await run(
        {LOGS: {"log_list": [entry]}}, audit, settings, op="backup.hyperbackup.logs"
    )
    assert data["entries"] == [
        {
            "time": None,
            "level": "warning",
            "event": "[Local][T] x [User: <account>, Path: /a]",
            "task": "T",
            "outcome": None,
        }
    ]


async def test_task_error_text_masks_account(audit, settings):
    # Même forme que le journal : le texte d'erreur d'une tâche peut citer un compte.
    responses = real_responses()
    broken = dict(load_fixture("ds420p_dsm741_backup_task_status"))
    broken.update(
        last_bkp_result="failed", last_bkp_error="I/O [User: jean.dupont, Path: /volume1/x]"
    )
    responses[STATUS] = status_of(t1=broken)
    data, _ = await run(responses, audit, settings)
    assert data["tasks"][0]["last_error"] == "I/O [User: <account>, Path: /volume1/x]"


async def test_home_folder_source_masks_account(audit, settings):
    responses = real_responses()
    listing = load_fixture("ds420p_dsm741_backup_task_list")
    listing["task_list"][0]["source"]["file_list"] = [
        {"folderPath": "/homes/jean.dupont/Photos", "missing": False},
        {"folderPath": "/homes", "missing": False},
    ]
    responses[LIST] = listing
    data, _ = await run(responses, audit, settings)
    assert [s["path"] for s in data["tasks"][0]["sources"]] == ["/homes/<account>/Photos", "/homes"]


async def test_tasks_scheduled_real_ds420p_dsm741(audit, settings):
    # « Essai local » planifiée chaque jour à 3 h, contrôle d'intégrité le dimanche à 4 h,
    # lancé le 2026-11-09 à 10 h 35 ; « Essai en échec » sans planning.
    data, dsm = await run(scheduled_responses(), audit, settings)
    failed, daily = data["tasks"]
    assert daily["name"] == "Essai local"
    assert daily["schedule"] == {
        "enabled": True,
        "week_days": [0, 1, 2, 3, 4, 5, 6],
        "hour": 3,
        "minute": 0,
        "repeat_every_hours": None,
        "max_gap_hours": 24,
        "next_run_at": "2026-11-10T03:00:00",
    }
    assert daily["integrity_check"] == {
        "last_at": "2026-11-09T10:35:00",
        "never_checked": False,
        "scheduled": True,
        "next_run_at": "2026-11-15T04:00:00",
    }
    assert failed["schedule"] is None
    assert failed["integrity_check"] == {
        "last_at": None,
        "never_checked": True,
        "scheduled": False,
        "next_run_at": None,
    }
    # Appels de l'interface de Hyper Backup, un par tâche, sans demander la destination en ligne.
    gets = [c for c in dsm.calls if c[:2] == ("SYNO.Backup.Task", "get")]
    assert sorted(c[2]["task_id"] for c in gets) == [1, 2]
    assert gets[0][2]["additional"] == '["incheck_schedule"]'
    targets = [c for c in dsm.calls if c[0] == "SYNO.Backup.Target"]
    assert sorted(c[2]["task_id"] for c in targets) == [1, 2] and "additional" not in targets[0][2]


@pytest.mark.parametrize(
    ("week_name", "repeat_hour", "gap", "every"),
    [
        ("1,3,5", 0, 72, None),  # du vendredi au lundi
        ("0", 0, 168, None),
        ("1,2,3,4,5", 4, 72, 4),  # répétée toutes les 4 h en semaine : écart au plus du week-end
        ("", 0, None, None),
    ],
)
async def test_schedule_max_gap(audit, settings, week_name, repeat_hour, gap, every):
    responses = scheduled_responses()
    status = sched("status_1")
    status["schedule"]["schedule"].update(week_name=week_name, repeat_hour=repeat_hour)
    responses[STATUS] = status_of(t1=status, t2=sched("status_2"))
    data, _ = await run(responses, audit, settings)
    schedule = data["tasks"][1]["schedule"]
    assert (schedule["max_gap_hours"], schedule["repeat_every_hours"]) == (gap, every)


async def test_schedule_not_weekly_has_no_gap(audit, settings):
    # Planning à date fixe : l'écart entre deux lancements n'est pas lisible ici.
    responses = scheduled_responses()
    status = sched("status_1")
    status["schedule"]["schedule"]["date_type"] = 1
    status["schedule"]["schedule_enable"] = False
    responses[STATUS] = status_of(t1=status, t2=sched("status_2"))
    data, _ = await run(responses, audit, settings)
    schedule = data["tasks"][1]["schedule"]
    assert (schedule["enabled"], schedule["max_gap_hours"]) == (False, None)


async def test_integrity_reads_are_optional(audit, settings):
    responses = scheduled_responses()
    responses[GET] = DsmError(4400)
    responses[TARGET] = DsmUnsupported("SYNO.Backup.Target")
    data, _ = await run(responses, audit, settings)
    assert data["tasks"][1]["integrity_check"] == {
        "last_at": None,
        "never_checked": None,
        "scheduled": None,
        "next_run_at": None,
    }
    assert data["tasks"][1]["schedule"]["max_gap_hours"] == 24


async def test_logs_entries_carry_task_and_outcome(audit, settings):
    responses = {LOGS: load_fixture("ds420p_dsm741_backup_2tasks_log_list")}
    data, _ = await run(responses, audit, settings, op="backup.hyperbackup.logs", limit=50)
    entries = data["entries"]
    failed = next(e for e in entries if e["event"].endswith("Failed to run backup task."))
    assert (failed["task"], failed["outcome"]) == ("Essai en échec", "failure")
    done = [e for e in entries if e["outcome"] == "success"]
    assert len(done) == 5 and {e["task"] for e in done} == {"Essai en échec", "Essai local"}
    started = [e for e in entries if e["event"].endswith("Backup task started.")]
    assert started and all(e["outcome"] is None and e["task"] for e in started)
    created = next(e for e in entries if e["event"].startswith("Setting of backup task"))
    assert (created["task"], created["outcome"]) == (None, None)


@pytest.mark.parametrize(
    ("event", "task", "outcome"),
    [
        ("[Local][Nuit] Backup task finished successfully. [4 files scanned]", "Nuit", "success"),
        ("[Local][Nuit] Failed to run backup task.", "Nuit", "failure"),
        ("[Local][Nuit] Backup task failed.", "Nuit", "failure"),
        ("[Remote][Nuit] Backup task was partially completed.", "Nuit", "partial"),
        ("[Local][Nuit] La tâche de sauvegarde est terminée.", "Nuit", None),
        ("Setting of backup task [Nuit] was created to backup to [x]", None, None),
    ],
)
async def test_logs_outcome_rules(audit, settings, event, task, outcome):
    entry = {"event": event, "level": "info", "time": "?"}
    data, _ = await run(
        {LOGS: {"log_list": [entry]}}, audit, settings, op="backup.hyperbackup.logs"
    )
    got = data["entries"][0]
    assert (got["task"], got["outcome"]) == (task, outcome)
