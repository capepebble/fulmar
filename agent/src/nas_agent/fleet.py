"""Plusieurs NAS dans le moteur (conception 2026-11-26-parc-du-moteur).

Le hub suit d'autres NAS en joignant lui-même leur DSM, sans rien installer sur eux. Chaque NAS
ajouté est un agent complet dans le même processus : son dossier `data/nas/<id>/`
(configuration, identifiants, jetons et journal, historique, clés du relais), son relevé, ses
alertes, son serveur MCP ; il est servi sous `/nas/<id>/`. Le NAS du hub reste à la racine.

La console lit la liste des NAS ajoutés (`fleet.json`) et leurs jetons (`nas/<id>`) dans le
volume qu'elle partage avec l'agent, sans l'appeler.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import shutil
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from fastapi import FastAPI, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.routing import BaseRoute, Match, Mount, NoMatchFound, get_route_path
from starlette.types import Receive, Scope, Send

from nas_agent.audit import AuditLog
from nas_agent.auth import Authenticator, client_ip
from nas_agent.config import Settings, load_settings
from nas_agent.dsm.credentials import save_credentials
from nas_agent.engine import OpError
from nas_agent.enroll import render_config
from nas_agent.ratelimit import Lockout
from nas_agent.setup import (
    ENROLL_FAILURES,
    ENROLL_WINDOW_S,
    MEMBER_SCOPES,
    CertificateBody,
    EnrollBody,
    Enroller,
    enroll_dsm,
    ensure_console_token,
    is_enrolled,
    read_certificate,
    write_private,
)
from nas_agent.tokens import Principal
from nas_agent.updates import Refused

if TYPE_CHECKING:
    from nas_agent.app_factory import Runtime

log = logging.getLogger("nas_agent.fleet")

FLEET_DIR = "nas"
MANIFEST = "fleet.json"
_ID = re.compile(r"^[0-9a-f]{8}$")
_PREFIX = re.compile(rf"^/{FLEET_DIR}/([0-9a-f]{{8}})(?:/|$)")


@dataclass(frozen=True)
class Member:
    """Un NAS ajouté au hub ; l'empreinte sert à refuser un NAS déjà suivi."""

    id: str
    host: str
    port: int
    fingerprint: str
    added_at: str

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "host": self.host, "port": self.port, "added_at": self.added_at}


def member_settings(hub: Settings, directory: Path, member_id: str) -> Settings:
    """Les réglages du hub, sauf DSM (propre au NAS) et le dossier ; pas de jeton de projet,
    pas de parc : ceux-là restent au NAS du hub."""
    own = load_settings(directory / "config.toml", {})
    return replace(
        hub,
        dsm=own.dsm,
        data_dir=directory,
        console_token_file=None,
        relay=replace(
            hub.relay,
            direct_urls=[f"{u.rstrip('/')}/{FLEET_DIR}/{member_id}" for u in hub.direct_urls],
        ),
    )


BuildRuntime = Callable[[Settings], "Runtime"]


