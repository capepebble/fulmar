"""security.logins et files.activity : les signes d'attaque des 24 dernières heures, sur les
vraies lignes du NAS d'essai (2026-11-26)."""

import copy

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine
from tests.conftest import FakeDsm, load_fixture, principal

LOG = "SYNO.Core.SyslogClient.Log.list"
TRANSFER = "SYNO.Core.SyslogClient.FileTransfer.get"


def real(name):
    return load_fixture(f"ds420p_dsm741_{name}")


async def run(responses, audit, settings, op):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    env = await engine.run(op, {}, principal("personal:read"), channel="rest", client_ip=None)
    return env.data, dsm


async def test_real_ds420p_login_failures(audit, settings):
    data, dsm = await run(
        {LOG: real("log_connection_failures")}, audit, settings, "security.logins"
    )
    assert (data["successes"], data["failures"], data["read"], data["truncated"]) == (
        5,
        3,
        8,
        False,
    )
    assert data["by_address"] == [
        {"address": "192.0.2.1", "failures": 3, "last_at": "2026-11-06T15:18:56"}
    ]
    assert data["by_account"] == [
        {"account": "claude", "failures": 1},
        {"account": "nas-agent-sonde", "failures": 1},
    ]
    assert data["latest_failures"][0] == {
        "time": "2026-11-06T15:18:56",
        "account": "claude",
        "address": "192.0.2.1",
        "service": "SSH",
    }
    assert data["latest_failures"][1]["account"] is None
    # Une rafale : les trois échecs du 6 ne tiennent pas en 10 minutes.
    assert data["max_burst"] == 1
    (_, _, params) = next(c for c in dsm.calls if c[1] == "list")
    assert params["logtype"] == "connection" and params["date_from"] > 0
    assert params["limit"] == 1000


async def test_a_burst_of_failures(audit, settings):
    log = real("log_connection_failures")
    failure = next(i for i in log["items"] if i["level"] == "warn")
    burst = []
    for second in range(25):
        item = copy.deepcopy(failure)
        item["time"] = f"2026/11/26 03:1{second // 10}:{second % 10 * 6:02d}"
        item["descr"] = item["descr"].replace("192.0.2.1", f"203.0.113.{second % 3}")
        burst.append(item)
    log = {**log, "items": burst + log["items"], "total": 33}
    data, _ = await run({LOG: log}, audit, settings, "security.logins")
    assert data["failures"] == 28 and data["max_burst"] >= 20
    assert data["by_address"][0]["failures"] == 9


async def test_real_ds420p_file_activity(audit, settings):
    responses = {LOG: real("log_files"), TRANSFER: real("file_transfer_settings")}
    data, _ = await run(responses, audit, settings, "files.activity")
    assert (data["deletions"], data["renames_moves"], data["max_burst"]) == (2, 2, 4)
    assert data["logging"]["smb"] is True and data["logging"]["file_station"] is True
    assert data["by_account"] == [
        {"account": "claude", "deletions": 2, "renames_moves": 2, "max_burst": 4}
    ]


async def test_mass_deletion_burst(audit, settings):
    files = real("log_files")
    delete = next(i for i in files["items"] if i["cmd"] == "delete")
    many = []
    for n in range(240):
        item = copy.deepcopy(delete)
        item["descr"] = f"/essai/document-{n}.pdf"
        item["isdir"] = "false"
        item["time"] = f"2026/11/26 02:0{n // 60}:{n % 60:02d}"
        item["orginalLogType"] = "smbxfer"
        many.append(item)
    responses = {
        LOG: {**files, "items": many + files["items"], "total": 246},
        TRANSFER: real("file_transfer_settings"),
    }
    data, _ = await run(responses, audit, settings, "files.activity")
    assert data["deletions"] == 242 and data["max_burst"] >= 240


async def test_a_forged_account_name_neither_hides_nor_moves_a_failure(audit, settings):
    """Le compte tapé est libre : « a] from [10.0.0.1 » ne cache pas l'échec ni ne change
    l'adresse ; une ligne d'échec illisible reste comptée."""
    log = real("log_connection_failures")
    failure = next(i for i in log["items"] if i["level"] == "warn")
    forged = copy.deepcopy(failure)
    forged["descr"] = (
        "User [a] from [10.0.0.1] from [203.0.113.5] failed to sign in to [DSM] via [password] "
        "due to authorization failure."
    )
    odd = copy.deepcopy(failure)
    odd["descr"] = "User [b] failed to sign in somehow, in a shape DSM may use one day."
    log = {**log, "items": [forged, odd], "total": 2}
    data, _ = await run({LOG: log}, audit, settings, "security.logins")
    assert data["failures"] == 2
    assert data["by_address"] == [
        {"address": "203.0.113.5", "failures": 1, "last_at": "2026-11-06T15:18:56"}
    ]
    assert data["latest_failures"][0]["account"] == "a] from [10.0.0.1"
    assert data["latest_failures"][1] == {
        "time": "2026-11-06T15:18:56",
        "account": None,
        "address": None,
        "service": None,
    }
