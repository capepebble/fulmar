"""DSM muet : l'état des alertes sonne même quand plus rien ne se lit (2026-11-26)."""

from datetime import UTC, datetime, timedelta

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmUnreachable
from nas_agent.engine import Engine
from nas_agent.history import FailingRead, HistoryStore
from nas_agent.relay.state import build_state

T = datetime(2026, 11, 26, 14, 0, tzinfo=UTC)


class DeadDsm:
    async def call(self, api, method, *, max_version, min_version=1, params=None):
        raise DsmUnreachable("down")


async def state_with(audit, settings, tmp_path, minutes):
    store = HistoryStore(tmp_path / "history.db")
    store.status.failing["system.utilization"] = FailingRead(
        "dsm_unreachable", None, T - timedelta(minutes=minutes)
    )
    engine = Engine(
        build_catalog(), DeadDsm(), audit, settings, wall_clock=lambda: T, history=store
    )
    return await build_state(engine, lambda: T, unreachable_minutes=5, lang="fr")


async def test_silent_dsm_rings_without_the_audit(audit, settings, tmp_path):
    state = await state_with(audit, settings, tmp_path, 12)
    assert state.checks["system.reachable"] == (
        "failed",
        "DSM joignable",
        "DSM ne répond plus depuis 12 min.",
    )
    (check,) = [c for c in state.content["checks"] if c["id"] == "system.reachable"]
    assert check["status"] == "failed" and check["advice"]
    assert {"op": "audit.checks", "reason": "dsm_unreachable"} in state.content["unavailable"]


async def test_a_short_silence_does_not_ring(audit, settings, tmp_path):
    state = await state_with(audit, settings, tmp_path, 2)
    assert state.checks["system.reachable"][0] == "ok"