class Fleet:
    """Les NAS ajoutés au hub : lus au démarrage, ajoutés et retirés sans redémarrer l'agent."""

    def __init__(
        self,
        hub: Settings,
        audit: AuditLog,
        build: BuildRuntime,
        enroller: Enroller | None = None,
    ):
        if hub.console_token_file is None:
            raise ValueError("The fleet lives in the engine's project only.")
        self.hub = hub
        self.audit = audit
        self.build = build
        self.enroller = enroller or Enroller()
        self.root = hub.data_dir / FLEET_DIR
        self.shared = hub.console_token_file.parent
        self.members: dict[str, Member] = {}
        self.attempts = Lockout(ENROLL_FAILURES, ENROLL_WINDOW_S, ENROLL_WINDOW_S)
        self._runtimes: dict[str, Runtime] = {}
        self._mounts: dict[str, Mount] = {}
        self._tasks: dict[str, tuple[asyncio.Task[None], asyncio.Event]] = {}
        self._lock = asyncio.Lock()

    # Le disque

    def _dir(self, member_id: str) -> Path:
        return self.root / member_id

    def token_path(self, member_id: str) -> Path:
        return self.shared / FLEET_DIR / member_id

    def load(self) -> None:
        """Les NAS ajoutés, lus sur le disque. Un dossier incomplet est écarté et noté, jamais
        effacé : il peut garder des identifiants qu'on voudra retrouver."""
        if not self.root.is_dir():
            return
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir() or not _ID.match(directory.name):
                continue
            try:
                raw = json.loads((directory / "nas.json").read_text())
                member = Member(
                    id=directory.name,
                    host=str(raw["host"]),
                    port=int(raw["port"]),
                    fingerprint=str(raw["fingerprint"]),
                    added_at=str(raw["added_at"]),
                )
                if not is_enrolled(directory):
                    raise ValueError("not enrolled")
            except (OSError, ValueError, KeyError, TypeError) as exc:
                log.warning("Fleet: %s skipped (%s).", directory.name, type(exc).__name__)
                continue
            self.members[member.id] = member

    def write_manifest(self) -> None:
        """`fleet.json` pour la console, et plus aucun jeton d'un NAS retiré."""
        listed = sorted(self.members.values(), key=lambda m: (m.added_at, m.id))
        text = json.dumps({"nas": [m.public() for m in listed]}, indent=2) + "\n"
        write_private(self.shared / MANIFEST, text)
        tokens = self.shared / FLEET_DIR
        if tokens.is_dir():
            for path in tokens.iterdir():
                if path.name not in self.members:
                    path.unlink(missing_ok=True)

    # La marche

    async def start(self) -> None:
        """Au démarrage du hub : chaque NAS ajouté démarre ; un NAS qui échoue reste dans la
        liste (la console le dit injoignable) sans empêcher les autres."""
        for member in list(self.members.values()):
            try:
                await self._start(member)
            except Exception as exc:
                log.error("Fleet: %s did not start (%s).", member.id, type(exc).__name__)
        self.write_manifest()

    async def stop(self) -> None:
        for member_id in list(self._tasks):
            await self._stop(member_id)

    def running(self, member_id: str) -> bool:
        return member_id in self._runtimes

    async def _start(self, member: Member) -> None:
        runtime = self.build(member_settings(self.hub, self._dir(member.id), member.id))
        try:
            ensure_console_token(
                runtime.tokens,
                self.token_path(member.id),
                self.hub.console_cidrs,
                MEMBER_SCOPES,
            )
        except BaseException:
            runtime.close()
            raise
        # Chaque NAS vit dans sa propre tâche : son serveur MCP tient des portées d'annulation
        # (anyio) qui doivent s'ouvrir et se fermer dans la même tâche, alors qu'un ajout naît
        # dans la tâche d'une requête et l'arrêt dans celle du hub.
        ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        stop = asyncio.Event()
        task = asyncio.create_task(_serve(runtime, ready, stop), name=f"fleet-{member.id}")
        await ready
        self._runtimes[member.id] = runtime
        self._tasks[member.id] = (task, stop)
        self._mounts[member.id] = Mount(f"/{FLEET_DIR}/{member.id}", app=runtime.app)

    async def _stop(self, member_id: str) -> None:
        self._mounts.pop(member_id, None)
        self._runtimes.pop(member_id, None)
        entry = self._tasks.pop(member_id, None)
        if entry is None:
            return
        task, stop = entry
        stop.set()
        try:
            await task
        except Exception as exc:
            log.error("Fleet: %s did not stop cleanly (%s).", member_id, type(exc).__name__)

    def mount_for(self, member_id: str) -> Mount | None:
        return self._mounts.get(member_id)

    def runtimes(self) -> dict[str, Runtime]:
        """Les NAS ajoutés qui tournent, par identifiant (mises à jour du parc)."""
        return dict(self._runtimes)

    # Ajouter, retirer

    def _new_id(self) -> str:
        while True:
            member_id = secrets.token_hex(4)
            if member_id not in self.members and not self._dir(member_id).exists():
                return member_id

    async def add(self, body: EnrollBody, principal: Principal, ip: str) -> tuple[Member, str]:
        """L'enrôlement de l'installation pour un autre NAS, puis il démarre ; rend le NAS et
        le mode TLS retenu."""
        op = "agent.fleet.add"

        def journal(outcome: str, code: str | None = None, dsm_code: int | None = None) -> None:
            self.audit.record(
                channel="rest",
                op=op,
                token_id=principal.token_id,
                client_ip=ip,
                outcome=outcome,  # type: ignore[arg-type]
                code=code,
                dsm_code=dsm_code,
                params={"host": body.host, "port": body.port, "username": body.username},
            )

        def check(fingerprint: str) -> None:
            known = {m.fingerprint for m in self.members.values()}
            if self.hub.dsm.tls_fingerprint:
                known.add(self.hub.dsm.tls_fingerprint)
            if fingerprint in known:
                journal("denied", "already_followed")
                raise OpError("already_followed", 409, "This hub already follows this NAS.")

        # Un ajout à la fois : le plafond et les doublons se vérifient sur une liste stable.
        async with self._lock:
            if len(self.members) >= self.hub.fleet_max:
                journal("denied", "fleet_full")
                raise OpError(
                    "fleet_full",
                    409,
                    f"This hub already follows {self.hub.fleet_max} NAS (NAS_AGENT_FLEET_MAX).",
                )
            done = await enroll_dsm(self.enroller, body, self.attempts, ip, journal, check)
            member = Member(
                id=self._new_id(),
                host=body.host,
                port=body.port,
                fingerprint=done.fingerprint,
                added_at=datetime.now(UTC).isoformat(timespec="seconds"),
            )
            directory = self._dir(member.id)
            try:
                directory.mkdir(parents=True, mode=0o700)
                save_credentials(directory / "secrets" / "dsm.json", done.creds)
                (directory / "config.toml").write_text(
                    render_config(done.dsm, self.hub.public_hosts)
                )
                write_private(
                    directory / "nas.json",
                    json.dumps(
                        {
                            "host": member.host,
                            "port": member.port,
                            "fingerprint": member.fingerprint,
                            "added_at": member.added_at,
                        }
                    )
                    + "\n",
                )
                await self._start(member)
            except Exception as exc:
                shutil.rmtree(directory, ignore_errors=True)
                self.token_path(member.id).unlink(missing_ok=True)
                log.error("Fleet: %s could not start (%s).", member.id, type(exc).__name__)
                journal("error", "internal")
                raise OpError("internal", 500, "The NAS could not be started.") from exc
            self.members[member.id] = member
            self.write_manifest()
        journal("ok")
        return member, done.mode

    async def remove(self, member_id: str, principal: Principal, ip: str) -> None:
        """Arrête le NAS, puis efface tout ce que le hub en gardait."""
        async with self._lock:
            member = self.members.get(member_id) if _ID.match(member_id) else None
            if member is None:
                raise OpError("not_found", 404, "This hub does not follow this NAS.")
            await self._stop(member_id)
            del self.members[member_id]
            shutil.rmtree(self._dir(member_id), ignore_errors=True)
            self.token_path(member_id).unlink(missing_ok=True)
            self.write_manifest()
        self.audit.record(
            channel="rest",
            op="agent.fleet.remove",
            token_id=principal.token_id,
            client_ip=ip,
            outcome="ok",
            params={"id": member_id, "host": member.host, "port": member.port},
        )


