"""Fermer un accès resté ouvert (conception 2026-11-26-fermer-acces) : SSH et Telnet, fermer
jamais ouvrir. Réponses réelles du NAS d'essai pour `get` et pour `set` (Telnet fermé seul)."""

from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.access_guard import AccessGuard
from nas_agent.catalog.ops import build_catalog
from nas_agent.catalog.ops.close_access import CLOSE, TERMINAL_GET
from nas_agent.engine import Engine, OpError
from tests.conftest import load_fixture, principal

T0 = datetime(2026, 11, 26, 14, 0, tzinfo=UTC)


class Terminal:
    """Le Terminal de DSM : `get` rend l'état, `set` n'applique que ce qu'on lui envoie."""

    def __init__(self, ssh=True, telnet=False):
        self.state = {"enable_ssh": ssh, "enable_telnet": telnet}
        self.sets: list[dict] = []

    async def call(self, api, method, *, max_version, min_version=1, params=None):
        assert api == "SYNO.Core.Terminal"
        if method == "get":
            data = load_fixture("ds420p_dsm741_security_terminal")
            return {**{k: v for k, v in data.items() if not k.startswith("_")}, **self.state}
        assert method == "set"
        self.sets.append(dict(params or {}))
        for key, value in (params or {}).items():
            self.state[key] = value == "true"
        return {k: v for k, v in load_fixture("ds420p_dsm741_terminal_set").items() if k[0] != "_"}


class Clock:
    def __init__(self, at=T0):
        self.at = at

    def __call__(self):
        return self.at

    def advance(self, **kw):
        self.at += timedelta(**kw)


def guard_of(dsm, audit, tmp_path, clock):
    closed: list[str] = []
    g = AccessGuard(
        dsm, audit, path=tmp_path / "access.json", clock=clock, on_closed=lambda: closed.append("x")
    )
    return g, closed


def watch(g, service):
    return next(w for w in g.snapshot() if w["service"] == service)


def test_the_close_calls_never_carry_a_true_value():
    assert set(CLOSE) == {"ssh", "telnet"}
    for service, call in CLOSE.items():
        assert (call.api, call.method) == ("SYNO.Core.Terminal", "set")
        assert dict(call.params) == {f"enable_{service}": "false"}
    assert (TERMINAL_GET.api, TERMINAL_GET.method) == ("SYNO.Core.Terminal", "get")


