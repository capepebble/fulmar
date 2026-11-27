"""Assemblage de l'agent : base, jetons, journal, passerelle DSM, moteur, REST et MCP."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from nas_agent import relay as relay_module
from nas_agent.access import AccessSources, Control, Detacher
from nas_agent.access_guard import AccessGuard
from nas_agent.api import create_app
from nas_agent.audit import AuditLog
from nas_agent.auth import Authenticator
from nas_agent.catalog.ops import build_catalog
from nas_agent.catalog.ops.updates import prepare as prepare_update
from nas_agent.config import Settings
from nas_agent.db import open_db
from nas_agent.dsm.credentials import load_credentials, save_credentials
from nas_agent.dsm.gateway import DsmCaller, DsmGateway, DsmUnsupported
from nas_agent.engine import Engine
from nas_agent.fleet import Fleet, MemberRoute, add_fleet_routes, add_rollout_routes
from nas_agent.history import HistoryStore
from nas_agent.mcp_server import McpEndpoint
from nas_agent.notify.service import NotifyService, build_channels
from nas_agent.protections import ProtectionStore
from nas_agent.ratelimit import Lockout
from nas_agent.relay.client import Transport
from nas_agent.relay.state import StateCache, build_state
from nas_agent.relay.store import RelayStore
from nas_agent.rollout import HUB, RolloutService, Target, rollout_allows
from nas_agent.sampler import Sampler
from nas_agent.setup import Enroller, add_setup_status, ensure_console_token
from nas_agent.synology import SynologyFeed
from nas_agent.tokens import TokenStore
from nas_agent.updates import UpdateService, token_allows
from nas_agent.verdicts import VerdictLog

if TYPE_CHECKING:
    from nas_agent.relay.service import RelayService

log = logging.getLogger(__name__)


@dataclass
class Runtime:
    app: FastAPI
    engine: Engine
    tokens: TokenStore
    audit: AuditLog
    history: HistoryStore | None
    # Absent du moteur publié sans le chiffrement du relais (`relay.available()`).
    relay: RelayService | None
    notify: NotifyService | None = None
    conn: sqlite3.Connection | None = None
    fleet: Fleet | None = None
    control: Control = field(default_factory=Control)
    # Pour les mises à jour du parc : le DSM de ce NAS et ses protections.
    dsm: DsmCaller | None = None
    protections: ProtectionStore | None = None
    prepare: Any = None

    def close(self) -> None:
        """Les bases fermées, une fois l'application arrêtée (NAS retiré du hub)."""
        if self.history is not None:
            self.history.close()
        if self.conn is not None:
            self.conn.close()