async def _serve(runtime: Runtime, ready: asyncio.Future[None], stop: asyncio.Event) -> None:
    """La vie d'un NAS ajouté : son application démarre, sert jusqu'à l'arrêt, puis ses bases
    se ferment. Un démarrage raté passe par `ready`."""
    try:
        async with runtime.app.router.lifespan_context(runtime.app):
            ready.set_result(None)
            await stop.wait()
    except asyncio.CancelledError:
        if not ready.done():
            ready.cancel()
        raise
    except Exception as exc:
        if ready.done():
            raise
        ready.set_exception(exc)
    finally:
        runtime.close()


class MemberRoute(BaseRoute):
    """`/nas/<id>/…` vers l'application du NAS ajouté ; le reste au NAS du hub."""

    def __init__(self, fleet: Fleet):
        self.fleet = fleet

    def matches(self, scope: Scope) -> tuple[Match, Scope]:
        if scope["type"] not in ("http", "websocket"):
            return Match.NONE, {}
        found = _PREFIX.match(get_route_path(scope))
        mount = self.fleet.mount_for(found.group(1)) if found else None
        if mount is None:
            return Match.NONE, {}
        return mount.matches(scope)

    async def handle(self, scope: Scope, receive: Receive, send: Send) -> None:
        await scope["endpoint"](scope, receive, send)

    def url_path_for(self, name: str, /, **path_params: Any) -> Any:
        raise NoMatchFound(name, path_params)


