"""Mises à jour du parc (conception 2026-11-26-groupes-protections-parc, section 3) : le hub met
à jour un NAS après l'autre, saute ce qui est protégé ou à jour, s'arrête au premier échec."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.audit import AuditLog
from nas_agent.rollout import HUB, RolloutService, Target
from nas_agent.updates import Refused

T0 = datetime(2026, 11, 26, 22, 0, tzinfo=UTC)


class Clock:
    def __init__(self):
        self.at = T0

    def __call__(self):
        return self.at


@dataclass
class FakeJob:
    id: str
    ended_at: str | None = None
    state: str = "running"
    error: str | None = None


class FakeUpdates:
    """L'agent d'un NAS : `outcome` dit ce que donne son travail (fait, échec, ou un refus)."""

    def __init__(self, outcome="done"):
        self.outcome = outcome
        self.jobs: dict[str, FakeJob] = {}
        self.calls: list[tuple] = []
        self.busy = False

    async def run_now(self, target, accept_warnings, by, prepare):
        self.calls.append((target, accept_warnings, by))
        if isinstance(self.outcome, Refused):
            raise self.outcome
        job = FakeJob(id=f"j{len(self.jobs)}")
        self.jobs[job.id] = job
        return job

    def finish(self):
        for job in self.jobs.values():
            if job.ended_at is None:
                job.ended_at = T0.isoformat()
                job.state = "failed" if self.outcome == "failed" else "done"
                job.error = "install failed" if self.outcome == "failed" else None

    def job(self, job_id):
        return self.jobs.get(job_id)

    def failure(self, job):
        return job.error


def service(tmp_path, conn, targets, *, allowed=True, clock=None):
    return RolloutService(
        lambda: {k: Target(updates=u, dsm=None, prepare=None) for k, u in targets.items()},
        AuditLog(conn),
        path=tmp_path / "rollouts.json",
        clock=clock or Clock(),
        authorize=lambda _by, _target: allowed,
    )


async def drive(svc, targets, rounds=10):
    """Fait avancer le déroulé, chaque NAS finissant son travail entre deux passes."""
    for _ in range(rounds):
        await svc.advance()
        for u in targets.values():
            u.finish()
    await svc.advance()


def states(r):
    return [(s.nas, s.state) for s in r.steps]


async def test_one_after_the_other_hub_last(tmp_path, conn):
    t = {HUB: FakeUpdates(), "aaaa0001": FakeUpdates(), "bbbb0002": FakeUpdates()}
    svc = service(tmp_path, conn, t)
    r = svc.create("packages", [HUB, "bbbb0002", "aaaa0001"], None, False, "tok00001")
    assert [s.nas for s in r.steps] == ["bbbb0002", "aaaa0001", HUB]
    await svc.advance()
    # Un seul NAS à la fois : le premier tourne, les autres attendent.
    assert states(r) == [("bbbb0002", "running"), ("aaaa0001", "pending"), (HUB, "pending")]
    await drive(svc, t)
    assert states(r) == [("bbbb0002", "done"), ("aaaa0001", "done"), (HUB, "done")]
    assert r.state == "done"
    assert t["aaaa0001"].calls == [("packages", False, f"rollout:{r.id}")]
    ops = [e.op for e in AuditLog(conn).tail(20) if e.op and e.op.startswith("fleet.rollout")]
    assert ops[-2:] == ["fleet.rollout.start", "fleet.rollout.plan"]
    assert ops[0] == "fleet.rollout.end"


async def test_protected_or_up_to_date_nas_are_skipped(tmp_path, conn):
    t = {
        "aaaa0001": FakeUpdates(Refused("protected", "DSM updates are locked on this NAS.")),
        "bbbb0002": FakeUpdates(Refused("nothing_to_update", "Nothing.")),
        "cccc0003": FakeUpdates(),
    }
    svc = service(tmp_path, conn, t)
    r = svc.create("dsm", ["aaaa0001", "bbbb0002", "cccc0003"], None, True, "tok00001")
    await drive(svc, t)
    assert states(r) == [("aaaa0001", "skipped"), ("bbbb0002", "skipped"), ("cccc0003", "done")]
    assert r.steps[0].reason == "DSM updates are locked on this NAS."
    assert r.state == "done"


async def test_the_first_failure_stops_everything(tmp_path, conn):
    t = {"aaaa0001": FakeUpdates("failed"), "bbbb0002": FakeUpdates()}
    svc = service(tmp_path, conn, t)
    r = svc.create("packages", ["aaaa0001", "bbbb0002"], None, False, "tok00001")
    await drive(svc, t)
    assert states(r) == [("aaaa0001", "failed"), ("bbbb0002", "stopped")]
    assert r.state == "failed" and r.steps[0].reason == "install failed"
    assert t["bbbb0002"].calls == []


async def test_a_dsm_refusal_stops_too(tmp_path, conn):
    t = {"aaaa0001": FakeUpdates(Refused("needs_confirmation", "DSM warns.")), "b": FakeUpdates()}
    svc = service(tmp_path, conn, t)
    r = svc.create("dsm", ["aaaa0001", "b"], None, False, "tok00001")
    await drive(svc, t)
    assert states(r) == [("aaaa0001", "failed"), ("b", "stopped")]


async def test_cancel_stops_before_the_next_nas(tmp_path, conn):
    t = {"aaaa0001": FakeUpdates(), "bbbb0002": FakeUpdates()}
    svc = service(tmp_path, conn, t)
    r = svc.create("packages", ["aaaa0001", "bbbb0002"], None, False, "tok00001")
    await svc.advance()
    assert svc.cancel(r.id) is True
    await drive(svc, t)
    assert states(r) == [("aaaa0001", "done"), ("bbbb0002", "stopped")]
    assert r.state == "cancelled"


async def test_waits_for_its_time(tmp_path, conn):
    t = {"aaaa0001": FakeUpdates()}
    clock = Clock()
    svc = service(tmp_path, conn, t, clock=clock)
    r = svc.create("packages", ["aaaa0001"], T0 + timedelta(hours=2), False, "tok00001")
    await svc.advance()
    assert r.state == "waiting" and t["aaaa0001"].calls == []
    clock.at = T0 + timedelta(hours=2, minutes=1)
    await drive(svc, t)
    assert r.state == "done"


async def test_a_revoked_token_stops_it(tmp_path, conn):
    t = {"aaaa0001": FakeUpdates()}
    svc = service(tmp_path, conn, t, allowed=False)
    r = svc.create("packages", ["aaaa0001"], None, False, "tok00001")
    await drive(svc, t)
    assert r.state == "failed" and states(r) == [("aaaa0001", "stopped")]
    assert "token" in (r.reason or "")


async def test_one_at_a_time_and_known_nas_only(tmp_path, conn):
    t = {"aaaa0001": FakeUpdates()}
    svc = service(tmp_path, conn, t)
    with pytest.raises(Refused) as unknown:
        svc.create("packages", ["zzzz9999"], None, False, "tok00001")
    assert unknown.value.code == "unknown_nas"
    with pytest.raises(Refused):
        svc.create("packages", [], None, False, "tok00001")
    svc.create("packages", ["aaaa0001"], None, False, "tok00001")
    with pytest.raises(Refused) as busy:
        svc.create("packages", ["aaaa0001"], None, False, "tok00001")
    assert busy.value.code == "busy"
    with pytest.raises(Refused) as late:
        svc.create("packages", ["aaaa0001"], T0 + timedelta(days=40), False, "tok00001")
    assert late.value.code in ("busy", "invalid_time")


async def test_resumes_after_a_restart(tmp_path, conn):
    t = {"aaaa0001": FakeUpdates(), "bbbb0002": FakeUpdates()}
    svc = service(tmp_path, conn, t)
    r = svc.create("packages", ["aaaa0001", "bbbb0002"], None, False, "tok00001")
    await svc.advance()
    again = service(tmp_path, conn, t)
    [back] = again.list()
    assert back.id == r.id and states(back)[0] == ("aaaa0001", "running")
    await drive(again, t)
    assert back.state == "done"


# Les routes du hub


def test_routes_plan_list_and_cancel(settings, tmp_path):
    from dataclasses import replace

    from tests.test_fleet import CIDR, FakeDsmLogin, client_of, hub_headers, runtime_of

    project = replace(
        settings,
        console_token_file=tmp_path / "shared" / "console-token",
        console_cidrs=[CIDR],
        public_hosts=["agent"],
    )
    runtime = runtime_of(project, FakeDsmLogin())
    at = (datetime.now(UTC) + timedelta(hours=3)).isoformat()
    with client_of(runtime) as c:
        headers = hub_headers(project)
        r = c.post(
            "/v1/fleet/rollouts",
            json={"target": "packages", "nas": ["hub"], "at": at},
            headers=headers,
        )
        assert r.status_code == 201, r.text
        planned = r.json()["rollout"]
        assert planned["state"] == "waiting" and planned["steps"][0]["nas"] == "hub"
        assert "by" not in planned
        listed = c.get("/v1/fleet/rollouts", headers=headers).json()
        assert [x["id"] for x in listed["rollouts"]] == [planned["id"]]
        busy = c.post(
            "/v1/fleet/rollouts", json={"target": "packages", "nas": ["hub"]}, headers=headers
        )
        assert busy.status_code == 409 and busy.json()["code"] == "busy"
        bad = c.post("/v1/fleet/rollouts", json={"target": "dsm", "nas": ["../x"]}, headers=headers)
        assert bad.status_code == 422
        cancel = c.post(f"/v1/fleet/rollouts/{planned['id']}/cancel", headers=headers)
        assert cancel.json() == {"cancelled": True}
        # Un jeton sans le parc n'y touche pas.
        _info, raw = runtime.tokens.create("lecture", ["system:read", "packages:update"])
        other = {"Authorization": f"Bearer {raw}"}
        assert c.get("/v1/fleet/rollouts", headers=other).status_code == 403
