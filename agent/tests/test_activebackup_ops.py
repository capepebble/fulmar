"""backup.activebackup : Active Backup for Business.

Réponses synthétiques à la forme relevée le 2026-11-26 sur un vrai NAS (machines virtuelles et
postes), toutes valeurs remplacées (`abb_*`) ; cas d'échec construits à la même forme.
"""

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmUnsupported
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

ACTIVATION = "SYNO.ActiveBackup.Activation.get"
TASKS = "SYNO.ActiveBackup.Task.list"
DEVICES = "SYNO.ActiveBackup.Device.list"
LAST = "SYNO.ActiveBackup.Overview.list_device_last_backup"
STORAGES = "SYNO.ActiveBackup.Share.list_storage"

# 2026-11-20 08:00:00 UTC, puis une heure plus tard.
T0, T1 = 1_795_161_600, 1_795_165_200


def synthetic(tasks, last=(), activated=True, storages=("ActiveBackupforBusiness",)):
    return {
        ACTIVATION: {"activated": activated},
        TASKS: {"tasks": list(tasks), "total": len(tasks)},
        DEVICES: {"devices": [], "total": 0},
        LAST: {"device_list": list(last), "total": len(last)},
        STORAGES: {"storages": [{"share_name": s} for s in storages]},
    }


def task(task_id, name, backup_type, status, devices=(), **extra):
    return {
        "task_id": task_id,
        "task_name": name,
        "backup_type": backup_type,
        "share_name": "ActiveBackupforBusiness",
        "devices": list(devices),
        "last_result": {"status": status, "time_start": T0, "time_end": T1}
        if status is not None
        else None,
        **extra,
    }


async def run(responses, audit, settings, scope="backup:read"):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    env = await engine.run(
        "backup.activebackup", {}, principal(scope), channel="rest", client_ip=None
    )
    return env.data, dsm


def shaped():
    return {
        ACTIVATION: load_fixture("abb_activation"),
        TASKS: load_fixture("abb_task_list"),
        DEVICES: load_fixture("abb_device_list"),
        LAST: load_fixture("abb_device_last_backup"),
        STORAGES: load_fixture("abb_list_storage"),
    }


async def test_the_real_shape(audit, settings):
    data, dsm = await run(shaped(), audit, settings)
    assert data["activated"] is True
    assert data["summary"] == {
        "tasks_total": 3,
        "devices_total": 5,
        "tasks_running": 0,
        "tasks_failed": 0,
    }
    vms, desk, laptop = data["tasks"]
    assert (vms["type"], vms["encrypted"], vms["max_gap_hours"]) == ("vm", False, 24)
    assert [d["name"] for d in vms["devices"]] == ["vm-compta", "vm-erp", "vm-messagerie"]
    # Du lundi au vendredi : le plus long écart, du vendredi au lundi.
    assert desk["max_gap_hours"] == 72
    # Annulée cette nuit : la dernière réussite reste celle d'il y a trois jours.
    assert laptop["last_result"] == "canceled"
    assert laptop["devices"][0]["last_result"] == "canceled"
    assert laptop["devices"][0]["last_success_at"] == "2026-11-23T00:30:00+00:00"
    assert vms["last_success_at"] == "2026-11-25T20:30:00+00:00"
    assert data["storages"] == ["ActiveBackupforBusiness"]
    assert (
        "SYNO.ActiveBackup.Device",
        "list",
        {"load_result": "true", "filter": '{"load_available":true}'},
    ) in dsm.calls


async def test_no_password_account_or_address_ever_comes_out(audit, settings):
    responses = shaped()
    device = responses[TASKS]["tasks"][0]["devices"][0]
    device.update(login_user="jean", host_ip="10.0.0.9", login_password="secret-1")
    data, _ = await run(responses, audit, settings)
    text = str(data)
    for value in ("jean", "10.0.0.9", "secret-1", "password", "login_user"):
        assert value not in text


async def test_types_results_and_last_success_per_device(audit, settings):
    mac = {"device_id": 7, "host_name": "atelier-mac", "os_name": "macOS 26", "login_user": "jean"}
    responses = synthetic(
        [
            task(1, "Postes", 2, 2, [mac], next_trigger_time=T1 + 86_400),
            task(2, "Serveur", 3, 4, [{"device_id": 8, "host_name": "srv-01"}]),
        ],
        last=[{"device_id": 7, "device_name": "atelier-mac", "time_start": T0}],
    )
    data, _ = await run(responses, audit, settings)
    assert data["activated"] is True
    assert data["summary"] == {
        "tasks_total": 2,
        "devices_total": 2,
        "tasks_running": 0,
        "tasks_failed": 1,
    }
    postes, serveur = data["tasks"]
    assert postes["type"] == "pc" and serveur["type"] == "server"
    assert postes["last_result"] == "success" and serveur["last_result"] == "failed"
    assert postes["devices"] == [
        {
            "id": 7,
            "name": "atelier-mac",
            "os": "macOS 26",
            "last_result": None,
            "last_success_at": "2026-11-20T08:00:00+00:00",
        }
    ]
    assert postes["next_run_at"] == "2026-11-21T09:00:00+00:00"
    assert serveur["failed"] is True and serveur["last_success_at"] is None
    assert data["storages"] == ["ActiveBackupforBusiness"]


async def test_never_returns_the_account_or_address_of_a_device(audit, settings):
    device = {"device_id": 7, "host_name": "pc", "login_user": "jean", "host_ip": "10.0.0.9"}
    data, _ = await run(synthetic([task(1, "Postes", 2, 2, [device])]), audit, settings)
    text = str(data)
    assert "jean" not in text and "10.0.0.9" not in text


async def test_without_the_package_the_read_is_unsupported(audit, settings):
    responses = synthetic([])
    responses[ACTIVATION] = DsmUnsupported("SYNO.ActiveBackup.Activation")
    with pytest.raises(OpError) as err:
        await run(responses, audit, settings)
    assert err.value.code == "unsupported"


async def test_optional_reads_may_fail(audit, settings):
    responses = synthetic([task(1, "Postes", 2, 2)])
    for key in (DEVICES, LAST, STORAGES):
        responses[key] = DsmUnsupported(key)
    data, _ = await run(responses, audit, settings)
    assert data["tasks"][0]["last_success_at"] == "2026-11-20T09:00:00+00:00"
    assert data["storages"] == ["ActiveBackupforBusiness"]


async def test_requires_backup_read(audit, settings):
    with pytest.raises(OpError) as err:
        await run(synthetic([]), audit, settings, scope="system:read")
    assert err.value.code == "forbidden"
