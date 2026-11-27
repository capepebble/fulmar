"""Moteur : droits, paramètres, débit, cache, appel DSM, transformation, journal."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ValidationError

from nas_agent.audit import AuditLog, Channel
from nas_agent.catalog.model import (
    Catalog,
    DsmCall,
    Each,
    OpContext,
    Operation,
    OpRefused,
    SubResult,
)
from nas_agent.config import Settings
from nas_agent.dsm.gateway import (
    DsmAuthError,
    DsmCaller,
    DsmCertificateError,
    DsmError,
    DsmUnreachable,
    DsmUnsupported,
)
from nas_agent.history import HistoryStore
from nas_agent.i18n import Lang
from nas_agent.ratelimit import RateLimiter
from nas_agent.tokens import Principal

log = logging.getLogger(__name__)

# Celui qui lit quand l'agent lit pour lui-même : jamais un jeton, jamais dans le journal.
INTERNAL = Principal(
    token_id="internal",  # noqa: S106 - un nom, pas un secret
    label="vitals sampler",
    scopes=frozenset({"system:read", "storage:read"}),
)

_CACHE_MAX = 256
# Un échec de DSM est gardé ce temps-là : les appels en attente échouent vite au lieu d'insister.
_FAILURE_TTL = 5.0
# Les refus pour débit excessif ne sont journalisés qu'une fois par fenêtre et par jeton.
_THROTTLE_LOG_S = 60.0
_UNSAFE = re.compile(r"[^a-z0-9._-]")
# Valeur venue de DSM et renvoyée à DSM en paramètre d'un appel répété (`Each`).
# Valeurs simples, ou un disque (« /dev/sata1 », « /dev/nvme0n1 »), jamais un autre chemin.
_EACH_VALUE = re.compile(r"^(?:/dev/)?[A-Za-z0-9_-]{1,64}$")
# Nom libre (`Each.as_json`) : ni caractère de contrôle, ni nom vide, 255 caractères au plus.
_EACH_NAME = re.compile(r"^[^\x00-\x1f\x7f]{1,255}$")


def safe_name(value: str) -> str:
    """Nom d'opération venu de l'appelant, borné avant d'aller au journal ou dans un message."""
    return _UNSAFE.sub("?", str(value)[:64].lower()) or "?"


class OpError(Exception):
    """Erreur rendue à l'appelant : un code stable et un détail en anglais, sans secret."""

    def __init__(self, code: str, status: int, detail: str, dsm_code: int | None = None):
        super().__init__(detail)
        self.code = code
        self.status = status
        self.detail = detail
        self.dsm_code = dsm_code


@dataclass(frozen=True)
class Envelope:
    op: str
    fetched_at: datetime
    cached: bool
    data: dict[str, Any]


@dataclass(frozen=True)
class _Cached:
    mono: float
    wall: datetime
    data: dict[str, Any]


