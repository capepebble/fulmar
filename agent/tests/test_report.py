"""Le bilan du mois (conception 2026-11-26-bilan-du-mois) : le journal des verdicts, puis
`report.month` sur un historique, un journal et des mises à jour construits."""

from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine, OpError
from nas_agent.history import HistoryStore
from nas_agent.verdicts import VerdictLog
from tests.conftest import FakeDsm, principal

NOV = datetime(2026, 11, 1, tzinfo=UTC)


def test_the_log_keeps_changes_only(conn):
    log = VerdictLog(conn)
    at = NOV + timedelta(days=11, hours=3)
    assert log.observe([("backup.task_result", "ok"), ("access.ssh", "warning")], at) == 2
    # Même état : rien ; inconnu : rien, l'état d'avant reste.
    assert log.observe([("backup.task_result", "ok"), ("access.ssh", "unknown")], at) == 0
    assert log.observe([("backup.task_result", "failed")], at + timedelta(minutes=10)) == 1
    events = log.events(NOV, NOV + timedelta(days=30))
    assert [(e.check_id, e.previous, e.status) for e in events] == [
        ("backup.task_result", None, "ok"),
        ("access.ssh", None, "warning"),
        ("backup.task_result", "ok", "failed"),
    ]


def test_the_month_end_is_frozen_at_the_first_pass_of_the_next_month(conn):
    log = VerdictLog(conn)
    log.observe([("a.one", "ok"), ("a.two", "failed")], datetime(2026, 11, 30, 23, 50, tzinfo=UTC))
    log.observe([("a.one", "ok"), ("a.two", "ok")], datetime(2026, 12, 1, 0, 0, tzinfo=UTC))
    frozen = log.month_end("2026-11")
    assert frozen == {
        "ok": 1,
        "warning": 0,
        "failed": 1,
        "failing": [{"id": "a.two", "status": "failed"}],
    }
    assert log.month_end("2026-12") is None


def history_with_november(tmp_path):
    h = HistoryStore(tmp_path / "history.db")
    start = NOV + timedelta(days=1)
    for minute in range(0, 6 * 60):
        at = start + timedelta(minutes=minute)
        used = 400e9 + minute * 1e8
        h.record(
            at,
            [
                ("cpu_pct", "", 10.0 + (minute % 10)),
                ("memory_pct", "", 40.0),
                ("temperature_c", "", 45.0 + (5 if minute == 100 else 0)),
                ("volume_used_bytes", "volume_1", used),
                ("volume_total_bytes", "volume_1", 1000e9),
            ],
        )
    return h


async def test_report_month(audit, settings, tmp_path, conn):
    log = VerdictLog(conn)
    log.observe([("backup.task_result", "ok")], NOV + timedelta(days=2))
    log.observe([("backup.task_result", "failed")], NOV + timedelta(days=12, hours=3))
    log.observe([("backup.task_result", "ok")], NOV + timedelta(days=13, hours=3))
    log.observe([("access.ssh", "warning")], NOV + timedelta(days=20))
    audit.record(channel="rest", op="system.info", token_id="t", client_ip=None, outcome="ok")
    audit.record(channel="rest", op="packages.update", token_id="t", client_ip=None, outcome="ok")
    audit.record(channel="rest", op="access.close", token_id="t", client_ip=None, outcome="denied")
    history = history_with_november(tmp_path)
    engine = Engine(
        build_catalog(),
        FakeDsm({}),
        audit,
        settings,
        history=history,
        wall_clock=lambda: datetime(2026, 11, 26, 22, 0, tzinfo=UTC),
    )
    engine.verdicts = log
    env = await engine.run(
        "report.month",
        {"month": "2026-11"},
        principal("audit:checks"),
        channel="rest",
        client_ip=None,
    )
    data = env.data
    assert data["month"] == "2026-11" and data["in_progress"] is True
    incidents = [
        (i["check_id"], i["status"], i["recovered_at"] is not None) for i in data["incidents"]
    ]
    # access.ssh n'a qu'un premier relevé : pas un incident du mois.
    assert incidents == [("backup.task_result", "failed", True)]
    assert data["incidents"][0]["title"]
    assert data["vitals"]["cpu_max"] == 19.0 and data["vitals"]["temperature_max"] == 50.0
    [vol] = data["volumes"]
    assert vol["volume"] == "volume_1" and vol["end_pct"] > vol["start_pct"]
    assert 0 < data["availability"]["read_pct"] <= 100
    assert data["fulmar"]["calls"] >= 3 and data["fulmar"]["denied"] >= 1
    assert {"op": "packages.update", "count": 1} in data["fulmar"]["writes"]
    assert data["end_state"]["source"] == "current"
    history.close()


async def test_report_refuses_a_bad_month(audit, settings):
    engine = Engine(build_catalog(), FakeDsm({}), audit, settings)
    with pytest.raises(OpError) as bad:
        await engine.run(
            "report.month",
            {"month": "2026-13"},
            principal("audit:checks"),
            channel="rest",
            client_ip=None,
        )
    assert bad.value.status == 422


async def test_report_without_history_says_not_recorded(audit, settings, conn):
    engine = Engine(build_catalog(), FakeDsm({}), audit, settings)
    engine.verdicts = VerdictLog(conn)
    env = await engine.run(
        "report.month",
        {"month": "2026-10"},
        principal("audit:checks"),
        channel="rest",
        client_ip=None,
    )
    assert env.data["vitals"] is None and env.data["availability"]["read_pct"] is None
    assert env.data["end_state"]["source"] == "none"


async def test_a_first_reading_is_not_an_incident(audit, settings, conn):
    """Le premier relevé d'un contrôle déjà en alerte n'est pas un changement du mois."""
    log = VerdictLog(conn)
    log.observe([("access.ssh", "warning"), ("backup.task_result", "ok")], NOV + timedelta(days=26))
    log.observe([("backup.task_result", "failed")], NOV + timedelta(days=26, hours=1))
    engine = Engine(build_catalog(), FakeDsm({}), audit, settings)
    engine.verdicts = log
    env = await engine.run(
        "report.month",
        {"month": "2026-11"},
        principal("audit:checks"),
        channel="rest",
        client_ip=None,
    )
    assert [i["check_id"] for i in env.data["incidents"]] == ["backup.task_result"]
    # Il reste dans l'état de fin.
    assert {f["id"] for f in env.data["end_state"]["failing"]} == {
        "access.ssh",
        "backup.task_result",
    }
