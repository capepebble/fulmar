import asyncio
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmCertificateError, DsmError, DsmUnreachable, DsmUnsupported
from nas_agent.engine import Engine
from nas_agent.history import HistoryStore
from nas_agent.sampler import SAMPLED_OPS, Sampler, error_code
from tests.conftest import FakeDsm, load_fixture

T0 = datetime(2026, 11, 23, 10, 0, 15, tzinfo=UTC)

# Réponses réelles et nettoyées du NAS d'essai (DS420+, DSM 7.4.1).
REAL = {
    "SYNO.Core.System.Utilization.get": load_fixture("ds420p_dsm741_system_utilization"),
    "SYNO.DSM.Info.getinfo": load_fixture("ds420p_dsm741_dsm_info"),
    "SYNO.Storage.CGI.Storage.load_info": load_fixture("ds420p_dsm741_storage_load_info"),
    "SYNO.Core.ExternalDevice.UPS.get": load_fixture("ds420p_dsm741_ups_get"),
    "SYNO.Docker.Container.list": load_fixture("ds420p_dsm741_docker_container_list"),
    "SYNO.Docker.Container.Resource.get": load_fixture("ds420p_dsm741_docker_container_resource"),
    "SYNO.Storage.CGI.Smart.get_health_info": lambda p: load_fixture(
        "ds420p_dsm741_smart_health_sata1"
    ),
    "SYNO.Core.Storage.Disk.get_smart_test_log": lambda p: load_fixture(
        "ds420p_dsm741_smart_test_log_sata1"
    ),
    "SYNO.Storage.CGI.Smart.Scheduler.list": load_fixture("ds420p_dsm741_smart_scheduler_list"),
}


class Wall:
    def __init__(self, at=T0):
        self.at = at

    def __call__(self):
        return self.at


class Mono:
    """Horloge monotone du moteur, avancée avec l'horloge murale du test."""

    def __init__(self, wall):
        self.wall = wall

    def __call__(self):
        return self.wall.at.timestamp()


@pytest.fixture
def wall():
    return Wall()


@pytest.fixture
def store(tmp_path):
    return HistoryStore(tmp_path / "history.db")


def sampler_for(responses, audit, settings, store, wall):
    engine = Engine(
        build_catalog(), FakeDsm(responses), audit, settings, clock=Mono(wall), wall_clock=wall
    )
    return Sampler(engine, store, audit, clock=wall)


def test_sampled_ops_are_simple_reads_of_the_catalog():
    catalog = build_catalog()
    for op_id in SAMPLED_OPS:
        op = catalog.get(op_id)
        assert op is not None and op.kind == "read" and op.params_model is None
        assert "DS420+" in (op.verified_on or "")


async def test_values_from_the_recorded_responses(audit, settings, store, wall):
    sampler = sampler_for(REAL, audit, settings, store, wall)
    assert await sampler.sample_once() == 34
    minute = T0.replace(second=0)
    values = {key: value for key, (at, value) in store.latest().items() if at == minute}
    assert values == {
        ("cpu_pct", ""): 3.0,
        ("memory_pct", ""): 22.0,
        ("network_rx_bps", ""): 2112.0,
        ("network_tx_bps", ""): 19620.0,
        ("temperature_c", ""): 41.0,
        ("volume_used_bytes", "volume_1"): 106868736.0,
        ("volume_total_bytes", "volume_1"): 11508794368000.0,
        ("disk_temperature_c", "sata1"): 33.0,
        # Ajouts du 2026-11-26 : parité Beszel.
        ("load_1m", ""): 0.05,
        ("load_5m", ""): 0.01,
        ("load_15m", ""): 0.03,
        ("swap_pct", ""): 0.0,
        ("network_rx_bps", "eth0"): 2112.0,
        ("network_tx_bps", "eth0"): 19620.0,
        ("network_rx_bps", "eth1"): 0.0,
        ("network_tx_bps", "eth1"): 0.0,
        ("disk_read_bps", "sata1"): 115273.0,
        ("disk_write_bps", "sata1"): 16969.0,
        ("disk_util_pct", "sata1"): 0.0,
        ("volume_read_bps", "volume_1"): 0.0,
        ("volume_write_bps", "volume_1"): 0.0,
        ("container_cpu_pct", "nas-moteur-essai-console-1"): 0.0,
        ("container_memory_bytes", "nas-moteur-essai-console-1"): 153165824.0,
        ("container_cpu_pct", "nas-moteur-essai-agent-1"): 0.15,
        ("container_memory_bytes", "nas-moteur-essai-agent-1"): 154238976.0,
        ("container_cpu_pct", "nas-agent"): 0.15,
        ("container_memory_bytes", "nas-agent"): 121610240.0,
        ("container_cpu_pct", "nas-agent-tailscale"): 0.0,
        ("container_memory_bytes", "nas-agent-tailscale"): 48930816.0,
        ("container_cpu_pct", "beszel-agent"): 0.0,
        ("container_memory_bytes", "beszel-agent"): 21164032.0,
        ("disk_reallocated", "sata1"): 0.0,
        ("disk_pending", "sata1"): 0.0,
        ("disk_uncorrectable", "sata1"): 0.0,
    }
    assert store.status.last_sample_at == T0 and store.status.failing == {}
    # Le relevé ne journalise pas chaque lecture.
    assert audit.tail() == []


