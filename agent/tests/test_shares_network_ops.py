import json

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmError
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

SHARES = "SYNO.Core.Share.list"
SNAPS = "SYNO.Core.Share.Snapshot.list"
SCHEDULE = "SYNO.Core.Share.Snapshot.get_schedule"
NETWORK = "SYNO.Core.Network.get"
INTERFACES = "SYNO.Core.Network.Interface.list"
SERVICES = "SYNO.Core.Service.get"
SLUGS = {
    "Compta été": "compta_ete",
    "docker": "docker",
    "essai": "essai",
    "homes": "homes",
    "sauvegardes": "sauvegardes",
}


def real(name):
    return load_fixture(f"ds420p_dsm741_{name}")


def by_share(kind):
    """Réponse réelle du dossier demandé ; le nom arrive encodé en JSON, comme DSM l'attend."""
    return lambda params: real(f"snapshot_{kind}_{SLUGS[json.loads(params['name'])]}")


def share_responses():
    return {SHARES: real("share_list"), SNAPS: by_share("list"), SCHEDULE: by_share("schedule")}


async def run(responses, audit, settings, op, *scopes):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    p = principal(*(scopes or ("storage:read", "system:read")))
    env = await engine.run(op, {}, p, channel="rest", client_ip=None)
    return env.data, dsm


def by_name(data):
    return {s["name"]: s for s in data["shares"]}


# Réponses réelles du NAS d'essai (DS420+, DSM 7.4.1), nettoyées : la forme qui fait foi.


async def test_shares_real_ds420p_dsm741(audit, settings):
    data, dsm = await run(share_responses(), audit, settings, "shares.list")
    assert data["summary"] == {
        "total": 5,
        "encrypted": 0,
        "with_recycle_bin": 1,
        "with_snapshots": 2,
        "with_snapshot_schedule": 1,
    }
    assert by_name(data)["essai"] == {
        "name": "essai",
        "volume": "/volume1",
        "description": "NAS d'essai : Hyper Backup",
        "encrypted": False,
        "hidden": False,
        "usb": False,
        "recycle_bin": False,
        "recycle_bin_admins_only": False,
        "used_mib": 5.02,
        "quota_mib": None,
        "snapshots": {
            "supported": True,
            "count": 2,
            "locked": 0,
            "oldest_at": "2026-11-09T07:40:22+01:00",
            "latest_at": "2026-11-09T07:40:25+01:00",
            "scheduled": True,
            "next_scheduled_at": "2026-11-10T03:00:00",
        },
    }
    compta = by_name(data)["Compta été"]
    assert (compta["recycle_bin"], compta["recycle_bin_admins_only"]) == (True, True)
    assert (compta["snapshots"]["count"], compta["snapshots"]["locked"]) == (1, 1)
    assert compta["snapshots"]["scheduled"] is False
    assert by_name(data)["docker"]["snapshots"]["latest_at"] is None
    # Le nom accentué part encodé en JSON ; les instantanés cachés sont écartés, comme dans DSM.
    snap_calls = [c for c in dsm.calls if c[1] == "list" and c[0].endswith("Snapshot")]
    assert '"Compta été"' in [c[2]["name"] for c in snap_calls]
    assert all(c[2]["filter"] == '{"attr":["!hide==true"]}' for c in snap_calls)


async def test_share_without_snapshot_support(audit, settings):
    # Volume ext4 ou dossier USB : DSM refuse l'appel, la liste reste lisible.
    responses = share_responses()

    def refuse_essai(params):
        if json.loads(params["name"]) == "essai":
            raise DsmError(402)
        return by_share("list")(params)

    responses[SNAPS] = refuse_essai
    data, _ = await run(responses, audit, settings, "shares.list")
    essai = by_name(data)["essai"]["snapshots"]
    assert (essai["supported"], essai["count"], essai["latest_at"]) == (False, None, None)
    assert by_name(data)["Compta été"]["snapshots"]["supported"] is True
    assert data["summary"]["with_snapshots"] == 1


async def test_shares_beyond_limit_have_unknown_snapshots(audit, settings):
    shares = [{"name": f"d{i:03d}"} for i in range(70)]
    responses = {
        SHARES: {"shares": shares},
        SNAPS: lambda p: {"snapshots": [], "total": 0},
        SCHEDULE: lambda p: {"enable_snapshot_schedule": False},
    }
    data, _ = await run(responses, audit, settings, "shares.list")
    assert data["summary"]["total"] == 70
    assert by_name(data)["d000"]["snapshots"]["supported"] is True
    assert by_name(data)["d069"]["snapshots"] is None


async def test_shares_odd_shapes_give_none(audit, settings):
    responses = {
        SHARES: {"shares": [{"name": "x", "encryption": 1, "share_quota_used": "?"}, "cassé"]},
        SNAPS: lambda p: {"snapshots": [{"time": "hier"}, "cassé"], "total": 2},
        SCHEDULE: lambda p: {"schedule": "cassé"},
    }
    data, _ = await run(responses, audit, settings, "shares.list")
    share = data["shares"][0]
    assert (share["encrypted"], share["used_mib"], share["volume"]) == (True, None, None)
    assert share["snapshots"]["count"] == 2 and share["snapshots"]["latest_at"] is None
    assert share["snapshots"]["next_scheduled_at"] is None
    assert data["summary"]["total"] == 2


async def test_network_real_ds420p_dsm741(audit, settings):
    responses = {
        NETWORK: real("network_get"),
        INTERFACES: real("network_interfaces"),
        SERVICES: real("service_get"),
    }
    data, dsm = await run(responses, audit, settings, "network.overview")
    assert data["hostname"] == "<server_name>"
    assert data["gateway"] == {"address": "192.0.2.1", "interface": "eth0"}
    assert (data["dns_servers"], data["dns_manual"]) == (["192.0.2.1"], False)
    assert data["interfaces"][0] == {
        "name": "eth0",
        "kind": "lan",
        "connected": True,
        "address": "192.0.2.1",
        "netmask": "255.255.255.0",
        "dhcp": True,
        "speed_mbps": 1000,
    }
    assert [i["connected"] for i in data["interfaces"]] == [True, False, False]
    assert data["interfaces"][2]["address"] is None
    services = {s["id"]: s for s in data["services"]}
    assert services["ssh-shell"] == {"id": "ssh-shell", "enabled": True, "running": True}
    assert services["nfs-server"] == {"id": "nfs-server", "enabled": False, "running": False}
    # « static » : démarré par DSM selon ses besoins, sans réglage propre.
    assert services["synoscgi"] == {"id": "synoscgi", "enabled": None, "running": True}
    service_call = next(c for c in dsm.calls if c[0] == "SYNO.Core.Service")
    assert service_call[2] == {"additional": '["active_status"]'}


async def test_network_needs_system_read(audit, settings):
    responses = {NETWORK: {}, INTERFACES: {}, SERVICES: {}}
    with pytest.raises(OpError) as info:
        await run(responses, audit, settings, "network.overview", "storage:read")
    assert info.value.status == 403


def test_shares_and_network_scopes_and_verification():
    catalog = build_catalog()
    for op_id, scope in (("shares.list", "storage:read"), ("network.overview", "system:read")):
        op = catalog.get(op_id)
        assert op.scope == scope and op.kind == "read" and not op.personal
        assert "DS420+" in (op.verified_on or "")
