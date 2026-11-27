import os
import sqlite3
import stat
from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.history import TIERS, HistoryStore, tier_named

T0 = datetime(2026, 11, 23, 10, 0, tzinfo=UTC)


@pytest.fixture
def store(tmp_path):
    return HistoryStore(tmp_path / "history.db")


def minutes(n: int) -> datetime:
    return T0 + timedelta(minutes=n)


def test_tiers_are_the_console_periods():
    assert [t.name for t in TIERS] == ["1m", "20m", "120m", "480m"]
    assert [t.step_s for t in TIERS] == [60, 1200, 7200, 28800]
    assert [t.retention_h for t in TIERS] == [24, 14 * 24, 90 * 24, 400 * 24]
    assert [t.default_h for t in TIERS] == [1, 24, 7 * 24, 30 * 24]
    assert tier_named("120m").step_s == 7200 and tier_named("2m") is None


def test_file_is_private(tmp_path):
    HistoryStore(tmp_path / "sub" / "history.db")
    mode = stat.S_IMODE(os.stat(tmp_path / "sub" / "history.db").st_mode)
    assert mode == 0o600


def test_each_sample_updates_every_tier(store):
    for i, cpu in enumerate([10.0, 20.0, 60.0]):
        store.record(minutes(i), [("cpu_pct", "", cpu)])
    one = store.read("1m", minutes(-5))
    assert [(p.t, p.avg, p.max, p.n) for p in one[("cpu_pct", "")]] == [
        (minutes(0), 10.0, 10.0, 1),
        (minutes(1), 20.0, 20.0, 1),
        (minutes(2), 60.0, 60.0, 1),
    ]
    for tier in ("20m", "120m", "480m"):
        (point,) = store.read(tier, minutes(-600))[("cpu_pct", "")]
        assert point.t == T0 - timedelta(seconds=T0.timestamp() % tier_named(tier).step_s)
        assert point.avg == pytest.approx(30.0) and point.max == 60.0 and point.n == 3


def test_same_minute_twice_is_averaged(store):
    store.record(minutes(0), [("memory_pct", "", 40.0)])
    store.record(minutes(0) + timedelta(seconds=30), [("memory_pct", "", 50.0)])
    (point,) = store.read("1m", minutes(-1))[("memory_pct", "")]
    assert (point.avg, point.max, point.n) == (45.0, 50.0, 2)


def test_buckets_start_on_their_step(store):
    store.record(minutes(19), [("cpu_pct", "", 1.0)])
    store.record(minutes(21), [("cpu_pct", "", 3.0)])
    points = store.read("20m", minutes(-60))[("cpu_pct", "")]
    assert [(p.t, p.avg) for p in points] == [(minutes(0), 1.0), (minutes(20), 3.0)]


def test_subjects_are_separate_series(store):
    store.record(
        minutes(0),
        [("volume_used_bytes", "volume_1", 100.0), ("volume_used_bytes", "volume_2", 7.0)],
    )
    got = store.read("1m", minutes(-1))
    assert got[("volume_used_bytes", "volume_1")][0].avg == 100.0
    assert got[("volume_used_bytes", "volume_2")][0].avg == 7.0


def test_non_finite_values_are_skipped(store):
    store.record(minutes(0), [("cpu_pct", "", float("nan")), ("memory_pct", "", float("inf"))])
    assert store.read("1m", minutes(-1)) == {}


def test_read_window_includes_the_bucket_that_contains_since(store):
    for m in (0, 25, 40):
        store.record(minutes(m), [("cpu_pct", "", float(m))])
    points = store.read("20m", minutes(30))[("cpu_pct", "")]
    assert [p.t for p in points] == [minutes(20), minutes(40)]


def test_latest_is_the_last_minute_of_each_series(store):
    store.record(minutes(0), [("cpu_pct", "", 5.0), ("temperature_c", "", 40.0)])
    store.record(minutes(1), [("cpu_pct", "", 7.0)])
    latest = store.latest()
    assert latest[("cpu_pct", "")] == (minutes(1), 7.0)
    assert latest[("temperature_c", "")] == (minutes(0), 40.0)


def test_prune_keeps_each_tier_for_its_retention(store):
    store.record(T0, [("cpu_pct", "", 1.0)])
    store.prune(T0 + timedelta(hours=25))
    assert store.read("1m", T0 - timedelta(days=1)) == {}
    assert store.read("20m", T0 - timedelta(days=1)) != {}
    store.prune(T0 + timedelta(days=15))
    assert store.read("20m", T0 - timedelta(days=1)) == {}
    assert store.read("120m", T0 - timedelta(days=1)) != {}
    store.prune(T0 + timedelta(days=91))
    assert store.read("120m", T0 - timedelta(days=1)) == {}
    assert store.read("480m", T0 - timedelta(days=1)) != {}
    store.prune(T0 + timedelta(days=401))
    assert store.read("480m", T0 - timedelta(days=1)) == {}


def test_reopening_keeps_the_history(tmp_path):
    path = tmp_path / "history.db"
    HistoryStore(path).record(T0, [("cpu_pct", "", 3.0)])
    assert HistoryStore(path).read("1m", T0)[("cpu_pct", "")][0].avg == 3.0


def test_size_at_equilibrium_stays_small(tmp_path):
    """Un NAS courant (2 volumes, 4 disques) à l'équilibre : chaque palier plein."""
    store = HistoryStore(tmp_path / "history.db")
    series = [
        ("cpu_pct", ""),
        ("memory_pct", ""),
        ("network_rx_bps", ""),
        ("network_tx_bps", ""),
        ("temperature_c", ""),
        *[(m, f"volume_{i}") for i in (1, 2) for m in ("volume_used_bytes", "volume_total_bytes")],
        *[("disk_temperature_c", f"sata{i}") for i in range(1, 5)],
    ]
    rows = []
    for tier in TIERS:
        count = tier.retention_h * 3600 // tier.step_s + 1
        start = int(T0.timestamp()) // tier.step_s * tier.step_s
        rows += [
            (tier.name, start - k * tier.step_s, m, s, 12345678901.5, 12345678901.5, 20)
            for k in range(count)
            for m, s in series
        ]
    assert len(rows) == 13 * 4732
    # Dans l'ordre où la boucle les écrit : du plus ancien au plus récent.
    rows.sort(key=lambda r: r[1])
    conn = sqlite3.connect(store.path)
    with conn:
        conn.executemany("INSERT INTO samples VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    # Mesuré le 2026-11-23 : 3,6 Mio pour ces 13 séries (61 octets par ligne).
    assert os.path.getsize(store.path) < 6 * 1024 * 1024
