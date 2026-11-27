from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from nas_agent.api import create_app
from nas_agent.auth import Authenticator
from nas_agent.catalog.ops import build_catalog
from nas_agent.catalog.ops.metrics import HistoryParams
from nas_agent.engine import Engine, OpError
from nas_agent.history import TIERS, HistoryStore
from nas_agent.mcp_server import tool_for
from nas_agent.sampler import Sampler
from tests.conftest import FakeDsm, principal
from tests.test_sampler import REAL, Mono, Wall

T0 = datetime(2026, 11, 23, 10, 0, 15, tzinfo=UTC)


@pytest.fixture
def wall():
    return Wall(T0)


@pytest.fixture
def store(tmp_path):
    return HistoryStore(tmp_path / "history.db")


@pytest.fixture
def engine(audit, settings, store, wall):
    return Engine(
        build_catalog(),
        FakeDsm(REAL),
        audit,
        settings,
        clock=Mono(wall),
        wall_clock=wall,
        history=store,
    )


async def sample(engine, store, audit, wall, minutes):
    sampler = Sampler(engine, store, audit, clock=wall)
    for m in minutes:
        wall.at = T0 + timedelta(minutes=m)
        await sampler.sample_once()


async def history(engine, *scopes, **params):
    env = await engine.run(
        "metrics.history",
        params,
        principal(*(scopes or ("system:read", "storage:read"))),
        channel="rest",
        client_ip=None,
    )
    return env.data


def series_of(data, metric, subject=None):
    return next(s for s in data["series"] if s["metric"] == metric and s["subject"] == subject)


def test_tier_parameter_lists_every_tier():
    schema = HistoryParams.model_json_schema()["properties"]["tier"]
    assert schema["enum"] == [t.name for t in TIERS]


async def test_history_of_the_recorded_responses(engine, store, audit, wall):
    await sample(engine, store, audit, wall, range(3))
    data = await history(engine, tier="1m", hours=1)
    assert data["tier"] == "1m" and data["step_s"] == 60 and data["retention_hours"] == 24
    assert datetime.fromisoformat(data["until"]) == wall.at
    assert data["storage_included"] is True
    keys = [(s["metric"], s["subject"]) for s in data["series"]]
    assert keys[:9] == [
        ("cpu_pct", None),
        ("load_1m", None),
        ("load_5m", None),
        ("load_15m", None),
        ("memory_pct", None),
        ("swap_pct", None),
        ("temperature_c", None),
        ("network_rx_bps", None),
        ("network_rx_bps", "eth0"),
    ]
    assert ("container_memory_bytes", "nas-agent") in keys
    assert keys[-4:] == [
        ("disk_util_pct", "sata1"),
        ("disk_reallocated", "sata1"),
        ("disk_pending", "sata1"),
        ("disk_uncorrectable", "sata1"),
    ]
    assert series_of(data, "load_1m")["unit"] == "load"
    assert series_of(data, "disk_pending", "sata1")["unit"] == "count"
    cpu = series_of(data, "cpu_pct")
    assert cpu["unit"] == "percent"
    assert [(p["avg"], p["max"], p["n"]) for p in cpu["points"]] == [(3.0, 3.0, 1)] * 3
    assert cpu["latest"]["value"] == 3.0
    assert series_of(data, "temperature_c")["unit"] == "celsius"
    assert series_of(data, "network_rx_bps")["unit"] == "bytes_per_second"
    used = series_of(data, "volume_used_bytes", "volume_1")
    assert used["unit"] == "bytes" and used["latest"]["value"] == 106868736.0
    sampling = data["sampling"]
    assert sampling["enabled"] is True and sampling["interval_s"] == 60
    assert sampling["failing"] == [] and sampling["last_sample_at"] is not None