async def test_ups_charge_is_kept_when_a_ups_is_plugged(audit, settings, store, wall):
    ups = {**load_fixture("ds420p_dsm741_ups_get"), "enable": True, "charge": 87}
    sampler = sampler_for(
        {**REAL, "SYNO.Core.ExternalDevice.UPS.get": ups}, audit, settings, store, wall
    )
    await sampler.sample_once()
    assert store.latest()[("ups_charge_pct", "")][1] == 87.0


async def test_smart_is_recorded_only_when_freshly_read(audit, settings, store, wall):
    """SMART : cache de 6 heures ; une valeur notée par lecture neuve, pas chaque minute."""
    sampler = sampler_for(REAL, audit, settings, store, wall)
    await sampler.sample_once()
    wall.at = T0 + timedelta(minutes=1)
    await sampler.sample_once()
    points = store.read("1m", T0 - timedelta(minutes=5))
    assert len(points[("disk_pending", "sata1")]) == 1
    assert len(points[("cpu_pct", "")]) == 2


async def test_without_container_manager_nothing_fails(audit, settings, store, wall):
    responses = {
        **REAL,
        "SYNO.Docker.Container.list": DsmUnsupported("SYNO.Docker.Container"),
        "SYNO.Docker.Container.Resource.get": DsmUnsupported("SYNO.Docker.Container.Resource"),
    }
    sampler = sampler_for(responses, audit, settings, store, wall)
    await sampler.sample_once()
    assert store.status.failing == {}
    assert audit.tail() == []
    assert not any(m.startswith("container_") for m, _ in store.latest())


async def test_a_failing_read_keeps_the_others(audit, settings, store, wall):
    responses = {**REAL, "SYNO.Storage.CGI.Storage.load_info": DsmUnreachable("x")}
    sampler = sampler_for(responses, audit, settings, store, wall)
    assert await sampler.sample_once() == 26
    metrics = {m for m, _ in store.latest()}
    assert {"cpu_pct", "load_1m", "disk_read_bps", "container_cpu_pct"} <= metrics
    assert not metrics & {"volume_used_bytes", "volume_read_bps", "disk_pending"}
    # SMART lit d'abord la liste des disques : il tombe avec le stockage.
    assert set(store.status.failing) == {"storage.overview", "storage.smart"}
    failing = store.status.failing["storage.overview"]
    assert failing.code == "dsm_unreachable" and failing.since == T0
    lines = {line.op: line for line in audit.tail()}
    line = lines["storage.overview"]
    assert (line.channel, line.outcome, line.code) == ("internal", "error", "dsm_unreachable")
    assert line.token_id is None and line.client_ip is None


async def test_state_changes_are_journaled_at_most_every_ten_minutes(audit, settings, store, wall):
    state: dict = {"failure": None}

    def info(_params):
        if state["failure"]:
            raise state["failure"]
        return REAL["SYNO.DSM.Info.getinfo"]

    sampler = sampler_for({**REAL, "SYNO.DSM.Info.getinfo": info}, audit, settings, store, wall)

    async def cycle(minute, failure=None):
        wall.at = T0 + timedelta(minutes=minute)
        state["failure"] = failure
        await sampler.sample_once()

    await cycle(0, DsmError(105))
    await cycle(1, DsmError(105))
    await cycle(2)  # repart, mais une ligne vient d'être écrite : rien de plus
    await cycle(3, DsmError(105))
    assert [(e.outcome, e.code, e.dsm_code) for e in audit.tail()] == [("error", "dsm_error", 105)]
    await cycle(12)  # dix minutes plus tard, l'état a changé : une ligne
    await cycle(13)
    entries = audit.tail()
    assert [(e.op, e.outcome, e.code) for e in reversed(entries)] == [
        ("system.info", "error", "dsm_error"),
        ("system.info", "ok", None),
    ]
    assert "system.info" not in store.status.failing
    assert audit.verify().ok


