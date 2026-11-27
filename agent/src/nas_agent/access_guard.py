"""Le gardien des accès : fermer un accès resté ouvert, jamais l'ouvrir (conception
2026-11-26-fermer-acces).

Chaque minute, il lit SSH et Telnet dans DSM, note depuis quand chacun est ouvert et son
échéance selon la règle choisie (ne rien faire, rappeler, fermer), et ferme à l'échéance quand
la règle le veut. Il n'appelle que les appels fixés dans `catalog/ops/close_access.py`, dont
aucun ne porte une valeur « vraie ». Règles et état dans `data/access.json`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from nas_agent.audit import AuditLog
from nas_agent.catalog.ops.close_access import CLOSE, SERVICES, TERMINAL_GET
from nas_agent.dsm.gateway import DsmCaller, DsmGatewayError

log = logging.getLogger(__name__)

Mode = Literal["off", "remind", "close"]
MODES: tuple[Mode, ...] = ("off", "remind", "close")
LOOP_S = 60.0
MIN_MINUTES, MAX_MINUTES = 15, 24 * 60
MAX_EXTEND = 8 * 60
# Une échéance ne s'éloigne jamais de plus de 24 heures de maintenant.
HORIZON = timedelta(hours=24)


@dataclass
class Policy:
    mode: Mode = "off"
    minutes: int = 60


@dataclass
class Watch:
    open: bool | None = None
    open_since: str | None = None
    deadline: str | None = None
    # Fermé par Fulmar (gardien ou console) ; effacé si l'accès rouvre.
    closed_at: str | None = None
    checked_at: str | None = None


@dataclass
class Entry:
    policy: Policy = field(default_factory=Policy)
    watch: Watch = field(default_factory=Watch)


class AccessGuard:
    def __init__(
        self,
        dsm: DsmCaller,
        audit: AuditLog,
        *,
        path: Path | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        on_closed: Callable[[], None] | None = None,
    ):
        self._dsm = dsm
        self._audit = audit
        self._path = path
        self._clock = clock
        self._on_closed = on_closed
        self._entries: dict[str, Entry] = {s: Entry() for s in SERVICES}
        self._lock = asyncio.Lock()
        self._load()

    # Disque -----------------------------------------------------------------------------------

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text())
            for service in SERVICES:
                raw = data.get(service) or {}
                policy = Policy(**raw.get("policy", {}))
                if policy.mode not in MODES:
                    policy = Policy()
                self._entries[service] = Entry(policy, Watch(**raw.get("watch", {})))
        except (OSError, ValueError, TypeError):
            log.exception("Cannot read the access state: starting afresh")

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_name(f".{self._path.name}.tmp")
            tmp.write_text(json.dumps({s: asdict(e) for s, e in self._entries.items()}, indent=1))
            os.replace(tmp, self._path)
        except OSError:
            log.exception("Cannot save the access state")

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
        except Exception:
            log.exception("Cannot write the call log")

    # Lecture ----------------------------------------------------------------------------------

    def snapshot(self) -> list[dict[str, Any]]:
        return [
            {"service": s, **asdict(e.watch), "policy": asdict(e.policy)}
            for s, e in self._entries.items()
        ]

    def observe(self, terminal: dict[str, Any]) -> None:
        """Ce que DSM dit de chaque accès : depuis quand il est ouvert, et son échéance."""
        now = self._clock()
        for service in SERVICES:
            value = terminal.get(f"enable_{service}")
            if not isinstance(value, bool):
                continue
            e = self._entries[service]
            w = e.watch
            w.checked_at = now.isoformat()
            if value:
                if not w.open or w.open_since is None:
                    w.open_since, w.closed_at = now.isoformat(), None
                    w.deadline = (
                        (now + timedelta(minutes=e.policy.minutes)).isoformat()
                        if e.policy.mode != "off"
                        else None
                    )
                w.open = True
            else:
                w.open, w.open_since, w.deadline = False, None, None
        self._save()

    # Règles -----------------------------------------------------------------------------------

    def set_policy(self, service: str, mode: Mode, minutes: int) -> dict[str, Any]:
        if service not in SERVICES or mode not in MODES:
            raise ValueError("unknown access or rule")
        minutes = max(MIN_MINUTES, min(MAX_MINUTES, int(minutes)))
        e = self._entries[service]
        e.policy = Policy(mode, minutes)
        now = self._clock()
        # Posée sur un accès déjà ouvert, l'échéance part de maintenant : jamais sur-le-champ.
        e.watch.deadline = (
            (now + timedelta(minutes=minutes)).isoformat()
            if mode != "off" and e.watch.open
            else None
        )
        self._save()
        return self.view(service)

    def extend(self, service: str, minutes: int) -> dict[str, Any]:
        e = self._entries.get(service)
        if e is None or not e.watch.open or e.watch.deadline is None:
            raise ValueError("no deadline to push back")
        minutes = max(MIN_MINUTES, min(MAX_EXTEND, int(minutes)))
        now = self._clock()
        base = max(datetime.fromisoformat(e.watch.deadline), now)
        e.watch.deadline = min(base + timedelta(minutes=minutes), now + HORIZON).isoformat()
        self._save()
        return self.view(service)

    def view(self, service: str) -> dict[str, Any]:
        return next(w for w in self.snapshot() if w["service"] == service)

    # Fermer -----------------------------------------------------------------------------------

    def closed_by_request(self, service: str) -> dict[str, Any]:
        """Après `access.close` passé par le moteur (appel déjà journalisé) : noter la fermeture."""
        w = self._entries[service].watch
        w.open, w.open_since, w.deadline = False, None, None
        w.closed_at = self._clock().isoformat()
        self._save()
        if self._on_closed is not None:
            self._on_closed()
        return self.view(service)

    async def _read(self) -> dict[str, Any]:
        return await self._dsm.call(
            TERMINAL_GET.api, TERMINAL_GET.method, max_version=TERMINAL_GET.max_version
        )

    async def _close(self, service: str) -> None:
        call = CLOSE[service]
        params = {"service": service}
        try:
            await self._dsm.call(
                call.api, call.method, max_version=call.max_version, params=dict(call.params)
            )
            after = await self._read()
        except DsmGatewayError as exc:
            self._record("access.close", "error", params, getattr(exc, "code", None))
            return
        if after.get(f"enable_{service}") is False:
            self.observe(after)
            self.closed_by_request(service)
            self._record("access.close", "ok", params)
        else:
            self._record("access.close", "error", {**params, "reason": "still open"})

    async def tick(self) -> None:
        async with self._lock:
            try:
                self.observe(await self._read())
            except DsmGatewayError as exc:
                log.warning("Access guard: Terminal unreadable (%s).", type(exc).__name__)
                return
            now = self._clock()
            for service, e in self._entries.items():
                due = e.watch.deadline and datetime.fromisoformat(e.watch.deadline) <= now
                if e.policy.mode == "close" and e.watch.open and due:
                    await self._close(service)

    async def run(self, every_s: float = LOOP_S) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # la boucle ne meurt jamais
                log.exception("Access guard failed")
            await asyncio.sleep(every_s)
