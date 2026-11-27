"""Relevé des constantes : chaque minute, des lectures du catalogue notées dans l'historique.

Les lectures passent par le moteur (cache, délais, deux appels simultanés au plus) :
`system.utilization`, `system.info`, `storage.overview`, et depuis le 2026-11-26 `ups.status`,
`containers.list` et `storage.smart` (conception 2026-11-26-meilleur-produit, section 3.1).
SMART garde son cache de 6 heures : ses valeurs ne sont notées que quand la lecture est neuve.
Une lecture facultative absente du NAS (Container Manager non installé) n'est pas une panne.
Le journal ne note pas chaque relevé, seulement le démarrage et les changements d'état de
chaque lecture, au plus une ligne par lecture toutes les 10 minutes (conception du 2026-11-23).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ValidationError

from nas_agent.audit import AuditLog
from nas_agent.catalog.ops.containers import ContainerList
from nas_agent.catalog.ops.smart import SmartReport
from nas_agent.catalog.ops.storage import StorageOverview
from nas_agent.catalog.ops.system import SystemInfo, Utilization
from nas_agent.catalog.ops.ups import UpsStatus
from nas_agent.dsm.gateway import (
    DsmCertificateError,
    DsmError,
    DsmUnreachable,
    DsmUnsupported,
)
from nas_agent.engine import Engine
from nas_agent.history import FailingRead, HistoryStore

log = logging.getLogger(__name__)

SAMPLED_OPS = (
    "system.utilization",
    "system.info",
    "storage.overview",
    "ups.status",
    "containers.list",
    "storage.smart",
)
# Lectures dont l'absence sur un NAS (paquet non installé) n'est pas une panne.
OPTIONAL_OPS = frozenset({"containers.list"})
# Lectures à cache long : notées une fois par lecture neuve.
SLOW_OPS = frozenset({"storage.smart"})
MAX_VOLUMES = 32
MAX_DISKS = 64
MAX_INTERFACES = 16
MAX_CONTAINERS = 64
_SUBJECT = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_PRUNE_EVERY = timedelta(hours=1)
_LOG_EVERY = timedelta(minutes=10)

Value = tuple[str, str, float]


def error_code(exc: BaseException) -> tuple[str, int | None]:
    """Code stable d'une lecture ratée, comme l'API les rend."""
    if isinstance(exc, DsmUnsupported):
        return "unsupported", None
    if isinstance(exc, DsmCertificateError):
        return "dsm_certificate", None
    if isinstance(exc, (DsmUnreachable, TimeoutError)):
        return "dsm_unreachable", None
    if isinstance(exc, DsmError):
        return "dsm_error", exc.code
    if isinstance(exc, (KeyError, TypeError, ValueError, ValidationError)):
        return "unexpected", None
    return "internal", None


def _subjects(items, limit: int):
    """Éléments à identifiant court et simple, sans doublon, `limit` au plus."""
    seen: set[str] = set()
    for item in items:
        if item.id is None or not _SUBJECT.match(item.id) or item.id in seen:
            continue
        seen.add(item.id)
        yield item
        if len(seen) == limit:
            return


def _named(names, limit: int):
    """Noms courts et simples, sans doublon, `limit` au plus."""
    seen: set[str] = set()
    for name in names:
        if name is None or not _SUBJECT.match(name) or name in seen:
            continue
        seen.add(name)
        yield name
        if len(seen) == limit:
            return


def extract(results: dict[str, BaseModel]) -> list[Value]:
    """Valeurs d'un relevé ; une valeur absente n'est pas notée, une température nulle non plus."""
    values: list[Value] = []

    def add(metric: str, subject: str, value: float | None) -> None:
        if value is not None:
            values.append((metric, subject, float(value)))

    util = results.get("system.utilization")
    storage = results.get("storage.overview")
    if isinstance(util, Utilization):
        add("cpu_pct", "", util.cpu.total_pct)
        add("memory_pct", "", util.memory.real_usage_pct)
        add("load_1m", "", util.cpu.load_1m)
        add("load_5m", "", util.cpu.load_5m)
        add("load_15m", "", util.cpu.load_15m)
        add("swap_pct", "", util.memory.swap_usage_pct)
        total = next((n for n in util.network if n.device == "total"), None)
        if total is not None:
            add("network_rx_bps", "", total.rx_bps)
            add("network_tx_bps", "", total.tx_bps)
        rates = {n.device: n for n in util.network if n.device != "total"}
        for device in _named(rates, MAX_INTERFACES):
            add("network_rx_bps", device, rates[device].rx_bps)
            add("network_tx_bps", device, rates[device].tx_bps)
        disks = {d.device: d for d in util.disks}
        for device in _named(disks, MAX_DISKS):
            add("disk_read_bps", device, disks[device].read_bps)
            add("disk_write_bps", device, disks[device].write_bps)
            add("disk_util_pct", device, disks[device].utilization_pct)
        if isinstance(storage, StorageOverview):
            # DSM nomme le volume « volume1 » dans l'utilisation, « volume_1 » dans le stockage.
            ids = {(v.path or "").lstrip("/"): v.id for v in storage.volumes}
            rates = {ids.get(v.name or ""): v for v in util.volumes}
            for volume in _named(rates, MAX_VOLUMES):
                add("volume_read_bps", volume, rates[volume].read_bps)
                add("volume_write_bps", volume, rates[volume].write_bps)
    info = results.get("system.info")
    if isinstance(info, SystemInfo) and info.temperature_c and info.temperature_c > 0:
        add("temperature_c", "", info.temperature_c)
    if isinstance(storage, StorageOverview):
        for volume in _subjects(storage.volumes, MAX_VOLUMES):
            add("volume_used_bytes", volume.id, volume.size_used_bytes)
            add("volume_total_bytes", volume.id, volume.size_total_bytes)
        for disk in _subjects(storage.disks, MAX_DISKS):
            if disk.temperature_c and disk.temperature_c > 0:
                add("disk_temperature_c", disk.id, disk.temperature_c)
    ups = results.get("ups.status")
    if isinstance(ups, UpsStatus) and ups.enabled:
        add("ups_charge_pct", "", ups.charge_percent)
    containers = results.get("containers.list")
    if isinstance(containers, ContainerList):
        running = {c.name: c for c in containers.containers if c.state == "running"}
        for name in _named(running, MAX_CONTAINERS):
            add("container_cpu_pct", name, running[name].cpu_pct)
            add("container_memory_bytes", name, running[name].memory_bytes)
    smart = results.get("storage.smart")
    if isinstance(smart, SmartReport):
        for disk in _subjects(smart.disks, MAX_DISKS):
            add("disk_reallocated", disk.id, disk.reallocated_sectors)
            add("disk_pending", disk.id, disk.pending_sectors)
            add("disk_uncorrectable", disk.id, disk.uncorrectable_sectors)
    return values


class Sampler:
    def __init__(
        self,
        engine: Engine,
        store: HistoryStore,
        audit: AuditLog,
        *,
        interval_s: int = 60,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._engine = engine
        self._store = store
        self._audit = audit
        self._interval = interval_s
        self._clock = clock
        self._sleep = sleep
        self._last_prune: datetime | None = None
        # Heure de la dernière lecture notée des lectures à cache long.
        self._slow_seen: dict[str, datetime] = {}
        # Dernier état journalisé de chaque lecture (None : en ordre) et heure de la ligne.
        self._logged: dict[str, tuple[str | None, datetime]] = {}
        store.status.interval_s = interval_s

    async def run(self) -> None:
        """Relève au démarrage, puis à chaque minute pleine, jusqu'à l'arrêt de l'agent."""
        self._journal(
            "metrics.sampler",
            "ok",
            params={"interval_s": self._interval, "reads": ",".join(SAMPLED_OPS)},
        )
        self._store.status.running = True
        try:
            while True:
                try:
                    await self.sample_once()
                except Exception:  # dernier filet : la boucle ne s'arrête jamais sur une erreur
                    log.exception("Vitals sampling failed")
                now = self._clock().timestamp()
                await self._sleep(self._interval - now % self._interval)
        finally:
            self._store.status.running = False

    async def sample_once(self) -> int:
        """Un relevé : les lectures en parallèle, chacune peut échouer seule."""
        at = self._clock()
        reads = await asyncio.gather(
            *(self._engine.read_internal(op_id) for op_id in SAMPLED_OPS),
            return_exceptions=True,
        )
        results: dict[str, BaseModel] = {}
        for op_id, read in zip(SAMPLED_OPS, reads, strict=True):
            if isinstance(read, asyncio.CancelledError):
                raise read
            if isinstance(read, DsmUnsupported) and op_id in OPTIONAL_OPS:
                self._recovered(op_id, at)
            elif isinstance(read, BaseException):
                self._failed(op_id, read, at)
            else:
                result, fetched_at = read
                self._recovered(op_id, at)
                if op_id in SLOW_OPS:
                    if self._slow_seen.get(op_id) == fetched_at:
                        continue
                    self._slow_seen[op_id] = fetched_at
                results[op_id] = result
        count = 0
        if results:
            count = self._store.record(at, extract(results))
            self._store.status.last_sample_at = at
        if self._last_prune is None or at - self._last_prune >= _PRUNE_EVERY:
            self._store.prune(at)
            self._last_prune = at
        return count

    def _failed(self, op_id: str, exc: BaseException, at: datetime) -> None:
        code, dsm_code = error_code(exc)
        if code == "internal":
            log.error("Internal read %s: unexpected error", op_id, exc_info=exc)
        failing = self._store.status.failing
        current = failing.get(op_id)
        if current is None or (current.code, current.dsm_code) != (code, dsm_code):
            since = current.since if current is not None else at
            failing[op_id] = FailingRead(code, dsm_code, since)
        self._transition(op_id, code, at, dsm_code)

    def _recovered(self, op_id: str, at: datetime) -> None:
        self._store.status.failing.pop(op_id, None)
        self._transition(op_id, None, at)

    def _transition(
        self, op_id: str, code: str | None, at: datetime, dsm_code: int | None = None
    ) -> None:
        """Une ligne quand l'état diffère du dernier journalisé, au plus toutes les 10 min."""
        last_code, last_at = self._logged.get(op_id, (None, None))
        if code == last_code or (last_at is not None and at - last_at < _LOG_EVERY):
            return
        self._logged[op_id] = (code, at)
        self._journal(op_id, "error" if code else "ok", code=code, dsm_code=dsm_code)

    def _journal(self, op: str, outcome, **fields) -> None:
        try:
            self._audit.record(
                channel="internal", op=op, token_id=None, client_ip=None, outcome=outcome, **fields
            )
        except Exception:  # base verrouillée ou pleine : le relevé continue
            log.exception("Cannot write the call log during sampling")
