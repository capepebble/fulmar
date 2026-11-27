"""Historique des constantes relevées par l'agent : aucune lecture de DSM, la base locale."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nas_agent.catalog.model import OpContext, Operation
from nas_agent.history import TIERS, HistoryStore, tier_named

Unit = Literal["percent", "celsius", "bytes_per_second", "bytes", "load", "count"]

# Ordre de sortie, unité, et si la série exige aussi storage:read. Ajouts du 2026-11-26
# (conception 2026-11-26-meilleur-produit, section 3.1) : parité Beszel et SMART.
METRICS: dict[str, tuple[Unit, bool]] = {
    "cpu_pct": ("percent", False),
    "load_1m": ("load", False),
    "load_5m": ("load", False),
    "load_15m": ("load", False),
    "memory_pct": ("percent", False),
    "swap_pct": ("percent", False),
    "temperature_c": ("celsius", False),
    "network_rx_bps": ("bytes_per_second", False),
    "network_tx_bps": ("bytes_per_second", False),
    "ups_charge_pct": ("percent", False),
    "container_cpu_pct": ("percent", False),
    "container_memory_bytes": ("bytes", False),
    "volume_used_bytes": ("bytes", True),
    "volume_total_bytes": ("bytes", True),
    "volume_read_bps": ("bytes_per_second", True),
    "volume_write_bps": ("bytes_per_second", True),
    "disk_temperature_c": ("celsius", True),
    "disk_read_bps": ("bytes_per_second", True),
    "disk_write_bps": ("bytes_per_second", True),
    "disk_util_pct": ("percent", True),
    "disk_reallocated": ("count", True),
    "disk_pending": ("count", True),
    "disk_uncorrectable": ("count", True),
}
Metric = Literal[
    "cpu_pct",
    "load_1m",
    "load_5m",
    "load_15m",
    "memory_pct",
    "swap_pct",
    "temperature_c",
    "network_rx_bps",
    "network_tx_bps",
    "ups_charge_pct",
    "container_cpu_pct",
    "container_memory_bytes",
    "volume_used_bytes",
    "volume_total_bytes",
    "volume_read_bps",
    "volume_write_bps",
    "disk_temperature_c",
    "disk_read_bps",
    "disk_write_bps",
    "disk_util_pct",
    "disk_reallocated",
    "disk_pending",
    "disk_uncorrectable",
]


class HistoryParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tier: Literal["1m", "20m", "120m", "480m"] = Field(
        "20m",
        description="Tier: 1m (kept 24 h), 20m (14 days), 120m (90 days), 480m (400 days).",
    )
    hours: int | None = Field(
        None,
        ge=1,
        le=max(t.retention_h for t in TIERS),
        description="Window in hours up to now, at most the tier's retention. Default: 1 h for "
        "1m, 24 h for 20m, 7 days for 120m, 30 days for 480m.",
    )

    @model_validator(mode="after")
    def _within_retention(self) -> HistoryParams:
        tier = tier_named(self.tier)
        if tier is not None and self.hours is not None and self.hours > tier.retention_h:
            raise ValueError(f"tier {tier.name} reads at most {tier.retention_h} h")
        return self


class HistoryPoint(BaseModel):
    t: datetime = Field(description="Start of the bucket, in UTC.")
    avg: float = Field(description="Average of the bucket's one-minute samples.")
    max: float = Field(description="Highest sample of the bucket.")
    n: int = Field(
        description="Number of one-minute samples: fewer than the step for the current bucket or "
        "when samples were missed."
    )


class LatestValue(BaseModel):
    t: datetime = Field(description="Minute of the last sample, in UTC.")
    value: float


class HistorySeries(BaseModel):
    metric: Metric
    subject: str | None = Field(
        description="DSM identifier of the volume, disk or network interface, or the container "
        "name; missing for the whole NAS."
    )
    unit: Unit
    latest: LatestValue | None = Field(
        description="Last one-minute sample of the series, whatever the tier read: the current "
        "value when its time is recent."
    )
    points: list[HistoryPoint]


class FailingReadOut(BaseModel):
    op: str = Field(description="Catalog read made by the sampler.")
    code: str = Field(description="Stable failure code, like the API's.")
    dsm_code: int | None
    since: datetime = Field(description="First sample of the current run of failures.")


class Sampling(BaseModel):
    enabled: bool = Field(description="Sampling enabled in the configuration ([history] enabled).")
    running: bool = Field(description="Sampling loop running in the agent.")
    interval_s: int
    last_sample_at: datetime | None = Field(
        description="Last sample with at least one successful read."
    )
    failing: list[FailingReadOut] = Field(description="Sampler reads that are failing.")


class MetricsHistory(BaseModel):
    tier: str
    step_s: int = Field(description="Tier step, in seconds.")
    retention_hours: int = Field(description="How long the agent keeps this tier.")
    since: datetime
    until: datetime
    storage_included: bool = Field(
        description="Volume usage and disk temperatures: returned only when the token also has "
        "the storage:read scope."
    )
    sampling: Sampling
    series: list[HistorySeries]


def _sampling(store: HistoryStore | None) -> Sampling:
    if store is None:
        return Sampling(
            enabled=False, running=False, interval_s=60, last_sample_at=None, failing=[]
        )
    status = store.status
    return Sampling(
        enabled=True,
        running=status.running,
        interval_s=status.interval_s,
        last_sample_at=status.last_sample_at,
        failing=[
            FailingReadOut(op=op, code=f.code, dsm_code=f.dsm_code, since=f.since)
            for op, f in sorted(status.failing.items())
        ],
    )


def _history(ctx: OpContext, _responses) -> MetricsHistory:
    params = ctx.params if isinstance(ctx.params, HistoryParams) else HistoryParams()
    tier = tier_named(params.tier) or TIERS[1]
    until = ctx.fetched_at
    if until is None:  # pragma: no cover - le moteur donne toujours l'heure de la lecture
        raise ValueError("missing read time")
    since = until - timedelta(hours=params.hours or tier.default_h)
    with_storage = "storage:read" in ctx.principal.scopes
    store = ctx.history
    points = store.read(tier.name, since) if store else {}
    latest = store.latest() if points and store else {}
    series = []
    for metric, (unit, storage) in METRICS.items():
        if storage and not with_storage:
            continue
        for _metric, subject in sorted(k for k in points if k[0] == metric):
            last = latest.get((metric, subject))
            series.append(
                HistorySeries(
                    metric=metric,
                    subject=subject or None,
                    unit=unit,
                    latest=LatestValue(t=last[0], value=round(last[1], 2)) if last else None,
                    points=[
                        HistoryPoint(t=p.t, avg=round(p.avg, 2), max=round(p.max, 2), n=p.n)
                        for p in points.get((metric, subject), [])
                    ],
                )
            )
    return MetricsHistory(
        tier=tier.name,
        step_s=tier.step_s,
        retention_hours=tier.retention_h,
        since=since,
        until=until,
        storage_included=with_storage,
        sampling=_sampling(store),
        series=series,
    )


OPERATIONS = [
    Operation(
        id="metrics.history",
        title="Vitals: history",
        description="Vitals sampled every minute by the agent and kept on the NAS, summarized by "
        "tier: CPU and load, memory and swap, temperature, network (total and per "
        "interface), UPS charge, containers; with the storage:read scope, volume usage "
        "and I/O, disk temperatures and I/O, SMART sector counts (every 6 hours). Each "
        "point gives the average, the maximum and the number of samples in its bucket; "
        "each series, its last sample. Tiers: 1m (24 h), 20m (14 days), 120m (90 days), "
        "480m (400 days).",
        kind="read",
        scope="system:read",
        path="/metrics/history",
        result_model=MetricsHistory,
        transform=_history,
        params_model=HistoryParams,
        cache_ttl=0,
    ),
]
