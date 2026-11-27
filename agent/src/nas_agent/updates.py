"""Mises à jour des paquets et de DSM : travaux en tâche de fond et rendez-vous (conception
2026-11-26-mises-a-jour-paquets, sections 3 et 6).

Les seules écritures de l'agent sur DSM. Un travail ne reçoit que ce que les opérations ont
vérifié (paquets installés, de Synology, en retard sur le catalogue ; mise à jour de DSM
disponible) et n'appelle que les appels fixés dans `catalog/ops/updates.py`. Un travail à la
fois. L'état des travaux et des rendez-vous est gardé dans `data/updates.json` : le NAS qui
porte l'agent redémarre après une mise à jour de DSM, l'agent la conclut à son retour.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from nas_agent.audit import AuditLog
from nas_agent.dsm.gateway import DsmCaller, DsmGatewayError

log = logging.getLogger(__name__)

State = Literal["pending", "running", "done", "failed"]
Kind = Literal["packages", "dsm"]
KEEP = 10
MAX_SCHEDULES = 20
POLL_S = 2.0
TIMEOUT_S = 15 * 60
DOWNLOAD_TIMEOUT_S = 2 * 3600
# Après l'installation de DSM : le NAS redémarre, l'agent attend son retour une heure au plus.
REBOOT_TIMEOUT_S = 3600
LOOP_S = 30.0
# Un rendez-vous qui trouve un autre travail en cours attend six heures au plus.
SCHEDULE_PATIENCE = timedelta(hours=6)


@dataclass(frozen=True)
class Planned:
    """Un paquet à mettre à jour, tel que le catalogue de DSM le décrit."""

    id: str
    name: str
    from_version: str
    to_version: str
    url: str
    checksum: str
    size: int
    type: int


@dataclass
class PackageRun:
    id: str
    name: str
    from_version: str
    to_version: str
    state: State = "pending"
    error: str | None = None
    dsm_code: int | None = None
    started_at: str | None = None
    ended_at: str | None = None


DsmStep = Literal["download", "check", "install", "restart", "end"]


@dataclass
class DsmRun:
    from_version: str
    to_version: str
    # Étape en cours : téléchargement, vérifications, installation, redémarrage, fin.
    step: DsmStep = "download"
    state: State = "pending"
    accept_warnings: bool = False
    percent: int | None = None
    error: str | None = None
    dsm_code: int | None = None
    started_at: str | None = None
    ended_at: str | None = None


@dataclass
class Job:
    id: str
    kind: Kind
    started_at: str
    by: str | None
    packages: list[PackageRun] = field(default_factory=list)
    dsm: DsmRun | None = None
    ended_at: str | None = None
    schedule_id: str | None = None
    plan: list[Planned] = field(default_factory=list, repr=False)

    @property
    def state(self) -> State:
        """En cours tant que le travail n'est pas fini ; ensuite en échec si une part l'est."""
        if self.ended_at is None:
            return "running"
        parts = [p.state for p in self.packages] + ([self.dsm.state] if self.dsm else [])
        return "failed" if "failed" in parts else "done"


@dataclass
class Schedule:
    id: str
    target: Kind
    packages: list[str]
    at: str
    accept_warnings: bool
    by: str | None
    created_at: str
    state: Literal["waiting", "started", "skipped", "cancelled"] = "waiting"
    reason: str | None = None
    job_id: str | None = None


class Refused(Exception):
    """Un rendez-vous ou un travail qui ne part pas : code stable et raison en anglais."""

    def __init__(self, code: str, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


# Préparation à l'heure d'un rendez-vous, fournie par catalog/ops/updates.py (pas d'import
# circulaire) : rend le plan des paquets, ou (version installée, version visée) pour DSM, ou
# lève Refused.
Prepare = Callable[[DsmCaller, Schedule], Awaitable[Any]]


class _Failed(Exception):
    def __init__(self, reason: str, dsm_code: int | None):
        super().__init__(reason)
        self.reason = reason
        self.dsm_code = dsm_code


class UpdateService:
    def __init__(
        self,
        dsm: DsmCaller,
        audit: AuditLog,
        *,
        path: Path | None = None,
        on_done: Callable[[], None] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        poll_s: float = POLL_S,
        timeout_s: float = TIMEOUT_S,
        reboot_timeout_s: float = REBOOT_TIMEOUT_S,
        authorize: Callable[[str | None, Kind], bool] | None = None,
    ):
        self._dsm = dsm
        # À l'heure d'un rendez-vous : le jeton qui l'a posé vaut-il encore, avec ses droits ?
        self._authorize = authorize
        self._audit = audit
        self._path = path
        self._on_done = on_done
        self._clock = clock
        self._poll_s = poll_s
        self._timeout_s = timeout_s
        self._reboot_timeout_s = reboot_timeout_s
        self._jobs: list[Job] = []
        self._schedules: list[Schedule] = []
        self._task: asyncio.Task | None = None
        self._load()

    # État -----------------------------------------------------------------------------------

    @property
    def busy(self) -> bool:
        if self._task is not None and not self._task.done():
            return True
        # Un travail rechargé au démarrage et pas encore conclu.
        return any(j.ended_at is None for j in self._jobs)

    def jobs(self) -> list[Job]:
        """Le travail en cours puis les derniers, du plus récent au plus ancien."""
        return list(reversed(self._jobs))

    def schedules(self) -> list[Schedule]:
        """Les rendez-vous à venir (les plus proches d'abord), puis les derniers passés."""
        waiting = sorted((s for s in self._schedules if s.state == "waiting"), key=lambda s: s.at)
        past = [s for s in reversed(self._schedules) if s.state != "waiting"][:KEEP]
        return waiting + past

    def _now(self) -> str:
        return self._clock().isoformat()

    def _load(self) -> None:
        if self._path is None:
            return
        try:
            data = json.loads(self._path.read_text())
            self._jobs = [_job_from(j) for j in data.get("jobs", [])][-KEEP:]
            self._schedules = [Schedule(**s) for s in data.get("schedules", [])]
        except (OSError, ValueError, TypeError, KeyError):
            self._jobs, self._schedules = [], []

    def _save(self) -> None:
        if self._path is None:
            return
        data = {
            "jobs": [{**asdict(j), "plan": []} for j in self._jobs],
            "schedules": [asdict(s) for s in self._schedules],
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_name(f".{self._path.name}.tmp")
            tmp.write_text(json.dumps(data, indent=1))
            os.replace(tmp, self._path)
        except OSError:
            log.exception("Cannot save the update state")

    def _record(self, op: str, outcome: str, params: dict[str, Any], dsm_code=None) -> None:
        try:
            self._audit.record(
                channel="internal",
                op=op,
                token_id=None,
                client_ip=None,
                outcome=outcome,  # type: ignore[arg-type]
                dsm_code=dsm_code,
                params=params,
            )
        except Exception:  # le journal plein n'arrête pas une mise à jour commencée
            log.exception("Cannot write the call log")

    # Travaux --------------------------------------------------------------------------------

    def _begin(self, job: Job, runner: Callable[[Job], Awaitable[None]]) -> Job:
        if self.busy:
            raise Refused("busy", "An update is already running on this NAS.")
        self._jobs = [*self._jobs, job][-KEEP:]
        self._save()
        self._task = asyncio.get_running_loop().create_task(self._guard(job, runner))
        return job

    def start(self, plan: list[Planned], by: str | None, schedule_id: str | None = None) -> Job:
        """Mettre à jour ces paquets, un après l'autre."""
        job = Job(
            id=secrets.token_hex(4),
            kind="packages",
            started_at=self._now(),
            by=by,
            packages=[PackageRun(p.id, p.name, p.from_version, p.to_version) for p in plan],
            plan=list(plan),
            schedule_id=schedule_id,
        )
        return self._begin(job, self._run_packages)

    def start_dsm(
        self,
        from_version: str,
        to_version: str,
        by: str | None,
        *,
        accept_warnings: bool = False,
        schedule_id: str | None = None,
    ) -> Job:
        """Télécharger et installer la mise à jour de DSM, puis attendre son retour."""
        job = Job(
            id=secrets.token_hex(4),
            kind="dsm",
            started_at=self._now(),
            by=by,
            dsm=DsmRun(from_version, to_version, accept_warnings=accept_warnings),
            schedule_id=schedule_id,
        )
        return self._begin(job, self._run_dsm)

    async def run_now(
        self, target: Kind, accept_warnings: bool, by: str | None, prepare: Prepare
    ) -> Job:
        """Un NAS d'une mise à jour du parc : tout de suite, toutes vérifications refaites
        (protections comprises, par `prepare`) ; pour les paquets, tous ceux que Synology met
        à jour. Lève Refused si rien ne part."""
        if self.busy:
            raise Refused("busy", "An update is already running on this NAS.")
        now = self._now()
        s = Schedule(
            id="now",
            target=target,
            packages=[],
            at=now,
            accept_warnings=accept_warnings,
            by=by,
            created_at=now,
        )
        prepared = await prepare(self._dsm, s)
        if target == "packages":
            return self.start(prepared, by=by)
        return self.start_dsm(prepared[0], prepared[1], by=by, accept_warnings=accept_warnings)

    def job(self, job_id: str) -> Job | None:
        return next((j for j in self._jobs if j.id == job_id), None)

    @staticmethod
    def failure(job: Job) -> str | None:
        """La première raison d'échec d'un travail, pour le dire en une ligne."""
        errors = [p.error for p in job.packages if p.error]
        if job.dsm and job.dsm.error:
            errors.insert(0, job.dsm.error)
        return errors[0] if errors else None

    async def wait(self) -> None:
        """Attend la fin du travail en cours (tests, arrêt propre)."""
        if self._task is not None:
            await self._task

    async def _guard(self, job: Job, runner) -> None:
        try:
            await runner(job)
        except Exception:  # un défaut inattendu ne laisse pas le travail « en cours »
            log.exception("Update job failed")
            for p in job.packages:
                if p.state in ("pending", "running"):
                    p.state, p.error = "failed", "internal error"
            if job.dsm and job.dsm.state in ("pending", "running"):
                job.dsm.state, job.dsm.error = "failed", "internal error"
        job.ended_at = job.ended_at or self._now()
        job.plan = []
        self._save()
        if self._on_done is not None:
            self._on_done()

    async def _call(self, call, params: dict[str, Any]) -> dict[str, Any]:
        return await self._dsm.call(
            call.api, call.method, max_version=call.max_version, params=params
        )

    async def _run_packages(self, job: Job) -> None:
        for planned, run in zip(job.plan, job.packages, strict=True):
            run.state, run.started_at = "running", self._now()
            self._save()
            try:
                await self._install(planned)
                installed = await self._installed_version(planned.id)
                if installed == planned.to_version:
                    run.state = "done"
                else:
                    run.state = "failed"
                    run.error = f"version still {installed or 'unknown'} after the update"
            except _Failed as exc:
                run.state, run.error, run.dsm_code = "failed", exc.reason, exc.dsm_code
            except DsmGatewayError as exc:
                run.state, run.error = "failed", str(exc)[:200]
                run.dsm_code = getattr(exc, "code", None)
            run.ended_at = self._now()
            self._record(
                "packages.update.package",
                "ok" if run.state == "done" else "error",
                {"package": run.id, "from": run.from_version, "to": run.to_version},
                run.dsm_code,
            )
            self._save()
        job.ended_at = self._now()

    async def _install(self, p: Planned) -> None:
        from nas_agent.catalog.ops.updates import INSTALL, STATUS

        data = await self._call(
            INSTALL,
            {
                "name": p.id,
                "is_syno": "true",
                "beta": "false",
                "url": p.url,
                "checksum": p.checksum,
                "filesize": p.size,
                "type": p.type,
                "blqinst": "true",
                "operation": "upgrade",
            },
        )
        progress = data.get("progress")
        if isinstance(progress, (int, float)) and progress < 0:
            raise _Failed("DSM refused to start the update", _int(data.get("code")))
        task_id = data.get("taskid") or data.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise _Failed("DSM gave no task to follow", None)
        waited = 0.0
        while True:
            await asyncio.sleep(self._poll_s)
            waited += self._poll_s or 1
            state = await self._call(STATUS, {"task_id": task_id})
            error = state.get("error")
            code = _int(error.get("code")) if isinstance(error, dict) else None
            if code:
                raise _Failed("DSM reported an error during the update", code)
            if state.get("finished") is True:
                return
            if waited >= self._timeout_s:
                raise _Failed("update still running after 15 minutes", None)

    async def _installed_version(self, package_id: str) -> str | None:
        from nas_agent.catalog.ops.packages import PACKAGE_LIST

        params = dict(PACKAGE_LIST.params) if isinstance(PACKAGE_LIST.params, dict) else {}
        data = await self._call(PACKAGE_LIST, params)
        for item in data.get("packages") or []:
            if isinstance(item, dict) and item.get("id") == package_id:
                version = item.get("version")
                return version if isinstance(version, str) else None
        return None

    async def _run_dsm(self, job: Job) -> None:
        from nas_agent.catalog.ops import updates as ops

        run = job.dsm
        if run is None:  # pragma: no cover - un travail DSM porte toujours son état
            return
        run.state = "running"
        run.started_at = run.started_at or self._now()
        try:
            if run.step == "download":
                await self._dsm_download(run, ops)
                run.step = "check"
                self._save()
            if run.step == "check":
                await self._dsm_checks(run, ops)
                run.step = "install"
                self._save()
            if run.step == "install":
                await self._call(ops.DSM_START, {"force": "true", "type": "server"})
                run.step = "restart"
                self._record(
                    "dsm.update.install", "ok", {"from": run.from_version, "to": run.to_version}
                )
                self._save()
            if run.step == "restart":
                await self._dsm_wait_back(run, ops)
        except _Failed as exc:
            run.state, run.error, run.dsm_code = "failed", exc.reason, exc.dsm_code
        except DsmGatewayError as exc:
            run.state, run.error = "failed", str(exc)[:200]
            run.dsm_code = getattr(exc, "code", None)
        run.step = "end"
        run.ended_at = self._now()
        self._record(
            "dsm.update.end",
            "ok" if run.state == "done" else "error",
            {"from": run.from_version, "to": run.to_version, "error": run.error},
            run.dsm_code,
        )
        job.ended_at = self._now()

    async def _dsm_download(self, run: DsmRun, ops) -> None:
        await self._call(ops.DSM_DOWNLOAD, {"target": "update", "need_auto_smallupdate": "true"})
        waited = 0.0
        while True:
            await asyncio.sleep(self._poll_s)
            waited += self._poll_s or 1
            progress = await self._call(ops.DSM_DOWNLOAD_PROGRESS, {"need_download_target": "true"})
            status = progress.get("status")
            percent = progress.get("percent")
            if isinstance(percent, (int, float)):
                run.percent = int(percent)
            if status == "finished":
                return
            if status == "failed":
                raise _Failed("DSM could not download the update", None)
            if waited >= DOWNLOAD_TIMEOUT_S:
                raise _Failed("download still running after 2 hours", None)

    async def _dsm_checks(self, run: DsmRun, ops) -> None:
        status = await self._call(ops.DSM_STATUS, {"feasibility_check": "true"})
        kind, reasons = ops.dsm_feasibility(status)
        said = f": {'; '.join(reasons)}" if reasons else ""
        if kind == "blocked":
            raise _Failed(f"DSM refuses the update{said}", None)
        if kind == "warning" and not run.accept_warnings:
            raise _Failed(f"DSM warns before updating, not accepted{said}", None)
        patch = status.get("patch_info")
        if isinstance(patch, dict) and patch.get("upgradetype") == "dsm":
            pre = await self._call(ops.DSM_PRECHECK, {"lang": "enu", "type": "server"})
            info = pre.get("precheck_info")
            info = info if isinstance(info, dict) else {}
            message = info.get("message") if isinstance(info.get("message"), str) else ""
            if info.get("can_continue") is False:
                raise _Failed(f"DSM's pre-check refuses the update: {message[:200]}", None)

    async def _dsm_wait_back(self, run: DsmRun, ops) -> None:
        """DSM redémarre : attendre qu'il réponde avec une version plus récente."""
        from nas_agent.synology import dsm_version

        waited = 0.0
        step = max(self._poll_s, 0.001) * 5
        while waited < self._reboot_timeout_s:
            await asyncio.sleep(step)
            waited += step
            try:
                info = await self._call(ops.DSM_INFO, {})
            except DsmGatewayError:
                continue  # DSM redémarre : injoignable un moment
            now = info.get("version_string")
            before, after = dsm_version(run.from_version), dsm_version(now)
            if before is not None and after is not None and after > before:
                run.state, run.to_version = "done", str(now)
                return
        raise _Failed("DSM did not come back with a newer version within an hour", None)

    async def resume(self) -> None:
        """Au démarrage : conclure un travail interrompu par un redémarrage de l'agent."""
        for job in self._jobs:
            if job.ended_at is not None:
                continue
            if job.kind == "dsm" and job.dsm is not None and job.dsm.step in ("install", "restart"):
                # Le NAS a redémarré pendant l'installation : attendre et relire la version.
                job.dsm.step = "restart"
                self._task = asyncio.get_running_loop().create_task(self._guard(job, self._run_dsm))
                continue
            for p in job.packages:
                if p.state in ("pending", "running"):
                    p.state, p.error = "failed", "interrupted by a restart of the agent"
            if job.dsm is not None and job.dsm.state in ("pending", "running"):
                job.dsm.state, job.dsm.error = "failed", "interrupted by a restart of the agent"
            job.ended_at = self._now()
        self._save()

    # Rendez-vous ----------------------------------------------------------------------------

    def schedule(
        self,
        target: Kind,
        packages: list[str],
        at: datetime,
        accept_warnings: bool,
        by: str | None,
    ) -> Schedule:
        now = self._clock()
        if at < now + timedelta(minutes=2) or at > now + timedelta(days=31):
            raise Refused("invalid_time", "Schedule between 2 minutes and 31 days from now.")
        if sum(s.state == "waiting" for s in self._schedules) >= MAX_SCHEDULES:
            raise Refused("too_many", f"At most {MAX_SCHEDULES} scheduled updates.")
        item = Schedule(
            id=secrets.token_hex(4),
            target=target,
            packages=packages,
            at=at.astimezone(UTC).isoformat(),
            accept_warnings=accept_warnings,
            by=by,
            created_at=now.isoformat(),
        )
        waiting = [s for s in self._schedules if s.state == "waiting"]
        past = [s for s in self._schedules if s.state != "waiting"][-KEEP:]
        self._schedules = [*past, *waiting, item]
        self._save()
        return item

    def find(self, schedule_id: str) -> Schedule | None:
        return next((s for s in self._schedules if s.id == schedule_id), None)

    def unschedule(self, schedule_id: str) -> bool:
        for s in self._schedules:
            if s.id == schedule_id and s.state == "waiting":
                s.state, s.reason = "cancelled", "cancelled from the console"
                self._save()
                return True
        return False

    def cancel_waiting(self, reason: str) -> int:
        """Annule tous les rendez-vous à venir (NAS détaché de Fulmar) ; rend leur nombre."""
        cancelled = 0
        for s in self._schedules:
            if s.state == "waiting":
                s.state, s.reason = "cancelled", reason
                cancelled += 1
        if cancelled:
            self._save()
        return cancelled

    async def run_due(self, prepare: Prepare) -> None:
        """Lance un rendez-vous arrivé à son heure ; un seul travail à la fois."""
        now = self._clock()
        for s in sorted(self._schedules, key=lambda s: s.at):
            if s.state != "waiting" or datetime.fromisoformat(s.at) > now:
                continue
            if self.busy:
                if now - datetime.fromisoformat(s.at) > SCHEDULE_PATIENCE:
                    self._end_schedule(s, "another update kept running for 6 hours")
                    continue
                return
            if self._authorize is not None and not self._authorize(s.by, s.target):
                self._end_schedule(
                    s, "the token that scheduled it was revoked, expired or lost its rights"
                )
                continue
            try:
                prepared = await prepare(self._dsm, s)
                if s.target == "packages":
                    job = self.start(prepared, by=s.by, schedule_id=s.id)
                else:
                    job = self.start_dsm(
                        prepared[0],
                        prepared[1],
                        by=s.by,
                        accept_warnings=s.accept_warnings,
                        schedule_id=s.id,
                    )
            except Refused as exc:
                self._end_schedule(s, exc.reason)
                continue
            except DsmGatewayError as exc:
                self._end_schedule(s, str(exc)[:200])
                continue
            s.state, s.job_id = "started", job.id
            self._record("updates.schedule.start", "ok", {"schedule": s.id, "job": job.id})
            self._save()
            return

    def _end_schedule(self, s: Schedule, reason: str) -> None:
        s.state, s.reason = "skipped", reason
        self._record("updates.schedule.skip", "error", {"schedule": s.id, "reason": reason})
        self._save()

    async def run(self, prepare: Prepare, every_s: float = LOOP_S) -> None:
        await self.resume()
        while True:
            try:
                await self.run_due(prepare)
            except Exception:  # la boucle ne meurt jamais d'un rendez-vous
                log.exception("Scheduled update failed")
            await asyncio.sleep(every_s)


def token_allows(tokens, token_id: str | None, target: Kind, now: datetime) -> bool:
    """Le jeton existe, n'est ni révoqué ni expiré, et porte les droits de la cible."""
    info = next((t for t in tokens.list() if t.id == token_id), None) if token_id else None
    if info is None or info.revoked_at is not None or info.expires_at <= now:
        return False
    needed = {"packages:update"} | ({"dsm:update"} if target == "dsm" else set())
    return needed <= set(info.scopes)


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _job_from(d: dict[str, Any]) -> Job:
    return Job(
        id=d["id"],
        kind=d.get("kind", "packages"),
        started_at=d["started_at"],
        by=d.get("by"),
        packages=[PackageRun(**p) for p in d.get("packages", [])],
        dsm=DsmRun(**d["dsm"]) if d.get("dsm") else None,
        ended_at=d.get("ended_at"),
        schedule_id=d.get("schedule_id"),
    )


def snapshot(job: Job) -> Job:
    """Copie sans le plan (adresses des fichiers) : ce qui sort de l'agent."""
    return replace(
        job,
        packages=[replace(p) for p in job.packages],
        dsm=replace(job.dsm) if job.dsm else None,
        plan=[],
    )
