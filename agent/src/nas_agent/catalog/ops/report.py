"""Le bilan du mois (conception 2026-11-26-bilan-du-mois, section 2).

Ce que l'agent sait d'un mois, sans rien demander à DSM : les incidents (journal des verdicts),
la part du mois où il a lu le NAS, les volumes et les constantes (historique), les mises à jour
qu'il a faites, et ce qu'il a fait lui-même (son journal). Jamais un compte ni une adresse.
Le mois se compte en UTC.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from nas_agent.catalog.model import OpContext, Operation
from nas_agent.verdicts import month_of

BAD = ("warning", "failed")
# Les écritures : actions du catalogue et fermeture par le gardien.
WRITES = {
    "packages.update",
    "dsm.update_run",
    "updates.schedule",
    "updates.unschedule",
    "updates.protect",
    "access.close",
    "access.extend",
    "access.policy",
    "agent.detach",
    "devices.pair",
    "devices.revoke",
}


class MonthParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    month: str | None = Field(
        None,
        pattern=r"^\d{4}-(0[1-9]|1[0-2])$",
        description="AAAA-MM ; the current month if left out.",
    )


class Failing(BaseModel):
    id: str
    title: str
    status: Literal["warning", "failed"]


class EndState(BaseModel):
    source: Literal["frozen", "current", "none"] = Field(
        description='"frozen": state kept at the end of that month; "current": the month is still '
        'going; "none": nothing recorded.'
    )
    ok: int
    warning: int
    failed: int
    failing: list[Failing]


class Incident(BaseModel):
    check_id: str
    title: str
    status: Literal["warning", "failed"] = Field(description="The worst state reached.")
    at: str = Field(description="When it went wrong (UTC); before the month if already open.")
    recovered_at: str | None = Field(description="When it came back to ok (UTC).")


class Availability(BaseModel):
    read_pct: float | None = Field(description="Share of the month the agent read the NAS.")
    since: str | None = Field(description="First reading counted (start of month or history).")


class Vitals(BaseModel):
    cpu_avg: float | None
    cpu_max: float | None
    memory_avg: float | None
    memory_max: float | None
    temperature_max: float | None


class VolumeMonth(BaseModel):
    volume: str
    start_pct: float | None
    end_pct: float | None
    grown_bytes: float | None


class UpdateDone(BaseModel):
    kind: Literal["packages", "dsm"]
    name: str
    from_version: str
    to_version: str
    state: str
    ended_at: str | None


class WriteCount(BaseModel):
    op: str
    count: int


class FulmarMonth(BaseModel):
    calls: int
    denied: int
    writes: list[WriteCount]


class MonthReport(BaseModel):
    month: str
    start: str
    end: str
    in_progress: bool
    end_state: EndState
    incidents: list[Incident]
    availability: Availability
    vitals: Vitals | None = Field(description="Null when the history is off.")
    volumes: list[VolumeMonth]
    updates: list[UpdateDone]
    fulmar: FulmarMonth


def _bounds(month: str) -> tuple[datetime, datetime]:
    year, mon = (int(x) for x in month.split("-"))
    start = datetime(year, mon, 1, tzinfo=UTC)
    end = datetime(year + (mon == 12), 1 if mon == 12 else mon + 1, 1, tzinfo=UTC)
    return start, end


def _titles(ctx: OpContext) -> dict[str, str]:
    from nas_agent.catalog.ops.checks import check_titles

    return check_titles(ctx.lang)


def _incidents(ctx: OpContext, start: datetime, end: datetime, titles) -> list[Incident]:
    log = ctx.verdicts
    if log is None:
        return []
    open_: dict[str, Incident] = {}
    out: list[Incident] = []
    for check_id, ev in log.before(start).items():
        if ev.status in BAD:
            inc = Incident(
                check_id=check_id,
                title=titles.get(check_id, check_id),
                status=ev.status,  # type: ignore[arg-type]
                at=ev.at,
                recovered_at=None,
            )
            open_[check_id] = inc
            out.append(inc)
    for ev in log.events(start, end):
        inc = open_.get(ev.check_id)
        # Le premier relevé d'un contrôle (rien avant lui) n'est pas un changement : son état
        # paraît dans l'état de fin, pas parmi les incidents du mois.
        if ev.previous is None and inc is None:
            continue
        if ev.status in BAD:
            if inc is None:
                inc = Incident(
                    check_id=ev.check_id,
                    title=titles.get(ev.check_id, ev.check_id),
                    status=ev.status,  # type: ignore[arg-type]
                    at=ev.at,
                    recovered_at=None,
                )
                open_[ev.check_id] = inc
                out.append(inc)
            elif ev.status == "failed":
                inc.status = "failed"
        elif inc is not None:
            inc.recovered_at = ev.at
            del open_[ev.check_id]
    return out


def _end_state(ctx: OpContext, month: str, in_progress: bool, titles) -> EndState:
    log = ctx.verdicts
    data = None
    source: Literal["frozen", "current", "none"] = "none"
    if log is not None and not in_progress:
        data = log.month_end(month)
        source = "frozen" if data else "none"
    elif log is not None:
        state = log.state()
        if state:
            data = {
                **{
                    s: sum(1 for st, _ in state.values() if st == s)
                    for s in ("ok", "warning", "failed")
                },
                "failing": [
                    {"id": cid, "status": st}
                    for cid, (st, _since) in sorted(state.items())
                    if st in BAD
                ],
            }
            source = "current"
    data = data or {"ok": 0, "warning": 0, "failed": 0, "failing": []}
    return EndState(
        source=source,
        ok=data["ok"],
        warning=data["warning"],
        failed=data["failed"],
        failing=[
            Failing(id=f["id"], title=titles.get(f["id"], f["id"]), status=f["status"])
            for f in data["failing"]
        ],
    )


def _history(ctx: OpContext, start: datetime, end: datetime, now: datetime):
    """Disponibilité, constantes et volumes, depuis les paliers de 2 heures de l'historique."""
    history = ctx.history
    if history is None:
        return Availability(read_pct=None, since=None), None, []
    series = history.read("120m", start)

    def within(points):
        return [p for p in points if start <= p.t < end]

    cpu = within(series.get(("cpu_pct", ""), []))
    mem = within(series.get(("memory_pct", ""), []))
    temp = within(series.get(("temperature_c", ""), []))

    def avg(points):
        n = sum(p.n for p in points)
        return round(sum(p.avg * p.n for p in points) / n, 1) if n else None

    def peak(points):
        return round(max(p.max for p in points), 1) if points else None

    vitals = Vitals(
        cpu_avg=avg(cpu),
        cpu_max=peak(cpu),
        memory_avg=avg(mem),
        memory_max=peak(mem),
        temperature_max=peak(temp),
    )
    availability = Availability(read_pct=None, since=None)
    if cpu:
        first = max(start, cpu[0].t)
        last = min(end, now)
        expected = max(1.0, (last - first).total_seconds() / 60)
        availability = Availability(
            read_pct=round(min(100.0, 100 * sum(p.n for p in cpu) / expected), 1),
            since=first.isoformat(),
        )
    volumes: list[VolumeMonth] = []
    for (metric, subject), points in sorted(series.items()):
        if metric != "volume_used_bytes":
            continue
        used = within(points)
        total = within(series.get(("volume_total_bytes", subject), []))
        if not used:
            continue
        size = total[-1].avg if total else None

        def pct(value, size=size):
            return round(100 * value / size, 1) if size else None

        volumes.append(
            VolumeMonth(
                volume=subject,
                start_pct=pct(used[0].avg),
                end_pct=pct(used[-1].avg),
                grown_bytes=used[-1].avg - used[0].avg,
            )
        )
    return availability, (vitals if cpu or mem or temp else None), volumes


