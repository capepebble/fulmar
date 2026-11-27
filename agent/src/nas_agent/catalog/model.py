"""Modèle déclaratif d'une opération : la seule façon d'atteindre DSM depuis l'agent."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel

from nas_agent.i18n import Lang
from nas_agent.tokens import KNOWN_SCOPES, Principal

if TYPE_CHECKING:
    from nas_agent.audit import AuditLog
    from nas_agent.config import Settings
    from nas_agent.history import HistoryStore
    from nas_agent.relay.service import RelayService

Kind = Literal["read", "action"]

_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
_PATH_RE = re.compile(r"^(/[a-z0-9_-]+)+$")


class OpRefused(Exception):
    """Refus rendu par une transformation (opérations de l'agent lui-même) : code stable,
    statut HTTP et détail en anglais, jamais de secret."""

    def __init__(self, code: str, status: int, detail: str):
        super().__init__(detail)
        self.code = code
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class Each:
    """Répète un appel pour chaque élément d'une réponse précédente de la même opération.

    Le champ `key` de chaque élément de `source[items]` passe en paramètre de même nom. Ces
    valeurs viennent de DSM : seules les valeurs simples et courtes passent, `limit` au plus.
    `as_json` : la valeur est un nom libre (dossier partagé), envoyé encodé en JSON, sans
    caractère de contrôle et de 255 caractères au plus ; sans lui, DSM lirait « true » ou
    « 2024 » comme un booléen ou un nombre.
    """

    source: str
    items: str
    key: str
    limit: int = 32
    as_json: bool = False


@dataclass(frozen=True)
class DsmCall:
    api: str
    method: str
    max_version: int
    # Paramètres fixes, ou fonction des paramètres validés de l'opération.
    params: Mapping[str, Any] | Callable[[BaseModel | None], Mapping[str, Any]] = field(
        default_factory=dict
    )
    # Version minimale dont la forme de réponse est connue ; en dessous : « non pris en charge ».
    min_version: int = 1
    # Appel répété par élément : sa réponse devient {valeur de la clé: réponse}.
    each: Each | None = None
    # Facultatif : un refus de DSM ou une API absente donne None au lieu de faire échouer
    # l'opération (DSM injoignable la fait toujours échouer).
    optional: bool = False
    # Un refus de DSM devient la réponse {"_dsm_error": {"code", "details"}} : la transformation
    # en lit les raisons (vérification avant une mise à jour). Jamais gardé en cache.
    keep_error: bool = False

    @property
    def key(self) -> str:
        return f"{self.api}.{self.method}"


@dataclass(frozen=True)
class OpContext:
    """Ce qu'une transformation peut lire en plus des réponses DSM."""

    params: BaseModel | None
    principal: Principal
    audit: AuditLog
    settings: Settings
    visible_ops: tuple[str, ...] = ()
    # Heure de la plus ancienne réponse DSM utilisée, pour les durées (« expire dans 12 jours »).
    fetched_at: datetime | None = None
    # Compte DSM de l'agent : signalé comme tel dans les listes de comptes.
    service_account: str | None = None
    # Historique des constantes relevées par l'agent ; None si le relevé est désactivé.
    history: HistoryStore | None = None
    # Module relay (téléphones appairés) ; None hors de `nas-agent serve`.
    relay: RelayService | None = None
    # Lecteur des pages de Synology (nas_agent.synology.SynologyFeed) ; None hors de `serve`.
    synology: Any = None
    # Mises à jour des paquets (nas_agent.updates.UpdateService) ; None hors de `serve`.
    updates: Any = None
    # Jetons, parc et détachement (nas_agent.access.AccessSources) ; None hors de `serve`.
    access: Any = None
    # Gardien des accès (nas_agent.access_guard.AccessGuard) ; None hors de `serve`.
    guard: Any = None
    # Protections du NAS (nas_agent.protections.ProtectionStore) ; None : rien de protégé.
    protections: Any = None
    # Journal des verdicts (nas_agent.verdicts.VerdictLog) ; None hors de `serve`.
    verdicts: Any = None
    # Langue des textes composés (verdicts) : celle de la requête, sinon celle de l'agent.
    lang: Lang = "en"


@dataclass(frozen=True)
class SubResult:
    """Lecture faite par une opération composée : son résultat, ou la raison de son échec.

    `error` : « unsupported » (API absente), « dsm_error » (refus de DSM, `dsm_code`),
    « unexpected » (réponse de forme inattendue).
    """

    result: BaseModel | None
    error: str | None = None
    dsm_code: int | None = None
    # Heure de la plus ancienne réponse DSM de cette lecture.
    fetched_at: datetime | None = None


# Réponses DSM par « api.method », ou, pour une opération composée, SubResult par opération.
Transform = Callable[[OpContext, Mapping[str, Any]], BaseModel]


@dataclass(frozen=True)
class Operation:
    id: str
    title: str
    description: str
    kind: Kind
    scope: str
    path: str
    result_model: type[BaseModel]
    transform: Transform
    calls: tuple[DsmCall, ...] = ()
    params_model: type[BaseModel] | None = None
    cache_ttl: float = 15.0
    personal: bool = False
    verified_on: str | None = None
    # Opération composée : lit ces opérations du catalogue, placées avant elle, sans hériter de
    # leurs droits ; sa transformation reçoit {identifiant: SubResult}.
    composes: tuple[str, ...] = ()

    @property
    def tool_name(self) -> str:
        return self.id.replace(".", "_")

    def allowed_for(self, principal: Principal) -> bool:
        if self.scope not in principal.scopes:
            return False
        return not self.personal or "personal:read" in principal.scopes


class Catalog:
    def __init__(self, ops: Iterable[Operation]):
        self._ops: dict[str, Operation] = {}
        paths: set[str] = set()
        for op in ops:
            if not _ID_RE.match(op.id):
                raise ValueError(f"Invalid operation id: {op.id}")
            if not _PATH_RE.match(op.path):
                raise ValueError(f"Invalid path for {op.id}: {op.path}")
            if op.id in self._ops or op.path in paths:
                raise ValueError(f"Duplicate operation or path: {op.id} {op.path}")
            if op.scope not in KNOWN_SCOPES:
                raise ValueError(f"Unknown scope for {op.id}: {op.scope}")
            _check_each(op)
            _check_composes(op, self._ops)
            if op.params_model is not None:
                extra = op.params_model.model_config.get("extra")
                if extra != "forbid":
                    raise ValueError(f"{op.id}: the parameters model must forbid unknown fields")
            self._ops[op.id] = op
            paths.add(op.path)

    def get(self, op_id: str) -> Operation | None:
        return self._ops.get(op_id)

    def visible_to(self, principal: Principal) -> list[Operation]:
        return [op for op in self._ops.values() if op.allowed_for(principal)]

    def __iter__(self) -> Iterator[Operation]:
        return iter(self._ops.values())

    def __len__(self) -> int:
        return len(self._ops)


def _check_each(op: Operation) -> None:
    earlier: set[str] = set()
    for call in op.calls:
        if call.each is not None and call.each.source not in earlier:
            raise ValueError(
                f"{op.id}: {call.key} repeats a call that is missing or placed after it"
            )
        if call.each is None:
            earlier.add(call.key)


def _check_composes(op: Operation, earlier: Mapping[str, Operation]) -> None:
    if not op.composes:
        return
    if op.calls or op.params_model is not None:
        raise ValueError(f"{op.id}: a composed operation has neither DSM calls nor parameters")
    for sub_id in op.composes:
        sub = earlier.get(sub_id)
        if sub is None:
            raise ValueError(f"{op.id}: read missing or placed after it: {sub_id}")
        if sub.composes or sub.kind != "read" or sub.params_model is not None:
            raise ValueError(f"{op.id}: {sub_id} must be a simple read, without parameters")
