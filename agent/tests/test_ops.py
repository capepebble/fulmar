import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

ALL = ("system:read", "storage:read", "audit:read")


def engine_with(responses, audit, settings):
    return Engine(build_catalog(), FakeDsm(responses), audit, settings)


async def run(engine, op, *scopes, **params):
    env = await engine.run(op, params, principal(*(scopes or ALL)), channel="rest", client_ip=None)
    return env.data


def test_catalog_builds_and_every_op_has_a_result():
    catalog = build_catalog()
    ids = [op.id for op in catalog]
    assert {
        "agent.info",
        "agent.audit",
        "system.info",
        "system.utilization",
        "storage.overview",
    } <= set(ids)
    for op in catalog:
        assert op.result_model is not None and op.description


async def test_system_info(audit, settings):
    e = engine_with({"SYNO.DSM.Info.getinfo": load_fixture("dsm_info")}, audit, settings)
    data = await run(e, "system.info")
    assert data["model"] == "DS918+"
    assert data["dsm_version"] == "DSM 7.2.2-72806 Update 3"
    assert data["ram_mb"] == 4096 and data["temperature_c"] == 40
    assert "_source" not in data and "codepage" not in data


async def test_system_info_missing_fields_give_none(audit, settings):
    e = engine_with({"SYNO.DSM.Info.getinfo": {"model": "DS224+"}}, audit, settings)
    data = await run(e, "system.info")
    assert data["model"] == "DS224+" and data["uptime_s"] is None and data["serial"] is None


async def test_utilization(audit, settings):
    e = engine_with(
        {"SYNO.Core.System.Utilization.get": load_fixture("system_utilization")}, audit, settings
    )
    data = await run(e, "system.utilization")
    assert data["cpu"]["total_pct"] == 9
    assert data["memory"]["real_usage_pct"] == 24
    assert data["network"][0] == {"device": "total", "rx_bps": 109549, "tx_bps": 45097}
    assert data["disks"][0]["name"] == "Drive 3"
    assert data["volumes"][0]["name"] == "volume1"


async def test_utilization_empty_response(audit, settings):
    e = engine_with({"SYNO.Core.System.Utilization.get": {}}, audit, settings)
    data = await run(e, "system.utilization")
    assert data["cpu"]["total_pct"] is None and data["network"] == []


async def test_storage_overview(audit, settings):
    e = engine_with(
        {"SYNO.Storage.CGI.Storage.load_info": load_fixture("storage_load_info")}, audit, settings
    )
    data = await run(e, "storage.overview")
    assert data["summary"] == {
        "disks_total": 2,
        "disks_unhealthy": 1,
        "volumes_total": 1,
        "volumes_not_normal": 0,
        "pools_not_normal": 0,
    }
    vol = data["volumes"][0]
    assert vol["path"] == "/volume1" and vol["used_pct"] == 69.6
    disk = data["disks"][1]
    assert disk["smart_status"] == "warning" and disk["healthy"] is False
    assert data["disks"][0]["model"] == "WD80EFAX-68KNBN0"  # espaces retirés


# Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées : la forme qui fait foi.


async def test_system_info_real_ds420p_dsm741(audit, settings):
    e = engine_with(
        {"SYNO.DSM.Info.getinfo": load_fixture("ds420p_dsm741_dsm_info")}, audit, settings
    )
    data = await run(e, "system.info")
    assert data["model"] == "DS420+" and data["ram_mb"] == 2048
    assert data["dsm_version"] == "DSM 7.4.1-90080 Update 1" and data["dsm_build"] == "90080"
    assert data["serial"] == "<serial>" and data["temperature_warning"] is False


async def test_utilization_real_ds420p_dsm741(audit, settings):
    raw = load_fixture("ds420p_dsm741_system_utilization")
    e = engine_with({"SYNO.Core.System.Utilization.get": raw}, audit, settings)
    data = await run(e, "system.utilization")
    assert data["cpu"]["total_pct"] == 3 and data["memory"]["real_usage_pct"] == 22
    # DSM donne les charges moyennes en centièmes : 5 pour 0,05 dans /proc/loadavg.
    cpu = data["cpu"]
    assert (cpu["load_1m"], cpu["load_5m"], cpu["load_15m"]) == (0.05, 0.01, 0.03)
    assert [n["device"] for n in data["network"]] == ["total", "eth0", "eth1"]
    assert data["disks"][0]["device"] == "sata1" and data["volumes"][0]["name"] == "volume1"


async def test_storage_overview_real_ds420p_dsm741(audit, settings):
    raw = load_fixture("ds420p_dsm741_storage_load_info")
    e = engine_with({"SYNO.Storage.CGI.Storage.load_info": raw}, audit, settings)
    data = await run(e, "storage.overview")
    assert data["summary"] == {
        "disks_total": 1,
        "disks_unhealthy": 0,
        "volumes_total": 1,
        "volumes_not_normal": 0,
        "pools_not_normal": 0,
    }
    vol = data["volumes"][0]
    assert (vol["path"], vol["fs_type"], vol["raid"]) == (
        "/volume1",
        "btrfs",
        "shr_without_disk_protect",
    )
    disk = data["disks"][0]
    # DSM 7.4 rend exceed_bad_sector_thr à null sur un disque sain : pas un défaut.
    assert disk["bad_sectors_exceeded"] is None and disk["healthy"] is True
    assert disk["serial"] == "<serial>"


def test_dsm_ops_verified_on_test_nas():
    catalog = build_catalog()
    for op_id in ("system.info", "system.utilization", "storage.overview"):
        assert "DS420+" in (catalog.get(op_id).verified_on or "")


async def test_storage_odd_shapes(audit, settings):
    odd = {"disks": [{"id": "sda", "status": None, "temp": "n/a"}], "volumes": "broken"}
    e = engine_with({"SYNO.Storage.CGI.Storage.load_info": odd}, audit, settings)
    data = await run(e, "storage.overview")
    assert data["disks"][0]["temperature_c"] is None and data["disks"][0]["healthy"] is False
    assert data["volumes"] == []


async def test_agent_info_lists_only_visible_ops(audit, settings):
    e = engine_with({}, audit, settings)
    data = await run(e, "agent.info", "system:read")
    assert "system.info" in data["operations"] and "storage.overview" not in data["operations"]
    assert data["scopes"] == ["system:read"]


async def test_agent_audit_needs_scope_and_reports_chain(audit, settings):
    e = engine_with({}, audit, settings)
    with pytest.raises(OpError):
        await run(e, "agent.audit", "system:read")
    data = await run(e, "agent.audit", "audit:read", limit=5)
    assert data["chain_ok"] is True and data["entries"][0]["code"] == "forbidden"
    with pytest.raises(OpError):
        await run(e, "agent.audit", "audit:read", limit=1000)