class FixtureDsm:
    """Développement seulement : rend des réponses enregistrées au lieu d'appeler DSM.

    Le dossier contient un fichier « <api>.<method>.json » par appel, ou un index.json qui
    associe « api.method » à un nom de fichier. Une entrée « api.method[logtype=…] » passe
    avant : les journaux de DSM partagent un même appel, que seul `logtype` distingue.
    """

    def __init__(self, directory: Path):
        self._dir = directory
        index = directory / "index.json"
        self._index: Mapping[str, str] = json.loads(index.read_text()) if index.exists() else {}

    async def call(
        self,
        api: str,
        method: str,
        *,
        max_version: int,
        min_version: int = 1,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        key = f"{api}.{method}"
        logtype = (params or {}).get("logtype")
        name = self._index.get(f"{key}[logtype={logtype}]") if logtype else None
        path = self._dir / (name or self._index.get(key, f"{key}.json"))
        if not path.exists():
            raise DsmUnsupported(api)
        data = json.loads(path.read_text())
        return {k: v for k, v in data.items() if not k.startswith("_")}


def build_runtime(
    settings: Settings,
    *,
    fixtures: Path | None = None,
    relay_transport: Transport | None = None,
    enroller: Enroller | None = None,
    member_fixtures: Path | None = None,
    synology: SynologyFeed | None = None,
) -> Runtime:
    """L'agent assemblé. `fixtures` remplace le DSM de ce NAS par des réponses enregistrées
    (développement) ; les NAS ajoutés au hub joignent leur vrai DSM, sauf `member_fixtures`
    (tests)."""
    conn = open_db(settings.db_path)
    audit, tokens = AuditLog(conn), TokenStore(conn)
    catalog = build_catalog()
    if settings.console_token_file is not None:
        # Projet du moteur : la console lit son jeton dans un volume partagé.
        ensure_console_token(tokens, settings.console_token_file, settings.console_cidrs)

    control = Control()
    gateway: DsmGateway | None = None
    dsm: DsmCaller
    service_account: str | None = None
    if fixtures is not None:
        dsm = FixtureDsm(fixtures)
    else:
        path = settings.credentials_path
        creds = load_credentials(path)
        service_account = creds.username

        def remember(token: str) -> None:
            # Détaché : les identifiants sont effacés, un jeton d'appareil tardif ne les récrit pas.
            if not control.detached:
                save_credentials(path, replace(creds, device_token=token))

        gateway = DsmGateway(
            settings.dsm,
            creds,
            concurrency=settings.limits.dsm_concurrency,
            on_device_token=remember,
        )
        dsm = gateway

    history = HistoryStore(settings.history_path) if settings.history.enabled else None
    engine = Engine(catalog, dsm, audit, settings, service_account=service_account, history=history)
    authenticator = Authenticator(tokens, audit, settings.limits)
    mcp = McpEndpoint(engine, catalog, authenticator, settings)
    sampler = Sampler(engine, history, audit) if history is not None else None
    # L'état des téléphones et des alertes du moteur, gardé 30 secondes : un seul jeu de lectures
    # DSM pour les deux.
    state = StateCache(
        lambda: build_state(
            engine,
            unreachable_minutes=settings.audit.unreachable_minutes,
            lang=settings.language,  # type: ignore[arg-type]
        )
    )
    # Le relais (téléphones) n'est là qu'avec PyNaCl et son code : le moteur publié avant le
    # classement « grand public » de l'ANSSI n'a ni l'un ni l'autre.
    relay: RelayService | None = None
    if relay_module.available():
        from nas_agent.relay.service import RelayService

        relay = RelayService(
            settings, RelayStore(conn), audit, state.get, engine=engine, transport=relay_transport
        )
    elif settings.relay.url is not None:
        log.warning("This engine has no relay module: the relay address is ignored.")
    engine.relay = relay
    # Les pages de Synology (conception 2026-11-26-failles-fin-de-vie) : un lecteur pour le
    # processus, créé par le NAS du hub, prêté aux NAS ajoutés, qui ne le relancent pas.
    feed = synology
    if feed is None and settings.synology.enabled:
        feed = SynologyFeed(settings.data_dir / "synology")
    engine.synology = feed
    # Mises à jour des paquets : sur le DSM de ce NAS, puis les réponses gardées oubliées.
    # L'état des travaux et des rendez-vous survit au redémarrage du NAS (mise à jour de DSM).
    updates = UpdateService(
        dsm,
        audit,
        path=settings.data_dir / "updates.json",
        on_done=lambda: engine.invalidate("SYNO.Core."),
        # Un rendez-vous ne part que si le jeton qui l'a posé vaut encore, avec ses droits.
        authorize=lambda token_id, target: token_allows(
            tokens, token_id, target, datetime.now(UTC)
        ),
    )
    engine.updates = updates
    # Ce que Fulmar ne met jamais à jour sur ce NAS (conception 2026-11-26-groupes-protections-
    # parc, section 2) : appliqué à chaque mise à jour, rendez-vous et parc compris.
    protections = ProtectionStore(settings.data_dir / "protections.json")
    engine.protections = protections
    # Le journal des verdicts, pour le bilan du mois (conception 2026-11-26-bilan-du-mois).
    verdicts = VerdictLog(conn)
    engine.verdicts = verdicts

    async def prepare_held(caller, schedule):
        return await prepare_update(caller, schedule, protections.get())

    # Le gardien des accès (conception 2026-11-26-fermer-acces) : SSH et Telnet lus chaque
    # minute, fermés à l'échéance si la règle le veut ; jamais ouverts.
    guard = AccessGuard(
        dsm,
        audit,
        path=settings.data_dir / "access.json",
        on_closed=lambda: engine.invalidate("SYNO.Core.Terminal"),
    )
    engine.guard = guard
    # Les alertes du moteur (conception, 4.11) : sur l'état partagé avec le relais, gardé 30
    # secondes. Un secret illisible arrête le démarrage.
    notify = None
    if settings.notify.configured:
        notify = NotifyService(
            RelayStore(conn),
            audit,
            state.get,
            build_channels(settings),
            lang=settings.language,  # type: ignore[arg-type]
        )

    # Le parc du hub (conception 2026-11-26) : dans le projet du moteur seulement. Un NAS ajouté
    # se construit comme celui-ci, sans jeton de projet, donc sans parc à lui.
    fleet: Fleet | None = None
    if settings.console_token_file is not None:
        fleet = Fleet(
            settings,
            audit,
            lambda member: build_runtime(
                member,
                fixtures=member_fixtures,
                relay_transport=relay_transport,
                synology=feed,
            ),
            enroller=enroller,
        )
        fleet.load()

    # Les mises à jour du parc (conception 2026-11-26-groupes-protections-parc, section 3) : le
    # hub mène, un NAS après l'autre, lui-même en dernier.
    rollouts: RolloutService | None = None
    if fleet is not None:
        hub_fleet = fleet

        def targets() -> dict[str, Target]:
            out = {HUB: Target(updates=updates, dsm=dsm, prepare=prepare_held)}
            for member_id, rt in hub_fleet.runtimes().items():
                out[member_id] = Target(updates=rt.engine.updates, dsm=rt.dsm, prepare=rt.prepare)
            return out

        rollouts = RolloutService(
            targets,
            audit,
            path=settings.data_dir / "rollouts.json",
            authorize=lambda token_id, target: rollout_allows(
                tokens, token_id, target, datetime.now(UTC)
            ),
        )

    # Carte sur table (conception 2026-11-26) : le détachement n'est offert qu'au NAS du moteur,
    # qui revient alors en attente d'installation ; un NAS ajouté se retire du parc.
    engine.access = AccessSources(
        tokens=tokens,
        fleet_size=lambda: len(fleet.members) if fleet is not None else None,
        detach=Detacher(
            credentials=settings.credentials_path,
            tokens=tokens,
            relay=relay,
            updates=updates,
            control=control,
        )
        if fleet is not None
        else None,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Le relevé et le module relay vivent avec l'application : lancés au démarrage,
        # arrêtés avant la passerelle. Les NAS ajoutés démarrent après, s'arrêtent avant.
        tasks = [asyncio.create_task(relay.run())] if relay is not None else []
        if sampler is not None:
            tasks.append(asyncio.create_task(sampler.run()))
        if notify is not None:
            tasks.append(asyncio.create_task(notify.run()))
        if synology is None and feed is not None:
            tasks.append(asyncio.create_task(feed.run()))
        tasks.append(asyncio.create_task(updates.run(prepare_held)))
        tasks.append(asyncio.create_task(guard.run()))
        tasks.append(asyncio.create_task(verdicts.run(engine)))
        if rollouts is not None:
            tasks.append(asyncio.create_task(rollouts.run()))
        try:
            async with mcp.run():
                if fleet is not None:
                    await fleet.start()
                try:
                    yield
                finally:
                    if fleet is not None:
                        await fleet.stop()
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with suppress(asyncio.CancelledError):
                    await task
            if gateway is not None:
                await gateway.close()

    app = create_app(settings, engine, catalog, authenticator, mcp_app=mcp, lifespan=lifespan)
    limits = settings.limits
    lockout = Lockout(limits.auth_failures, limits.auth_window_s, limits.lockout_s)
    if relay is not None:
        from nas_agent.relay.direct import add_direct_routes

        add_direct_routes(app, relay, settings, audit, lockout)
    if settings.console_token_file is not None:
        add_setup_status(app, authenticator, settings.trusted_proxies)
    if fleet is not None:
        add_fleet_routes(app, fleet, authenticator, settings.trusted_proxies)
        add_rollout_routes(app, rollouts, authenticator, settings.trusted_proxies)
        # Avant toute autre route : /nas/<id>/… appartient au NAS ajouté.
        app.router.routes.insert(0, MemberRoute(fleet))
    return Runtime(
        app=app,
        engine=engine,
        tokens=tokens,
        audit=audit,
        history=history,
        relay=relay,
        notify=notify,
        conn=conn,
        fleet=fleet,
        control=control,
        dsm=dsm,
        protections=protections,
        prepare=prepare_held,
    )
