"""Ce que lisent agent.access et ce que défait agent.detach (conception 2026-11-26-carte-sur-table).

`Control` relie l'agent assemblé à son serveur : `nas-agent serve` y pose de quoi l'arrêter, et
l'agent détaché revient en attente d'installation au lieu de s'éteindre.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nas_agent.catalog.model import OpRefused

if TYPE_CHECKING:
    from nas_agent.relay.service import RelayService
    from nas_agent.tokens import TokenStore
    from nas_agent.updates import UpdateService


@dataclass
class Control:
    # Arrête le serveur de l'agent (posé par `nas-agent serve`) ; None : rien à arrêter.
    stop: Callable[[], None] | None = None
    # Détaché : les identifiants de DSM sont effacés, l'agent revient en attente.
    detached: bool = False


@dataclass(frozen=True)
class AccessSources:
    tokens: TokenStore
    # Les NAS ajoutés au hub ; None hors du projet du moteur.
    fleet_size: Callable[[], int | None]
    # Le détachement ; None là où il n'est pas offert (NAS ajouté, agent seul).
    detach: Callable[[str], dict[str, Any]] | None = None


class Detacher:
    """Détache le NAS du moteur : téléphones retirés, jetons révoqués sauf celui de l'appelant,
    rendez-vous de mise à jour annulés, identifiants de DSM effacés, puis l'agent s'arrête."""

    def __init__(
        self,
        *,
        credentials: Path,
        tokens: TokenStore,
        relay: RelayService | None,
        updates: UpdateService | None,
        control: Control,
    ):
        self._credentials = credentials
        self._tokens = tokens
        self._relay = relay
        self._updates = updates
        self._control = control

    def __call__(self, keep_token: str) -> dict[str, Any]:
        if self._updates is not None and self._updates.busy:
            raise OpRefused(
                "update_running", 409, "An update is running on this NAS: wait for its end."
            )
        relay = self._relay
        phones = (
            sum(relay.revoke(d.id, channel="internal", op="relay.revoke") for d in relay.devices())
            if relay is not None
            else 0
        )
        revoked = sum(
            self._tokens.revoke(t.id)
            for t in self._tokens.list()
            if t.revoked_at is None and t.id != keep_token
        )
        if self._updates is not None:
            self._updates.cancel_waiting("the NAS was detached from Fulmar")
        # D'abord le drapeau : un jeton d'appareil rendu par DSM d'ici l'arrêt n'est plus gardé.
        self._control.detached = True
        removed = self._credentials.exists()
        self._credentials.unlink(missing_ok=True)
        stop = self._control.stop
        if stop is not None:
            # La réponse part, puis le serveur s'arrête (sa session DSM se ferme à l'arrêt).
            stop()
        return {
            "phones_removed": phones,
            "tokens_revoked": revoked,
            "credentials_removed": removed,
            "restarting": stop is not None,
        }