def _updates(ctx: OpContext, start: datetime, end: datetime) -> list[UpdateDone]:
    service = ctx.updates
    if service is None:
        return []
    out: list[UpdateDone] = []
    for job in service.jobs():
        if not job.ended_at or not (start <= datetime.fromisoformat(job.ended_at) < end):
            continue
        if job.dsm is not None:
            out.append(
                UpdateDone(
                    kind="dsm",
                    name="DSM",
                    from_version=job.dsm.from_version,
                    to_version=job.dsm.to_version,
                    state=job.dsm.state,
                    ended_at=job.ended_at,
                )
            )
        for p in job.packages:
            out.append(
                UpdateDone(
                    kind="packages",
                    name=p.name,
                    from_version=p.from_version,
                    to_version=p.to_version,
                    state=p.state,
                    ended_at=p.ended_at or job.ended_at,
                )
            )
    return out


def _fulmar(ctx: OpContext, start: datetime, end: datetime) -> FulmarMonth:
    rows = ctx.audit.summary(start.isoformat(), end.isoformat())
    writes: dict[str, int] = {}
    for op, outcome, n in rows:
        if op in WRITES and outcome == "ok":
            writes[op] = writes.get(op, 0) + n
    return FulmarMonth(
        calls=sum(n for _op, _outcome, n in rows),
        denied=sum(n for _op, outcome, n in rows if outcome == "denied"),
        writes=[WriteCount(op=op, count=n) for op, n in sorted(writes.items())],
    )


def _report(ctx: OpContext, _responses) -> MonthReport:
    now = ctx.fetched_at or datetime.now(UTC)
    p = ctx.params if isinstance(ctx.params, MonthParams) else MonthParams()
    month = p.month or month_of(now)
    start, end = _bounds(month)
    in_progress = start <= now < end
    titles = _titles(ctx)
    availability, vitals, volumes = _history(ctx, start, end, now)
    return MonthReport(
        month=month,
        start=start.isoformat(),
        end=(end - timedelta(seconds=1)).isoformat(),
        in_progress=in_progress,
        end_state=_end_state(ctx, month, in_progress, titles),
        incidents=_incidents(ctx, start, end, titles),
        availability=availability,
        vitals=vitals,
        volumes=volumes,
        updates=_updates(ctx, start, end),
        fulmar=_fulmar(ctx, start, end),
    )


OPERATIONS = [
    Operation(
        id="report.month",
        title="Report: the month",
        description=(
            "The monthly report of this NAS, from what the agent kept: incidents (checks that "
            "went wrong and came back), share of the month read, volumes and vitals, updates "
            "done, and what Fulmar itself did. Month in UTC, as YYYY-MM."
        ),
        kind="read",
        scope="audit:checks",
        path="/report/month",
        result_model=MonthReport,
        transform=_report,
        params_model=MonthParams,
        cache_ttl=0,
    ),
]