async def test_failing_since_keeps_the_start_of_the_streak(audit, settings, store, wall):
    responses = {**REAL, "SYNO.DSM.Info.getinfo": DsmUnsupported("SYNO.DSM.Info")}
    sampler = sampler_for(responses, audit, settings, store, wall)
    await sampler.sample_once()
    wall.at = T0 + timedelta(minutes=5)
    await sampler.sample_once()
    assert store.status.failing["system.info"].since == T0
    assert store.status.failing["system.info"].code == "unsupported"


async def test_odd_subjects_are_skipped_and_counts_bounded(audit, settings, store, wall):
    storage = {
        "volumes": [
            {"id": "../x", "size": {"total": "10", "used": "1"}},
            {"id": "x" * 65, "size": {"total": "10", "used": "1"}},
            {"id": "volume_1", "size": {"total": "10", "used": "4"}},
            {"id": "volume_1", "size": {"total": "99", "used": "99"}},
        ],
        "disks": [
            *[{"id": f"sata{i}", "temp": 30} for i in range(70)],
            {"id": "ssd", "temp": 0},
        ],
    }
    responses = {**REAL, "SYNO.Storage.CGI.Storage.load_info": storage}
    sampler = sampler_for(responses, audit, settings, store, wall)
    await sampler.sample_once()
    latest = store.latest()
    assert latest[("volume_used_bytes", "volume_1")][1] == 4.0
    assert not any(s.startswith("..") or len(s) > 64 for _, s in latest)
    assert sum(m == "disk_temperature_c" for m, _ in latest) == 64
    assert ("disk_temperature_c", "ssd") not in latest  # 0 °C : température non lue


async def test_prune_runs_at_the_first_cycle_then_hourly(audit, settings, store, wall):
    def oldest(metric):
        return store.read("1m", T0 - timedelta(days=3))[(metric, "")][0].t

    old = (T0 - timedelta(days=2)).replace(second=0)
    store.record(old, [("cpu_pct", "", 1.0)])
    sampler = sampler_for(REAL, audit, settings, store, wall)
    await sampler.sample_once()
    assert oldest("cpu_pct") == T0.replace(second=0)
    store.record(old, [("memory_pct", "", 1.0)])
    wall.at = T0 + timedelta(minutes=30)
    await sampler.sample_once()
    assert oldest("memory_pct") == old
    wall.at = T0 + timedelta(minutes=61)
    await sampler.sample_once()
    assert oldest("memory_pct") == T0.replace(second=0)


async def test_run_journals_its_start_samples_at_once_then_on_the_minute(
    audit, settings, store, wall
):
    sleeps: list[float] = []

    async def sleep(seconds):
        sleeps.append(seconds)
        wall.at += timedelta(seconds=seconds)
        if len(sleeps) == 3:
            raise asyncio.CancelledError

    engine = Engine(
        build_catalog(), FakeDsm(REAL), audit, settings, clock=Mono(wall), wall_clock=wall
    )
    sampler = Sampler(engine, store, audit, clock=wall, sleep=sleep)
    with pytest.raises(asyncio.CancelledError):
        await sampler.run()
    assert sleeps == [45.0, 60.0, 60.0]
    assert len(store.read("1m", T0 - timedelta(minutes=1))[("cpu_pct", "")]) == 3
    (start,) = audit.tail()
    assert (start.channel, start.op, start.outcome) == ("internal", "metrics.sampler", "ok")
    assert start.params == {"interval_s": 60, "reads": ",".join(SAMPLED_OPS)}
    assert store.status.running is False


async def test_errors_never_stop_the_loop(audit, settings, store, wall, monkeypatch):
    calls = {"n": 0}
    real_record = store.record

    def flaky(at, values):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return real_record(at, values)

    monkeypatch.setattr(store, "record", flaky)
    sleeps: list[float] = []

    async def sleep(seconds):
        sleeps.append(seconds)
        wall.at += timedelta(seconds=seconds)
        if len(sleeps) == 2:
            raise asyncio.CancelledError

    engine = Engine(
        build_catalog(), FakeDsm(REAL), audit, settings, clock=Mono(wall), wall_clock=wall
    )
    with pytest.raises(asyncio.CancelledError):
        await Sampler(engine, store, audit, clock=wall, sleep=sleep).run()
    assert calls["n"] == 2 and len(store.read("1m", T0)[("cpu_pct", "")]) == 1


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (DsmUnsupported("x"), ("unsupported", None)),
        (DsmCertificateError("x"), ("dsm_certificate", None)),
        (DsmUnreachable("x"), ("dsm_unreachable", None)),
        (TimeoutError(), ("dsm_unreachable", None)),
        (DsmError(119), ("dsm_error", 119)),
        (KeyError("x"), ("unexpected", None)),
        (RuntimeError("x"), ("internal", None)),
    ],
)
def test_error_codes(exc, code):
    assert error_code(exc) == code
