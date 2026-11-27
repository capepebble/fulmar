"""L'état déposé pour les téléphones (`state/1`, protocole section 8.1).

Rien de nouveau n'est demandé à DSM : l'état se bâtit sur les lectures du catalogue, faites
en interne par le moteur (même cache, mêmes délais), et sur l'historique des constantes. Une
lecture qui échoue n'empêche pas l'état : elle va dans `unavailable`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from pydantic import BaseModel

from nas_agent import __version__
from nas_agent.catalog.ops.checks_vitals import SPECS as VITAL_SPECS
from nas_agent.catalog.ops.checks_vitals import silence
from nas_agent.config import AuditThresholds
from nas_agent.i18n import Lang
from nas_agent.sampler import error_code
from nas_agent.tokens import Principal

# Celui qui lit pour l'état des téléphones : les constantes et le stockage, jamais les noms de
# comptes (pas de personal:read) ; jamais un jeton, jamais dans le journal.
RELAY_READER = Principal(
    token_id="relay",  # noqa: S106 - un nom, pas un secret
    label="state for the phones",
    scopes=frozenset({"system:read", "storage:read"}),
)

READS: dict[str, Mapping[str, Any] | None] = {
    "system.info": None,
    "network.overview": None,
    "system.time": None,
    "dsm.update": None,
    "packages.list": None,
    "audit.checks": None,
    "storage.overview": None,
    "backup.hyperbackup.tasks": None,
    "metrics.history": {"tier": "20m", "hours": 24},
}
FORECAST_READ = ("metrics.history", {"tier": "120m", "hours": 720})
NAS_METRICS = ("cpu_pct", "memory_pct", "temperature_c", "network_rx_bps", "network_tx_bps")
# Séries envoyées aux téléphones : celles d'avant le 2026-11-26 (l'état reste léger) ; le
# réseau par interface, les conteneurs et les disques en détail se lisent en direct.
PHONE_SERIES = frozenset(
    {*NAS_METRICS, "volume_used_bytes", "volume_total_bytes", "disk_temperature_c"}
)
_REACHABLE = next(s for s in VITAL_SPECS if s.id == "system.reachable")

DAY = 86400.0
FORECAST_WINDOW = 30 * DAY
FORECAST_MIN_HISTORY = 7 * DAY
FORECAST_HORIZON = 365 * DAY


class InternalReader(Protocol):
    def read_internal(
        self, op_id: str, params: Mapping[str, Any] | None = None, principal: Principal = ...
    ) -> Awaitable[tuple[BaseModel, datetime]]: ...


def iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return at.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fill_forecast(
    points: list[tuple[float, float]], total: float | None, now: float
) -> tuple[str, str | None]:
    """Date de remplissage : régression linéaire sur 30 jours, comme la console.

    Au moins 7 jours d'historique et une pente positive ; au-delà d'un an : stable.
    """
    recent = [(t, y) for t, y in points if now - FORECAST_WINDOW <= t <= now]
    if len(recent) < 2 or not total or total <= 0:
        return "unknown", None
    xs = [t for t, _ in recent]
    if max(xs) - min(xs) < FORECAST_MIN_HISTORY:
        return "unknown", None
    n = len(recent)
    x = [(t - now) / DAY for t, _ in recent]
    y = [v for _, v in recent]
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((xi - mx) ** 2 for xi in x)
    if sxx == 0:
        return "unknown", None
    slope = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y, strict=True)) / sxx
    if slope <= 0:
        return "stable", None
    intercept = my - slope * mx
    days = (total - intercept) / slope
    if days * DAY > FORECAST_HORIZON:
        return "stable", None
    at = max(now, now + days * DAY)
    return "date", iso(datetime.fromtimestamp(at, UTC))


def _local_to_utc(local: str | None, offset: int | None) -> str | None:
    if local is None or offset is None:
        return None
    try:
        at = datetime.fromisoformat(local).replace(tzinfo=UTC) - timedelta(minutes=offset)
    except ValueError:
        return None
    return iso(at)


@dataclass(frozen=True)
class BuiltState:
    content: dict[str, Any]
    digest: str
    checks: dict[str, tuple[str, str, str]]
    """Contrôles qui alertent : id -> (statut, titre, gravité)."""
    backups: dict[str, dict[str, Any]]

    def encode(self) -> bytes:
        return json.dumps(self.content, separators=(",", ":"), ensure_ascii=False).encode()


async def _reads(
    engine: InternalReader,
) -> tuple[dict[str, BaseModel], list[dict[str, str]], BaseModel | None]:
    jobs = [engine.read_internal(op, params, RELAY_READER) for op, params in READS.items()]
    jobs.append(engine.read_internal(FORECAST_READ[0], FORECAST_READ[1], RELAY_READER))
    results = await asyncio.gather(*jobs, return_exceptions=True)
    reads: dict[str, BaseModel] = {}
    unavailable: list[dict[str, str]] = []
    for op_id, result in zip(READS, results[:-1], strict=True):
        if isinstance(result, asyncio.CancelledError):
            raise result
        if isinstance(result, BaseException):
            code, _ = error_code(result)
            unavailable.append({"op": op_id, "reason": code})
        else:
            reads[op_id] = result[0]
    forecast = results[-1]
    return reads, unavailable, None if isinstance(forecast, BaseException) else forecast[0]


def _silence_check(
    history: Any, at: datetime, unreachable_minutes: int, lang: Lang
) -> dict[str, Any]:
    """DSM muet : le rapport d'audit ne se lit plus, l'agent constate lui-même le silence."""
    sampling = getattr(history, "sampling", None)
    failing = [(f.op, f.code, f.since) for f in getattr(sampling, "failing", []) or []]
    verdict = silence(failing, at, unreachable_minutes, lang)
    limits = AuditThresholds(unreachable_minutes=unreachable_minutes)
    return {
        "id": _REACHABLE.id,
        "category": "system",
        "title": _REACHABLE.title(lang),
        "severity": _REACHABLE.severity,
        "status": verdict.status,
        "observed": verdict.observed,
        "expected": _REACHABLE.expected(limits, lang),
        "advice": None if verdict.status == "ok" else verdict.advice or _REACHABLE.advice(lang),
        "items": [],
    }


async def build_state(
    engine: InternalReader,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    *,
    unreachable_minutes: int = 5,
    lang: Lang = "en",
) -> BuiltState:
    reads, unavailable, forecast_history = await _reads(engine)
    at = now()
    info = reads.get("system.info")
    network = reads.get("network.overview")
    clock = reads.get("system.time")
    update = reads.get("dsm.update")
    packages = reads.get("packages.list")
    report = reads.get("audit.checks")
    storage = reads.get("storage.overview")
    tasks = reads.get("backup.hyperbackup.tasks")
    history = reads.get("metrics.history")
    offset = getattr(clock, "utc_offset_minutes", None)

    nas = {
        "name": getattr(network, "hostname", None),
        "model": getattr(info, "model", None),
        "dsm": getattr(info, "dsm_version", None),
        "uptime_s": getattr(info, "uptime_s", None),
        "temperature_c": getattr(info, "temperature_c", None),
        "utc_offset_minutes": offset,
    }
    updates = {
        "dsm_current": getattr(update, "current_version", None),
        "dsm_update": getattr(update, "update_available", None),
        "dsm_update_version": getattr(update, "update_version", None),
        "dsm_major_version": getattr(update, "major_upgrade_version", None)
        if getattr(update, "major_upgrade_available", None)
        else None,
        "packages_pending": packages.summary.updates_available if packages else None,
        "packages_security": packages.summary.security_updates if packages else None,
    }
    checks = []
    alerting: dict[str, tuple[str, str, str]] = {}
    summary = None
    if report is not None:
        summary = report.summary.model_dump(mode="json")
        for c in report.checks:
            checks.append(
                {
                    "id": c.id,
                    "category": c.category,
                    "title": c.title,
                    "severity": c.severity,
                    "status": c.status,
                    "observed": c.observed,
                    "expected": c.expected,
                    "advice": c.advice,
                    "items": c.items,
                }
            )
            if c.severity != "info":
                alerting[c.id] = (c.status, c.title, c.observed)
    else:
        silent = _silence_check(history, at, unreachable_minutes, lang)
        checks.append(silent)
        alerting[silent["id"]] = (silent["status"], silent["title"], silent["observed"])

    series_by: dict[tuple[str, str | None], Any] = {}
    for s in getattr(history, "series", []) or []:
        series_by[(s.metric, s.subject)] = s
    used_history: dict[str, list[tuple[float, float]]] = {}
    for s in getattr(forecast_history, "series", []) or []:
        if s.metric == "volume_used_bytes" and s.subject:
            used_history[s.subject] = [(p.t.timestamp(), p.avg) for p in s.points]

    volumes = []
    disks = []
    if storage is not None:
        for v in storage.volumes:
            fill, full_at = fill_forecast(
                used_history.get(v.id or "", []), v.size_total_bytes, at.timestamp()
            )
            volumes.append(
                {
                    "id": v.id,
                    "path": v.path,
                    "status": v.status,
                    "used_bytes": v.size_used_bytes,
                    "total_bytes": v.size_total_bytes,
                    "used_pct": v.used_pct,
                    "fill": fill,
                    "full_at": full_at,
                }
            )
        for d in storage.disks:
            disks.append(
                {
                    "id": d.id,
                    "name": d.name,
                    "model": d.model,
                    "status": d.status,
                    "healthy": d.healthy,
                    "temperature_c": d.temperature_c,
                }
            )

    backups = []
    backup_memory: dict[str, dict[str, Any]] = {}
    for t in getattr(tasks, "tasks", []) or []:
        entry = {
            "id": t.id,
            "name": t.name,
            "kind": t.kind,
            "running": t.running,
            "failed": t.failed,
            "last_result": t.last_result,
            "last_started_at": _local_to_utc(t.last_started_at, offset),
            "last_ended_at": _local_to_utc(t.last_ended_at, offset),
            "last_success_at": _local_to_utc(t.last_success_at, offset),
            "next_run_at": _local_to_utc(t.schedule.next_run_at if t.schedule else None, offset),
            "last_error": t.last_error,
        }
        backups.append(entry)
        if t.id is not None:
            backup_memory[str(t.id)] = {
                "name": t.name,
                "failed": t.failed,
                "run": t.last_ended_at or t.last_started_at,
                "error": t.last_error,
            }

    vitals_now = {}
    for metric in NAS_METRICS:
        s = series_by.get((metric, None))
        vitals_now[metric] = s.latest.value if s is not None and s.latest is not None else None
    vitals = {
        "now": vitals_now,
        "step_s": getattr(history, "step_s", 1200),
        "since": iso(getattr(history, "since", None)),
        "series": [
            {
                "metric": s.metric,
                "subject": s.subject,
                "unit": s.unit,
                "points": [[int(p.t.timestamp()), p.avg, p.max] for p in s.points],
            }
            for s in getattr(history, "series", []) or []
            if s.metric in PHONE_SERIES and (s.subject is None or s.metric not in NAS_METRICS)
        ],
    }
    content = {
        "schema": "state/1",
        "at": iso(at),
        "agent_version": __version__,
        "nas": nas,
        "updates": updates,
        "summary": summary,
        "checks": checks,
        "volumes": volumes,
        "disks": disks,
        "backups": backups,
        "vitals": vitals,
        "unavailable": unavailable,
    }
    return BuiltState(content, _digest(content), alerting, backup_memory)


def _digest(content: Mapping[str, Any]) -> str:
    """Ce qui fait « un état changé » : verdicts, stockage, sauvegardes, mises à jour, lectures
    en échec. Les constantes du moment n'en font pas partie (elles bougent chaque minute)."""
    significant = {
        "nas": {k: content["nas"].get(k) for k in ("name", "model", "dsm")},
        "updates": content["updates"],
        "summary": content["summary"],
        "checks": [(c["id"], c["status"], c["items"]) for c in content["checks"]],
        "volumes": [
            (
                v["id"],
                v["status"],
                round(v["used_pct"]) if v["used_pct"] is not None else None,
                v["fill"],
                (v["full_at"] or "")[:10],
            )
            for v in content["volumes"]
        ],
        "disks": [(d["id"], d["status"], d["healthy"]) for d in content["disks"]],
        "backups": [
            (b["id"], b["failed"], b["running"], b["last_result"], b["last_success_at"])
            for b in content["backups"]
        ],
        "unavailable": [u["op"] for u in content["unavailable"]],
    }
    text = json.dumps(significant, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode()).hexdigest()


class StateCache:
    """L'état gardé `ttl` secondes : le relais et les alertes du moteur le partagent, pour un
    seul jeu de lectures DSM ; les alertes s'en servent seules quand le relais est absent."""

    def __init__(self, source: Callable[[], Awaitable[BuiltState]], ttl: float = 30.0):
        self._source = source
        self._ttl = ttl
        self._hit: tuple[float, BuiltState] | None = None
        self._lock = asyncio.Lock()

    async def get(self) -> BuiltState:
        loop = asyncio.get_running_loop()
        async with self._lock:
            if self._hit is not None and loop.time() - self._hit[0] < self._ttl:
                return self._hit[1]
            built = await self._source()
            self._hit = (loop.time(), built)
            return built