def add_fleet_routes(
    app: FastAPI, fleet: Fleet, authenticator: Authenticator, trusted: list[str]
) -> None:
    """L'API du parc, avec le droit `fleet:manage` (jeton de la console du projet)."""

    def manager(request: Request, op: str) -> tuple[Principal, str]:
        peer = request.client.host if request.client else None
        ip = client_ip(peer, request.headers, trusted)
        principal = authenticator.authenticate(request.headers.get("authorization"), ip, "rest", op)
        if "fleet:manage" not in principal.scopes:
            raise OpError("forbidden", 403, "This token may not manage the hub's fleet.")
        return principal, ip

    @app.get("/v1/fleet", include_in_schema=False)
    async def list_fleet(request: Request) -> dict[str, Any]:
        manager(request, "agent.fleet")
        members = sorted(fleet.members.values(), key=lambda m: (m.added_at, m.id))
        return {
            "nas": [{**m.public(), "running": fleet.running(m.id)} for m in members],
            "max": fleet.hub.fleet_max,
        }

    @app.post("/v1/fleet/certificate", include_in_schema=False)
    async def certificate(request: Request, body: CertificateBody) -> dict[str, Any]:
        manager(request, "agent.fleet.certificate")
        return await read_certificate(fleet.enroller, body)

    @app.post("/v1/fleet", status_code=201, include_in_schema=False)
    async def add(request: Request, body: EnrollBody) -> dict[str, Any]:
        principal, ip = manager(request, "agent.fleet.add")
        member, mode = await fleet.add(body, principal, ip)
        return {"nas": member.public(), "tls_mode": mode}

    @app.delete("/v1/fleet/{member_id}", status_code=204, include_in_schema=False)
    async def remove(request: Request, member_id: str) -> Response:
        principal, ip = manager(request, "agent.fleet.remove")
        await fleet.remove(member_id, principal, ip)
        return Response(status_code=204)


# Les mises à jour du parc (conception 2026-11-26-groupes-protections-parc, section 3)

_NAS_KEY = re.compile(r"^(hub|[0-9a-f]{8})$")


class RolloutBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: Literal["packages", "dsm"]
    nas: list[str] = Field(min_length=1, max_length=501)
    at: datetime | None = Field(
        None, description="When, ISO 8601 with a time zone; now if left out."
    )
    accept_warnings: bool = False

    @field_validator("nas")
    @classmethod
    def _keys(cls, value: list[str]) -> list[str]:
        if not all(_NAS_KEY.match(v) for v in value):
            raise ValueError('nas: "hub" or the identifiers of added NAS.')
        return value

    @field_validator("at")
    @classmethod
    def _zone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("at: give the time zone.")
        return value


def rollout_public(r: Any) -> dict[str, Any]:
    """Un déroulé, sans le jeton qui l'a lancé."""
    data = asdict(r)
    data.pop("by", None)
    for s in data["steps"]:
        s.pop("waiting_since", None)
    return data


def add_rollout_routes(
    app: FastAPI, rollouts: Any, authenticator: Authenticator, trusted: list[str]
) -> None:
    """Droits `fleet:manage` et `packages:update`, plus `dsm:update` pour DSM."""

    def manager(request: Request, op: str, target: str | None = None) -> Principal:
        peer = request.client.host if request.client else None
        ip = client_ip(peer, request.headers, trusted)
        principal = authenticator.authenticate(request.headers.get("authorization"), ip, "rest", op)
        needed = {"fleet:manage", "packages:update"} | (
            {"dsm:update"} if target == "dsm" else set()
        )
        if not needed <= principal.scopes:
            raise OpError("forbidden", 403, "This token may not update the fleet.")
        return principal

    @app.get("/v1/fleet/rollouts", include_in_schema=False)
    async def list_rollouts(request: Request) -> dict[str, Any]:
        manager(request, "fleet.rollouts")
        return {
            "rollouts": [rollout_public(r) for r in rollouts.list()],
            "running": rollouts.active is not None,
        }

    @app.post("/v1/fleet/rollouts", status_code=201, include_in_schema=False)
    async def plan(request: Request, body: RolloutBody) -> dict[str, Any]:
        principal = manager(request, "fleet.rollout.plan", body.target)
        try:
            r = rollouts.create(
                body.target, body.nas, body.at, body.accept_warnings, principal.token_id
            )
        except Refused as exc:
            status = 422 if exc.code in ("invalid_time", "unknown_nas", "no_nas") else 409
            raise OpError(exc.code, status, exc.reason) from None
        await rollouts.advance()
        return {"rollout": rollout_public(r)}

    @app.post("/v1/fleet/rollouts/{rollout_id}/cancel", include_in_schema=False)
    async def cancel(request: Request, rollout_id: str) -> dict[str, Any]:
        manager(request, "fleet.rollout.cancel")
        return {"cancelled": bool(_ID.match(rollout_id)) and rollouts.cancel(rollout_id)}
