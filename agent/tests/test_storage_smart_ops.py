"""storage.smart et les ajouts de storage.overview (redondance, nettoyage des données)."""

import copy

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmError, DsmUnsupported
from nas_agent.engine import Engine
from tests.conftest import FakeDsm, load_fixture, principal

LOAD = "SYNO.Storage.CGI.Storage.load_info"
HEALTH = "SYNO.Storage.CGI.Smart.get_health_info"
TESTS = "SYNO.Core.Storage.Disk.get_smart_test_log"
SCHED = "SYNO.Storage.CGI.Smart.Scheduler.list"


def real():
    return {
        LOAD: load_fixture("ds420p_dsm741_storage_load_info_20261126"),
        HEALTH: lambda p: load_fixture("ds420p_dsm741_smart_health_sata1"),
        TESTS: lambda p: load_fixture("ds420p_dsm741_smart_test_log_sata1"),
        SCHED: load_fixture("ds420p_dsm741_smart_scheduler_list"),
    }


async def run(responses, audit, settings, op="storage.smart"):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    env = await engine.run(op, {}, principal("storage:read"), channel="rest", client_ip=None)
    return env.data, dsm


async def test_real_ds420p_disk_is_sound_and_old(audit, settings):
    data, dsm = await run(real(), audit, settings)
    (disk,) = data["disks"]
    assert {k: disk[k] for k in disk if k != "attributes"} == {
        "id": "sata1",
        "device": "/dev/sata1",
        "name": "Drive 1",
        "model": disk["model"],
        "is_ssd": False,
        "smart_status": "normal",
        "power_on_hours": 46982,
        "reallocated_sectors": 0,
        "pending_sectors": 0,
        "uncorrectable_sectors": 0,
        "reported_uncorrect": 0,
        "command_timeouts": 0,
        "crc_errors": 0,
        "ssd_life_pct": None,
        "failing_attributes": [],
        "last_test_result": "completed",
        "last_test_at": None,
    }
    power = next(a for a in disk["attributes"] if a["id"] == 9)
    assert power == {
        "id": 9,
        "name": "Power_On_Hours",
        "current": 47,
        "worst": 47,
        "threshold": 0,
        "raw": "46982",
        "status": "OK",
    }
    assert data["scheduled_tests"] == []
    assert ("SYNO.Storage.CGI.Smart", "get_health_info", {"device": "/dev/sata1"}) in dsm.calls


async def test_failing_disk_counts_and_scheduled_tests(audit, settings):
    health = load_fixture("ds420p_dsm741_smart_health_sata1")
    sick = copy.deepcopy(health)
    for attr in sick["healthInfo"]["smartInfo"]:
        if attr["id"] in ("5", "197", "199"):
            attr["raw"] = {"5": "24", "197": "8", "199": "3"}[attr["id"]]
    sick["healthInfo"]["overview"]["smart_fail"] = ["Reallocated_Sector_Ct"]
    log = load_fixture("ds420p_dsm741_smart_test_log_sata1")
    log["testInfo"][0]["latest_test_result"] = "damage"
    log["latest_test_time"] = "2026-11-20 03:00:12"
    responses = {
        **real(),
        HEALTH: lambda p: sick,
        TESTS: lambda p: log,
        # Champs lus par l'interface de DSM (Gestionnaire de stockage, planificateur de tests).
        SCHED: {
            "items": [
                {
                    "enabled": True,
                    "id": 1,
                    "can_run": True,
                    "task_name": "Test rapide",
                    "app_name": "Storage Manager",
                    "action": "S.M.A.R.T. Test - Quick test",
                    "next_trigger_time": "2026-11-29 03:00",
                },
                {
                    "enabled": False,
                    "id": 2,
                    "task_name": "Test étendu",
                    "action": "S.M.A.R.T. Test - Extended test",
                    "next_trigger_time": "",
                },
            ],
            "total": 2,
        },
    }
    data, _ = await run(responses, audit, settings)
    (disk,) = data["disks"]
    assert (disk["reallocated_sectors"], disk["pending_sectors"], disk["crc_errors"]) == (24, 8, 3)
    assert disk["failing_attributes"] == ["Reallocated_Sector_Ct"]
    assert (disk["last_test_result"], disk["last_test_at"]) == ("damage", "2026-11-20T03:00:12")
    assert data["scheduled_tests"] == [
        {
            "name": "Test rapide",
            "action": "S.M.A.R.T. Test - Quick test",
            "enabled": True,
            "next_run": "2026-11-29T03:00:00",
        },
        {
            "name": "Test étendu",
            "action": "S.M.A.R.T. Test - Extended test",
            "enabled": False,
            "next_run": None,
        },
    ]


async def test_ssd_life_and_missing_optional_reads(audit, settings):
    health = load_fixture("ds420p_dsm741_smart_health_sata1")
    health["healthInfo"]["overview"]["remain_life"] = {"trustable": True, "value": 7}
    health["healthInfo"]["overview"]["isSsd"] = True
    responses = {
        **real(),
        HEALTH: lambda p: health,
        TESTS: DsmError(105),
        SCHED: DsmUnsupported("absent"),
    }
    data, _ = await run(responses, audit, settings)
    (disk,) = data["disks"]
    assert (disk["is_ssd"], disk["ssd_life_pct"], disk["last_test_result"]) == (True, 7, None)
    assert data["scheduled_tests"] is None


async def test_overview_pool_redundancy_and_scrubbing(audit, settings):
    data, _ = await run(real(), audit, settings, op="storage.overview")
    (pool,) = data["pools"]
    assert (pool["raid"], pool["redundant"]) == ("shr_without_disk_protect", False)
    assert (pool["scrubbing_last_at"], pool["scrubbing_scheduled"]) == (None, False)
    assert data["scrubbing_schedule_enabled"] is False
    raid5 = load_fixture("ds420p_dsm741_storage_load_info_20261126")
    raid5["storagePools"][0].update(
        device_type="raid_5", last_done_time=1790000000, is_scheduled=True
    )
    raid5["env"]["data_scrubbing"]["sche_enabled"] = "1"
    data, _ = await run({LOAD: raid5}, audit, settings, op="storage.overview")
    (pool,) = data["pools"]
    assert (pool["redundant"], pool["scrubbing_last_at"]) == (True, "2026-09-21T14:13:20Z")
    assert data["scrubbing_schedule_enabled"] is True