async def test_coarse_tiers_summarise_the_minutes(engine, store, audit, wall):
    await sample(engine, store, audit, wall, range(5))
    data = await history(engine, tier="20m", hours=24)
    (point,) = series_of(data, "cpu_pct")["points"]
    assert point["n"] == 5 and point["t"].startswith("2026-11-23T10:00:00")


async def test_storage_series_need_storage_scope(engine, store, audit, wall):
    await sample(engine, store, audit, wall, [0])
    data = await history(engine, "system:read", tier="1m")
    assert data["storage_included"] is False
    assert {s["metric"] for s in data["series"]} == {
        "cpu_pct",
        "load_1m",
        "load_5m",
        "load_15m",
        "memory_pct",
        "swap_pct",
        "temperature_c",
        "network_rx_bps",
        "network_tx_bps",
        "container_cpu_pct",
        "container_memory_bytes",
    }
    with pytest.raises(OpError) as info:
        await history(engine, "storage:read")
    assert info.value.status == 403


async def test_default_window_is_the_period_of_the_tier(engine):
    for tier in TIERS:
        data = await history(engine, tier=tier.name)
        since = datetime.fromisoformat(data["since"])
        until = datetime.fromisoformat(data["until"])
        assert until - since == timedelta(hours=tier.default_h)
    assert (await history(engine))["tier"] == "20m"


@pytest.mark.parametrize(
    "params",
    [
        {"tier": "1m", "hours": 25},
        {"tier": "480m", "hours": 9601},
        {"tier": "5m"},
        {"hours": 0},
        {"metric": "cpu_pct"},
    ],
)
async def test_window_beyond_the_tier_is_refused(engine, params):
    with pytest.raises(OpError) as info:
        await history(engine, **params)
    assert info.value.status == 422


async def test_failing_reads_are_reported(audit, settings, store, wall):
    from nas_agent.dsm.gateway import DsmError

    engine = Engine(
        build_catalog(),
        FakeDsm({**REAL, "SYNO.Storage.CGI.Storage.load_info": DsmError(105)}),
        audit,
        settings,
        clock=Mono(wall),
        wall_clock=wall,
        history=store,
    )
    await sample(engine, store, audit, wall, [0])
    failing, smart = (await history(engine))["sampling"]["failing"]
    assert smart["op"] == "storage.smart"
    assert failing["op"] == "storage.overview" and failing["code"] == "dsm_error"
    assert failing["dsm_code"] == 105


async def test_history_disabled(audit, settings, wall):
    engine = Engine(build_catalog(), FakeDsm(REAL), audit, settings, wall_clock=wall)
    data = await history(engine)
    assert data["sampling"]["enabled"] is False and data["series"] == []


async def test_history_call_is_journaled(engine, audit):
    await history(engine, tier="1m", hours=2)
    entry = audit.tail()[0]
    assert entry.op == "metrics.history" and entry.params == {"tier": "1m", "hours": 2}


def test_rest_route_and_openapi(settings, audit, tokens, engine, store):
    catalog = build_catalog()
    app = create_app(settings, engine, catalog, Authenticator(tokens, audit, settings.limits))
    _, raw = tokens.create("console", ["system:read", "storage:read"])
    h = {"Authorization": f"Bearer {raw}"}
    with TestClient(app, base_url="http://127.0.0.1") as c:
        r = c.get("/v1/metrics/history?tier=120m&hours=48", headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["op"] == "metrics.history" and r.json()["data"]["tier"] == "120m"
        assert c.get("/v1/metrics/history?tier=2m", headers=h).status_code == 422
        spec = c.get("/v1/openapi.json", headers=h).json()
    route = spec["paths"]["/v1/metrics/history"]["get"]
    assert {p["name"] for p in route["parameters"]} == {"tier", "hours"}


def test_mcp_tool_is_read_only():
    op = build_catalog().get("metrics.history")
    tool = tool_for(op)
    assert tool.name == "metrics_history"
    assert tool.annotations.read_only_hint is True
    assert set(tool.input_schema["properties"]) == {"tier", "hours"}