async def test_nothing_happens_without_a_rule(audit, tmp_path):
    dsm, clock = Terminal(ssh=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    await g.tick()
    clock.advance(hours=30)
    await g.tick()
    w = watch(g, "ssh")
    assert w["open"] is True and w["open_since"] == T0.isoformat() and w["deadline"] is None
    assert dsm.sets == []


async def test_close_rule_closes_at_the_deadline_and_only_that_access(audit, tmp_path):
    dsm, clock = Terminal(ssh=True, telnet=True), Clock()
    g, closed = guard_of(dsm, audit, tmp_path, clock)
    await g.tick()
    g.set_policy("telnet", "close", 60)
    assert watch(g, "telnet")["deadline"] == (T0 + timedelta(minutes=60)).isoformat()
    clock.advance(minutes=59)
    await g.tick()
    assert dsm.sets == []
    clock.advance(minutes=2)
    await g.tick()
    assert dsm.sets == [{"enable_telnet": "false"}]
    assert dsm.state == {"enable_ssh": True, "enable_telnet": False}
    w = watch(g, "telnet")
    assert w["open"] is False and w["closed_at"] == clock.at.isoformat() and w["deadline"] is None
    assert closed == ["x"]
    lines = [e for e in audit.tail(10) if e.op == "access.close"]
    assert [(e.channel, e.outcome) for e in lines] == [("internal", "ok")]


async def test_a_rule_set_on_an_access_open_for_months_never_closes_it_at_once(audit, tmp_path):
    dsm, clock = Terminal(ssh=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    await g.tick()
    clock.advance(days=90)
    await g.tick()
    g.set_policy("ssh", "close", 60)
    await g.tick()
    assert dsm.sets == []
    assert watch(g, "ssh")["deadline"] == (clock.at + timedelta(minutes=60)).isoformat()


async def test_remind_rule_never_closes(audit, tmp_path):
    dsm, clock = Terminal(ssh=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    g.set_policy("ssh", "remind", 30)
    await g.tick()
    clock.advance(hours=5)
    await g.tick()
    assert dsm.sets == [] and watch(g, "ssh")["open"] is True


async def test_extend_pushes_the_deadline_within_24_hours(audit, tmp_path):
    dsm, clock = Terminal(ssh=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    await g.tick()
    g.set_policy("ssh", "close", 60)
    g.extend("ssh", 120)
    assert watch(g, "ssh")["deadline"] == (T0 + timedelta(minutes=180)).isoformat()
    for _ in range(20):
        g.extend("ssh", 480)
    assert watch(g, "ssh")["deadline"] == (T0 + timedelta(hours=24)).isoformat()


async def test_extend_needs_a_deadline(audit, tmp_path):
    dsm, clock = Terminal(ssh=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    await g.tick()
    with pytest.raises(ValueError):
        g.extend("ssh", 60)


async def test_reopened_after_a_close_starts_a_new_count(audit, tmp_path):
    dsm, clock = Terminal(ssh=False, telnet=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    g.set_policy("telnet", "close", 15)
    await g.tick()
    clock.advance(minutes=16)
    await g.tick()
    assert dsm.state["enable_telnet"] is False
    clock.advance(minutes=5)
    dsm.state["enable_telnet"] = True  # rouvert à la main dans DSM
    await g.tick()
    w = watch(g, "telnet")
    assert w["open"] is True and w["closed_at"] is None
    assert w["deadline"] == (clock.at + timedelta(minutes=15)).isoformat()


async def test_state_and_rules_survive_a_restart(audit, tmp_path):
    dsm, clock = Terminal(ssh=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    await g.tick()
    g.set_policy("ssh", "close", 90)
    again, _ = guard_of(dsm, audit, tmp_path, clock)
    w = watch(again, "ssh")
    assert w["policy"] == {"mode": "close", "minutes": 90}
    assert w["deadline"] == (T0 + timedelta(minutes=90)).isoformat()


async def test_a_dsm_that_keeps_it_open_is_logged_as_an_error(audit, tmp_path):
    class Stubborn(Terminal):
        async def call(self, api, method, **kw):
            if method == "set":
                self.sets.append(dict(kw.get("params") or {}))
                return {}
            return await super().call(api, method, **kw)

    dsm, clock = Stubborn(telnet=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    g.set_policy("telnet", "close", 15)
    await g.tick()
    clock.advance(minutes=20)
    await g.tick()
    assert watch(g, "telnet")["open"] is True
    assert [e.outcome for e in audit.tail(10) if e.op == "access.close"] == ["error"]


# Les opérations, par le moteur


def engine_with(dsm, audit, settings, guard):
    engine = Engine(build_catalog(), dsm, audit, settings)
    engine.guard = guard
    return engine


async def run(engine, op, scopes, **params):
    env = await engine.run(op, params, principal(*scopes), channel="rest", client_ip=None)
    return env.data


async def test_ops_watch_close_extend_policy(audit, settings, tmp_path):
    dsm, clock = Terminal(ssh=True, telnet=True), Clock()
    g, _ = guard_of(dsm, audit, tmp_path, clock)
    await g.tick()
    e = engine_with(dsm, audit, settings, g)
    seen = await run(e, "access.watch", ("security:read",))
    assert seen["can_act"] is False
    assert [(s["service"], s["open"]) for s in seen["services"]] == [
        ("ssh", True),
        ("telnet", True),
    ]
    with pytest.raises(OpError) as refused:
        await run(e, "access.close", ("security:read",), service="telnet")
    assert refused.value.status == 403
    ok = ("security:read", "access:close")
    policy = await run(e, "access.policy", ok, service="ssh", mode="close", minutes=60)
    assert policy["policy"] == {"mode": "close", "minutes": 60}
    extended = await run(e, "access.extend", ok, service="ssh", minutes=30)
    assert extended["deadline"] == (T0 + timedelta(minutes=90)).isoformat()
    closed = await run(e, "access.close", ok, service="telnet")
    assert closed["open"] is False and dsm.sets == [{"enable_telnet": "false"}]
    with pytest.raises(OpError) as bad:
        await run(e, "access.close", ok, service="http")
    assert bad.value.status == 422


async def test_the_closing_check_reminds_ten_minutes_before(audit, settings, tmp_path):
    from tests.conftest import FakeDsm
    from tests.real_nas import SynologyPages, nas_responses

    term, clock = Terminal(ssh=True), Clock(datetime.now(UTC).replace(microsecond=0))
    g, _ = guard_of(term, audit, tmp_path, clock)
    await g.tick()
    g.set_policy("ssh", "close", 60)
    responses = nas_responses()
    base = responses["SYNO.Core.Terminal.get"]
    responses["SYNO.Core.Terminal.get"] = lambda _p: {**base, **term.state}

    async def report():
        engine = Engine(
            build_catalog(), FakeDsm(responses), audit, settings, wall_clock=lambda: clock.at
        )
        engine.synology = SynologyPages()
        engine.guard = g
        data = await run(engine, "audit.checks", ("audit:checks",))
        return {c["id"]: c for c in data["checks"]}

    checks = await report()
    assert checks["access.closing"]["status"] == "ok"
    assert "SSH" in checks["access.closing"]["observed"]
    assert "Fulmar" in checks["access.ssh"]["observed"]
    clock.advance(minutes=52)
    checks = await report()
    assert checks["access.closing"]["status"] == "warning"
    assert "SSH" in checks["access.closing"]["observed"]


async def test_the_closing_check_with_nothing_to_watch(audit, settings):
    from tests.conftest import FakeDsm
    from tests.real_nas import SynologyPages, nas_responses

    engine = Engine(build_catalog(), FakeDsm(nas_responses()), audit, settings)
    engine.synology = SynologyPages()
    data = await run(engine, "audit.checks", ("audit:checks",))
    check = next(c for c in data["checks"] if c["id"] == "access.closing")
    assert check["status"] == "ok"
