"""Mises à jour du parc : un NAS après l'autre, depuis le hub (conception
2026-11-26-groupes-protections-parc, section 3).

Le hub tient les NAS ajoutés dans son processus. Pour chaque NAS du déroulé, dans l'ordre (le
hub en dernier : sa mise à jour de DSM le redémarre lui-même), il refait les vérifications de
DSM et les protections, lance le travail sur l'agent de ce NAS et attend sa fin. Un NAS gelé,
verrouillé ou à jour est sauté ; un échec, un refus de DSM ou un NAS injoignable arrête tout.
Un seul déroulé à la fois, gardé dans `data/rollouts.json` et repris au redémarrage.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from nas_agent.audit import AuditLog
from nas_agent.dsm.gateway import DsmGatewayError
from nas_agent.updates import Kind, Refused

log = logging.getLogger(__name__)

HUB = "hub"
KEEP = 10
LOOP_S = 5.0
MAX_AHEAD = timedelta(days=31)
# Un NAS occupé par une autre mise à jour : on l'attend six heures au plus.
PATIENCE = timedelta(hours=6)
# Ces refus sautent le NAS ; tout autre refus arrête le déroulé.
SKIP = ("nothing_to_update", "protected")

StepState = Literal["pending", "running", "done", "skipped", "failed", "stopped"]
RolloutState = Literal["waiting", "running", "done", "failed", "cancelled"]


@dataclass(frozen=True)
class Target:
    """Un NAS du parc : son service de mises à jour, son DSM et sa préparation (protections)."""

    updates: Any
    dsm: Any
    prepare: Callable[[Any, Any], Awaitable[Any]] | None


@dataclass
class Step:
    nas: str
    state: StepState = "pending"
    reason: str | None = None
    job_id: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    waiting_since: str | None = None


@dataclass
class Rollout:
    id: str
    target: Kind
    at: str
    accept_warnings: bool
    by: str | None
    created_at: str
    steps: list[Step] = field(default_factory=list)
    state: RolloutState = "waiting"
    reason: str | None = None
    ended_at: str | None = None
    cancel: bool = False


class RolloutService:
    def __init__(
        self,
        targets: Callable[[], dict[str, Target]],
        audit: AuditLog,
        *,
        path: Path | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        authorize: Callable[[str | None, Kind], bool] = lambda _by, _target: True,
    ):
        self._targets = targets
        self._audit = audit
        self._path = path
        self._clock = clock
        self._authorize = authorize
        self._rollouts: list[Rollout] = []
        self._lock = asyncio.Lock()
        self._load()

    # Disque et journal --------------------------------------------------------------------------

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text())
            self._rollouts = [
                Rollout(**{**r, "steps": [Step(**s) for s in r.get("steps", [])]})
                for r in data.get("rollouts", [])
            ][-KEEP:]
        except (OSError, ValueError, TypeError):
            log.exception("Cannot read the fleet updates: starting afresh")
            self._rollouts = []

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_name(f".{self._path.name}.tmp")
            tmp.write_text(json.dumps({"rollouts": [asdict(r) for r in self._rollouts]}, indent=1))
            os.replace(tmp, self._path)
        except OSError:
            log.exception("Cannot save the fleet updates")

    def _record(self, op: str, outcome: str, params: dict[str, Any]) -> None:
        try:
            self._audit.record(
                channel="internal",
                op=op,
                token_id=None,
                client_ip=None,
                outcome=outcome,  # type: ignore[arg-type]
                params=params,
            )
        except Exception:
            log.exception("Cannot write the call log")

    def _now(self) -> str:
        return self._clock().isoformat()

    # Lecture ------------------------------------------------------------------------------------

    def list(self) -> list[Rollout]:
        """Le plus récent d'abord."""
        return list(reversed(self._rollouts))

    @property
    def active(self) -> Rollout | None:
        return next((r for r in self._rollouts if r.state in ("waiting", "running")), None)

    # Lancer, arrêter ----------------------------------------------------------------------------

    def create(
        self,
        target: Kind,
        nas: list[str],
        at: datetime | None,
        accept_warnings: bool,
        by: str | None,
    ) -> Rollout:
        if self.active is not None:
            raise Refused("busy", "A fleet update is already planned or running.")
        known = self._targets()
        order = list(dict.fromkeys(nas))
        if not order:
            raise Refused("no_nas", "Choose at least one NAS.")
        unknown = [n for n in order if n not in known]
        if unknown:
            raise Refused("unknown_nas", f"Unknown NAS: {', '.join(unknown[:5])}.")
        # Le hub en dernier : sa mise à jour de DSM le redémarre, et le déroulé avec lui.
        order = [n for n in order if n != HUB] + ([HUB] if HUB in order else [])
        now = self._clock()
        when = at or now
        if when < now - timedelta(minutes=1) or when > now + MAX_AHEAD:
            raise Refused("invalid_time", "Start now, or within 31 days.")
        rollout = Rollout(
            id=secrets.token_hex(4),
            target=target,
            at=when.astimezone(UTC).isoformat(),
            accept_warnings=accept_warnings,
            by=by,
            created_at=now.isoformat(),
            steps=[Step(n) for n in order],
        )
        self._rollouts = [*self._rollouts, rollout][-KEEP:]
        self._save()
        self._record(
            "fleet.rollout.plan", "ok", {"rollout": rollout.id, "target": target, "nas": len(order)}
        )
        return rollout

    def cancel(self, rollout_id: str) -> bool:
        r = self.active
        if r is None or r.id != rollout_id:
            return False
        if r.state == "waiting":
            self._end(r, "cancelled", "cancelled before it started")
        else:
            r.cancel = True
            self._save()
        return True

    def _end(self, r: Rollout, state: RolloutState, reason: str | None = None) -> None:
        for s in r.steps:
            if s.state == "pending":
                s.state = "stopped"
        r.state, r.reason, r.ended_at = state, reason, self._now()
        self._save()
        self._record(
            "fleet.rollout.end",
            "ok" if state == "done" else "error",
            {
                "rollout": r.id,
                "state": state,
            },
        )

    def _step_end(self, r: Rollout, s: Step, state: StepState, reason: str | None) -> None:
        s.state, s.reason, s.ended_at = state, reason, self._now()
        self._save()
        self._record(
            "fleet.rollout.step",
            "error" if state == "failed" else "ok",
            {"rollout": r.id, "nas": s.nas, "state": state},
        )

    # La marche ----------------------------------------------------------------------------------

    async def advance(self) -> None:
        """Fait avancer le déroulé en cours aussi loin que possible sans attendre."""
        async with self._lock:
            await self._advance()

    async def _advance(self) -> None:
        r = self.active
        if r is None:
            return
        now = self._clock()
        if r.state == "waiting":
            if datetime.fromisoformat(r.at) > now:
                return
            r.state = "running"
            self._save()
            self._record("fleet.rollout.start", "ok", {"rollout": r.id, "target": r.target})
        while True:
            step = next((s for s in r.steps if s.state in ("pending", "running")), None)
            if step is None:
                failed = any(s.state == "failed" for s in r.steps)
                self._end(r, "failed" if failed else "done")
                return
            target = self._targets().get(step.nas)
            if step.state == "running":
                if not self._follow(r, step, target):
                    return
                continue
            if r.cancel:
                self._end(r, "cancelled", "stopped from the console")
                return
            if not self._authorize(r.by, r.target):
                self._end(r, "failed", "the token that started it was revoked or lost its rights")
                return
            if target is None:
                self._step_end(r, step, "failed", "NAS unreachable")
                self._end(r, "failed", f"{step.nas}: NAS unreachable")
                return
            if target.updates.busy:
                step.waiting_since = step.waiting_since or now.isoformat()
                if now - datetime.fromisoformat(step.waiting_since) > PATIENCE:
                    self._step_end(r, step, "failed", "another update kept running for 6 hours")
                    self._end(r, "failed", f"{step.nas}: busy")
                return
            try:
                job = await target.updates.run_now(
                    r.target, r.accept_warnings, f"rollout:{r.id}", target.prepare
                )
            except Refused as exc:
                if exc.code in SKIP:
                    self._step_end(r, step, "skipped", exc.reason)
                    continue
                self._step_end(r, step, "failed", exc.reason)
                self._end(r, "failed", f"{step.nas}: {exc.reason}")
                return
            except DsmGatewayError as exc:
                self._step_end(r, step, "failed", str(exc)[:200] or "DSM unreachable")
                self._end(r, "failed", f"{step.nas}: DSM unreachable")
                return
            step.state, step.job_id, step.started_at = "running", job.id, self._now()
            self._save()
            self._record(
                "fleet.rollout.step",
                "ok",
                {
                    "rollout": r.id,
                    "nas": step.nas,
                    "state": "running",
                    "job": job.id,
                },
            )
            return

    def _follow(self, r: Rollout, step: Step, target: Target | None) -> bool:
        """Le travail d'un NAS en cours : vrai quand il est fini (on passe au suivant)."""
        job = target.updates.job(step.job_id) if target is not None and step.job_id else None
        if job is None:
            self._step_end(r, step, "failed", "the update job was lost")
            self._end(r, "failed", f"{step.nas}: update job lost")
            return False
        if job.ended_at is None:
            return False
        if job.state == "failed":
            reason = target.updates.failure(job) if target is not None else None
            self._step_end(r, step, "failed", reason or "the update failed")
            self._end(r, "failed", f"{step.nas}: {reason or 'the update failed'}")
            return False
        self._step_end(r, step, "done", None)
        return True

    async def run(self, every_s: float = LOOP_S) -> None:
        while True:
            try:
                await self.advance()
            except Exception:  # la boucle ne meurt jamais d'un déroulé
                log.exception("Fleet update failed")
            await asyncio.sleep(every_s)


def rollout_allows(tokens, token_id: str | None, target: Kind, now: datetime) -> bool:
    """Le jeton vaut encore et porte les droits du déroulé : le parc et la mise à jour."""
    info = next((t for t in tokens.list() if t.id == token_id), None) if token_id else None
    if info is None or info.revoked_at is not None or info.expires_at <= now:
        return False
    needed = {"fleet:manage", "packages:update"} | ({"dsm:update"} if target == "dsm" else set())
    return needed <= set(info.scopes)