class Engine:
    def __init__(
        self,
        catalog: Catalog,
        dsm: DsmCaller,
        audit: AuditLog,
        settings: Settings,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        service_account: str | None = None,
        history: HistoryStore | None = None,
    ):
        self.catalog = catalog
        self._dsm = dsm
        self._audit = audit
        self._settings = settings
        self._clock = clock
        self._wall = wall_clock
        self._service_account = service_account
        self._history = history
        self._limiter = RateLimiter(settings.limits.calls_per_minute, 60.0, clock)
        self._cache: OrderedDict[str, _Cached] = OrderedDict()
        self._failures: dict[str, tuple[float, Exception]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._throttle_logged: dict[str, float] = {}
        # Module relay, posé par l'assemblage (opérations devices.*).
        self.relay: Any = None
        # Lecteur des pages de Synology (avis, statut des modèles) ; None : rien de lu.
        self.synology: Any = None
        # Mises à jour des paquets (première écriture de l'agent) ; None : impossible.
        self.updates: Any = None
        # Carte sur table (agent.access, agent.detach) ; None : jetons et parc inconnus.
        self.access: Any = None
        # Gardien des accès (fermer SSH ou Telnet resté ouvert) ; None : aucune règle.
        self.guard: Any = None
        # Protections : ce que Fulmar ne met jamais à jour sur ce NAS ; None : rien.
        self.protections: Any = None
        # Journal des verdicts (bilan du mois) ; None : aucun incident gardé.
        self.verdicts: Any = None

    def _record(self, **fields: Any) -> None:
        try:
            self._audit.record(**fields)
        except Exception:  # base pleine ou verrouillée : l'appel échoue, sans trace interne
            log.exception("Cannot write the call log")
            raise OpError("internal", 500, "Internal agent error.") from None

    def invalidate(self, api_prefix: str) -> None:
        """Oublie les réponses gardées des API qui commencent ainsi (après une écriture)."""
        for key in [k for k in self._cache if k.startswith(api_prefix)]:
            del self._cache[key]

    def admit(
        self, principal: Principal, *, channel: Channel, client_ip: str | None, label: str
    ) -> None:
        """Débit et journal des appels hors catalogue (liste des opérations, OpenAPI, MCP)."""
        self._check_rate(principal, channel, client_ip, label)
        self._record(
            channel=channel,
            op=label,
            token_id=principal.token_id,
            client_ip=client_ip,
            outcome="ok",
        )

    def _check_rate(
        self, principal: Principal, channel: Channel, client_ip: str | None, label: str
    ) -> None:
        if self._limiter.check(principal.token_id):
            return
        now = self._clock()
        if now - self._throttle_logged.get(principal.token_id, -1e9) >= _THROTTLE_LOG_S:
            self._throttle_logged[principal.token_id] = now
            self._record(
                channel=channel,
                op=label,
                token_id=principal.token_id,
                client_ip=client_ip,
                outcome="denied",
                code="rate_limited",
            )
        raise OpError("rate_limited", 429, "Too many calls for this token: try again in a minute.")

    async def run(
        self,
        op_id: str,
        raw_params: Mapping[str, Any],
        principal: Principal,
        *,
        channel: Channel,
        client_ip: str | None,
        lang: Lang | None = None,
    ) -> Envelope:
        started = self._clock()
        op = self.catalog.get(op_id)
        label = op.id if op else safe_name(op_id)
        self._check_rate(principal, channel, client_ip, label)

        def deny(code: str, status: int, detail: str, outcome: str = "denied", **kw: Any):
            self._record(
                channel=channel,
                op=label,
                token_id=principal.token_id,
                client_ip=client_ip,
                outcome=outcome,
                code=code,
                dsm_code=kw.get("dsm_code"),
                duration_ms=int((self._clock() - started) * 1000),
            )
            return OpError(code, status, detail, kw.get("dsm_code"))

        if op is None:
            raise deny("not_found", 404, f"Unknown operation: {label}")
        if not op.allowed_for(principal):
            raise deny("forbidden", 403, f"This token lacks the {op.scope} scope for {op.id}.")
        try:
            params = _validate_params(op, raw_params)
        except ValueError as exc:
            raise deny("invalid_params", 422, str(exc)) from None

        try:
            async with asyncio.timeout(self._settings.dsm.timeout * 3):
                if op.composes:
                    responses, cached, fetched_at = await self._compose(op, principal)
                else:
                    responses, cached, fetched_at = await self._fetch_all(op, params)
            context = self._context(principal, params, fetched_at, lang)
            result = op.transform(context, responses)
            data = op.result_model.model_validate(result).model_dump(mode="json")
        except OpRefused as exc:
            raise deny(exc.code, exc.status, exc.detail, outcome="error") from None
        except DsmUnsupported:
            raise deny(
                "unsupported", 501, f"{op.id} is not supported by this NAS.", outcome="error"
            ) from None
        except DsmCertificateError:
            raise deny(
                "dsm_certificate",
                503,
                "DSM's certificate has changed: check it, then enroll again.",
                outcome="error",
            ) from None
        except (DsmUnreachable, TimeoutError):
            raise deny("dsm_unreachable", 503, "DSM does not answer.", outcome="error") from None
        except DsmError as exc:
            raise deny(
                "dsm_error",
                502,
                f"DSM refused the call (code {exc.code}).",
                outcome="error",
                dsm_code=exc.code,
            ) from None
        except (KeyError, TypeError, ValueError, ValidationError):
            raise deny(
                "dsm_error", 502, f"Unexpected answer from DSM for {op.id}.", outcome="error"
            ) from None
        except OpError:
            raise
        except Exception:
            log.exception("Internal error during %s", op.id)
            raise deny("internal", 500, "Internal agent error.", outcome="error") from None

        self._record(
            channel=channel,
            op=op.id,
            token_id=principal.token_id,
            client_ip=client_ip,
            outcome="ok",
            duration_ms=int((self._clock() - started) * 1000),
            params=params.model_dump(mode="json") if params else None,
        )
        return Envelope(op=op.id, fetched_at=fetched_at, cached=cached, data=data)

    async def read_internal(
        self,
        op_id: str,
        params: Mapping[str, Any] | None = None,
        principal: Principal = INTERNAL,
        lang: Lang | None = None,
    ) -> tuple[BaseModel, datetime]:
        """Lecture de l'agent pour lui-même (relevé des constantes, état pour les téléphones).

        Réservée aux lectures du catalogue, composées comprises, paramètres validés comme
        pour l'API. Ni jeton, ni débit, ni journal par appel (le relevé et le module relay
        journalisent leurs changements d'état) ; le cache, les délais et la mémoire des pannes
        sont ceux de l'API. `principal` ne sert qu'aux transformations (droits implicites,
        noms de comptes : jamais `personal:read` pour les lectures internes). Les erreurs de
        DSM remontent telles quelles.
        """
        op = self.catalog.get(op_id)
        if op is None or op.kind != "read":
            raise ValueError(f"Cannot read internally: {safe_name(op_id)}")
        validated = _validate_params(op, params or {})
        async with asyncio.timeout(self._settings.dsm.timeout * 3):
            if op.composes:
                responses, _cached, fetched_at = await self._compose(op, principal)
            else:
                responses, _cached, fetched_at = await self._fetch_all(op, validated)
        result = op.transform(self._context(principal, validated, fetched_at, lang), responses)
        return op.result_model.model_validate(result), fetched_at

    def _context(
        self,
        principal: Principal,
        params: BaseModel | None,
        fetched_at: datetime | None,
        lang: Lang | None = None,
    ) -> OpContext:
        return OpContext(
            params=params,
            principal=principal,
            audit=self._audit,
            settings=self._settings,
            visible_ops=tuple(o.id for o in self.catalog.visible_to(principal)),
            fetched_at=fetched_at,
            service_account=self._service_account,
            history=self._history,
            relay=self.relay,
            synology=self.synology,
            updates=self.updates,
            access=self.access,
            guard=self.guard,
            protections=self.protections,
            verdicts=self.verdicts,
            lang=lang or self._settings.language,
        )

    async def _compose(
        self, op: Operation, principal: Principal
    ) -> tuple[dict[str, SubResult], bool, datetime]:
        """Lectures d'une opération composée, en parallèle ; un échec n'arrête que la sienne.

        DSM injoignable, certificat changé ou connexion refusée font échouer le tout.
        """
        subs = [self.catalog.get(sub_id) for sub_id in op.composes]
        reads = await asyncio.gather(*(self._read(sub, principal) for sub in subs if sub))
        results = {sub_id: read[0] for sub_id, read in zip(op.composes, reads, strict=True)}
        oldest = min((r.fetched_at for r in results.values() if r.fetched_at), default=None)
        return results, all(read[1] for read in reads), oldest or self._wall()

    async def _read(self, sub: Operation, principal: Principal) -> tuple[SubResult, bool]:
        try:
            responses, cached, fetched_at = await self._fetch_all(sub, None)
            result = sub.transform(self._context(principal, None, fetched_at), responses)
            return SubResult(sub.result_model.model_validate(result), fetched_at=fetched_at), cached
        except (DsmAuthError, DsmUnreachable):
            raise
        except DsmUnsupported:
            return SubResult(None, "unsupported"), False
        except DsmError as exc:
            return SubResult(None, "dsm_error", exc.code), False
        except (KeyError, TypeError, ValueError, ValidationError):
            return SubResult(None, "unexpected"), False

    async def _fetch_all(
        self, op: Operation, params: BaseModel | None
    ) -> tuple[dict[str, dict[str, Any]], bool, datetime]:
        responses: dict[str, Any] = {}
        all_cached = bool(op.calls)
        oldest = self._wall()
        for call in op.calls:
            base = _call_params(call, params)
            if call.each is None:
                fetched = [(None, await self._fetch_one(call, base, op.cache_ttl))]
            else:
                responses[call.key] = {}
                values = _each_values(responses[call.each.source], call.each)
                results = await asyncio.gather(
                    *(
                        self._fetch_one(
                            call, {**base, call.each.key: _each_param(call.each, v)}, op.cache_ttl
                        )
                        for v in values
                    )
                )
                fetched = list(zip(values, results, strict=True))
            for value, got in fetched:
                # Copie : une transformation ne doit jamais altérer le cache partagé.
                data = None if got is None else copy.deepcopy(got[0].data)
                if call.each is None:
                    responses[call.key] = data
                else:
                    responses[call.key][str(value)] = data
                if got is not None:
                    all_cached = all_cached and got[1]
                    oldest = min(oldest, got[0].wall)
        return responses, all_cached, oldest

    async def _fetch_one(
        self, call: DsmCall, params: Mapping[str, Any], ttl: float
    ) -> tuple[_Cached, bool] | None:
        try:
            return await self._fetch(call, params, ttl)
        except DsmAuthError:
            raise
        except DsmError as exc:
            if call.keep_error:
                error = {"_dsm_error": {"code": exc.code, "details": exc.details}}
                return _Cached(self._clock(), self._wall(), error), False
            if not call.optional:
                raise
            return None
        except DsmUnsupported:
            if not call.optional:
                raise
            return None

    async def _fetch(
        self, call: DsmCall, params: Mapping[str, Any], ttl: float
    ) -> tuple[_Cached, bool]:
        key = f"{call.key}?v{call.max_version}&{json.dumps(params, sort_keys=True, default=str)}"
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._cache.get(key)
            if entry is not None and self._clock() - entry.mono < ttl:
                return entry, True
            failure = self._failures.get(key)
            if failure is not None and self._clock() - failure[0] < _FAILURE_TTL:
                raise failure[1]
            try:
                data = await self._dsm.call(
                    call.api,
                    call.method,
                    max_version=call.max_version,
                    min_version=call.min_version,
                    params=params,
                )
            except (DsmUnreachable, DsmError) as exc:
                # Un refus gardé pour la transformation n'est pas une panne à retenir.
                if not (call.keep_error and isinstance(exc, DsmError)):
                    self._failures[key] = (self._clock(), exc)
                raise
            self._failures.pop(key, None)
            entry = _Cached(self._clock(), self._wall(), data)
            self._cache[key] = entry
            self._cache.move_to_end(key)
            while len(self._cache) > _CACHE_MAX:
                self._cache.popitem(last=False)
            return entry, False


def _validate_params(op: Operation, raw: Mapping[str, Any]) -> BaseModel | None:
    if op.params_model is None:
        if raw:
            raise ValueError(f"{op.id} takes no parameters.")
        return None
    try:
        return op.params_model.model_validate(dict(raw))
    except ValidationError as exc:
        # Seuls l'emplacement et le message : jamais la valeur reçue.
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or 'parameters'}: {e['msg']}"
            for e in exc.errors()
        )
        raise ValueError(f"Invalid parameters for {op.id}: {problems}") from None


def _each_values(source: Any, each: Each) -> list[str | int]:
    """Clés des éléments de la réponse source, sans doublon, bornées en nombre et en forme."""
    items = source.get(each.items) if isinstance(source, Mapping) else None
    values: list[str | int] = []
    for item in items if isinstance(items, list) else []:
        value = item.get(each.key) if isinstance(item, Mapping) else None
        if not _each_value_ok(value, each) or str(value) in {str(v) for v in values}:
            continue
        values.append(value)
        if len(values) == each.limit:
            break
    return values


def _each_value_ok(value: Any, each: Each) -> bool:
    if each.as_json:
        return isinstance(value, str) and bool(_EACH_NAME.match(value))
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return False
    return bool(_EACH_VALUE.match(str(value)))


def _each_param(each: Each, value: str | int) -> str | int:
    return json.dumps(value, ensure_ascii=False) if each.as_json else value


def _call_params(call: DsmCall, params: BaseModel | None) -> Mapping[str, Any]:
    if callable(call.params):
        return call.params(params)
    return call.params
