"""containers.list : Container Manager, sur la vraie réponse du NAS d'essai."""

import copy

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmUnsupported
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

LIST = "SYNO.Docker.Container.list"
RESOURCES = "SYNO.Docker.Container.Resource.get"


def real():
    return {
        LIST: load_fixture("ds420p_dsm741_docker_container_list"),
        RESOURCES: load_fixture("ds420p_dsm741_docker_container_resource"),
    }


async def run(responses, audit, settings):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    env = await engine.run(
        "containers.list", {}, principal("system:read"), channel="rest", client_ip=None
    )
    return env.data, dsm


async def test_real_ds420p_five_running_containers(audit, settings):
    data, dsm = await run(real(), audit, settings)
    assert data["summary"] == {
        "total": 5,
        "running": 5,
        "stopped": 0,
        "restarting": 0,
        "unhealthy": 0,
    }
    names = [c["name"] for c in data["containers"]]
    assert names == sorted(names) and len(names) == 5
    agent = next(c for c in data["containers"] if c["name"] == "nas-agent")
    assert agent == {
        "name": "nas-agent",
        "image": "nas-agent:0.1.0",
        "project": "nas-agent",
        "state": "running",
        "exit_code": 0,
        "oom_killed": False,
        "health": None,
        "started_at": "2026-11-25T12:53:03Z",
        "cpu_pct": 0.15,
        "memory_bytes": 121610240,
        "memory_pct": 6.6,
    }
    assert ("SYNO.Docker.Container", "list", {"offset": 0, "limit": -1, "type": "all"}) in (
        dsm.calls
    )


async def test_no_label_address_or_environment_leaks(audit, settings):
    data, _ = await run(real(), audit, settings)
    text = str(data)
    for leak in ("Labels", "IPAddress", "MacAddress", "NetworkID", "com.docker", "sha256"):
        assert leak not in text


async def test_exited_restarting_unhealthy_and_oom(audit, settings):
    responses = real()
    rows = responses[LIST]["containers"]
    exited = copy.deepcopy(rows[0])
    exited["name"], exited["status"] = "job", "exited"
    exited["State"].update(Running=False, Status="exited", ExitCode=1, OOMKilled=True)
    looping = copy.deepcopy(rows[1])
    looping["name"], looping["status"] = "web", "restarting"
    looping["State"].update(Restarting=True, Status="restarting")
    sick = copy.deepcopy(rows[2])
    sick["name"] = "db"
    sick["State"]["Health"] = {"Status": "unhealthy", "FailingStreak": 3}
    responses[LIST] = {"containers": [exited, looping, sick], "total": 3}
    data, _ = await run(responses, audit, settings)
    by_name = {c["name"]: c for c in data["containers"]}
    assert (by_name["job"]["state"], by_name["job"]["exit_code"]) == ("exited", 1)
    assert by_name["job"]["oom_killed"] is True and by_name["job"]["cpu_pct"] is None
    assert by_name["web"]["state"] == "restarting"
    assert by_name["db"]["health"] == "unhealthy"
    assert data["summary"] == {
        "total": 3,
        "running": 1,
        "stopped": 1,
        "restarting": 1,
        "unhealthy": 1,
    }


async def test_without_container_manager(audit, settings):
    with pytest.raises(OpError) as err:
        await run(
            {LIST: DsmUnsupported("absent"), RESOURCES: DsmUnsupported("absent")}, audit, settings
        )
    assert err.value.code == "unsupported"
