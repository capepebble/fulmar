"""Le moteur installable (conception 2026-11-25) : jeton de la console, attente, enrôlement.

Dans le projet Compose du moteur, l'agent crée seul le jeton de la console et l'écrit dans un
volume qu'elle lit ; avant d'être relié à DSM, il démarre en attente et se laisse enrôler par
la console, avec ce jeton. La ligne de commande (`nas-agent enroll`) reste le moyen de
ré-enrôler un agent déjà relié.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from synology_dsm.exceptions import (
    SynologyDSMException,
    SynologyDSMLogin2SARequiredException,
    SynologyDSMLoginFailedException,
)

from nas_agent.api import problem
from nas_agent.audit import AuditLog
from nas_agent.auth import Authenticator
from nas_agent.config import (
    DEFAULT_DATA_DIR,
    ConfigError,
    DsmSettings,
    Limits,
    normalize_fingerprint,
)
from nas_agent.dsm.credentials import DsmCredentials, save_credentials
from nas_agent.dsm.gateway import _code, default_client_factory
from nas_agent.dsm.tls import build_session
from nas_agent.engine import OpError
from nas_agent.enroll import (
    LOGIN_REASONS,
    certificate_verifies,
    choose_tls_mode,
    default_gateway,
    fetch_certificate,
    render_config,
)
from nas_agent.ratelimit import Lockout
from nas_agent.tokens import Principal, TokenStore

# Les droits de la console (lecture, contrôles, téléphones) et l'enrôlement.
CONSOLE_SCOPES: frozenset[str] = frozenset(
    {
        "system:read",
        "storage:read",
        "backup:read",
        "security:read",
        "personal:read",
        "audit:checks",
        "devices:pair",
        # La page « Mises à jour » de la console : l'administrateur, derrière son mot de passe.
        "packages:update",
        "dsm:update",
        "access:close",
        "agent:setup",
        "fleet:manage",
    }
)
# Le jeton de la console pour un NAS ajouté au hub (conception 2026-11-26) : la lecture et les
# téléphones de ce NAS, sans l'enrôlement ni le parc, qui restent au NAS du hub.
MEMBER_SCOPES: frozenset[str] = CONSOLE_SCOPES - {"agent:setup", "fleet:manage"}
CONSOLE_LABEL = "console-projet"
# Dix ans : le jeton vit avec le projet ; révoqué ou perdu, il est remplacé au démarrage.
CONSOLE_TTL_DAYS = 3650

# DSM bloque l'adresse après dix échecs en cinq minutes : trois essais, puis on attend.
ENROLL_FAILURES = 3
ENROLL_WINDOW_S = 300.0

_TRUE = {"1", "true", "yes", "oui"}
_LOOPBACK_HOSTS = ["127.0.0.1", "127.0.0.2", "localhost", "[::1]"]


class OtpRequired(Exception):
    "DSM asks for the two-factor authentication code."


# Réglages du mode d'attente


@dataclass(frozen=True)
class SetupSettings:
    data_dir: Path
    console_token_file: Path
    console_cidrs: list[str]
    bind_host: str = "127.0.0.1"
    bind_port: int = 8765
    public_hosts: list[str] = field(default_factory=list)
    limits: Limits = field(default_factory=Limits)


def _list(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def load_setup_settings(env: Mapping[str, str]) -> SetupSettings | None:
    """Les réglages du projet, lus dans l'environnement ; None hors du projet du moteur."""
    token_file = env.get("NAS_AGENT_CONSOLE_TOKEN_FILE")
    if not token_file:
        return None
    cidrs = _list(env.get("NAS_AGENT_CONSOLE_CIDR"))
    for cidr in cidrs:
        try:
            ipaddress.ip_network(cidr, strict=False)
        except ValueError as exc:
            raise ConfigError(f"NAS_AGENT_CONSOLE_CIDR : plage invalide : {cidr}") from exc
    bind_host = env.get("NAS_AGENT_BIND_HOST", "127.0.0.1")
    allow = env.get("NAS_AGENT_ALLOW_NON_LOOPBACK", "").strip().lower() in _TRUE
    if not _is_loopback(bind_host) and not allow:
        raise ConfigError(
            f"The agent must listen on 127.0.0.1; {bind_host} requires "
            "NAS_AGENT_ALLOW_NON_LOOPBACK=1."
        )
    return SetupSettings(
        data_dir=Path(env.get("NAS_AGENT_DATA_DIR") or DEFAULT_DATA_DIR),
        console_token_file=Path(token_file),
        console_cidrs=cidrs,
        bind_host=bind_host,
        bind_port=int(env.get("NAS_AGENT_BIND_PORT", "8765")),
        public_hosts=_list(env.get("NAS_AGENT_PUBLIC_HOSTS")),
    )


def is_enrolled(data_dir: Path) -> bool:
    """Relié à DSM : ses identifiants et sa configuration sont écrits."""
    return (data_dir / "secrets" / "dsm.json").exists() and (data_dir / "config.toml").exists()


# Le jeton de la console


def _probe_ip(cidrs: list[str]) -> str:
    """Une adresse du réseau du projet, pour éprouver le jeton comme la console le présentera."""
    for cidr in cidrs:
        net = ipaddress.ip_network(cidr, strict=False)
        return str(next(iter(net.hosts()), net.network_address))
    return "127.0.0.1"


def write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def ensure_console_token(
    tokens: TokenStore,
    path: Path,
    cidrs: list[str],
    scopes: frozenset[str] = CONSOLE_SCOPES,
) -> bool:
    """Le fichier porte un jeton valide de la console ; sinon, en crée un. Vrai s'il est neuf.

    Un jeton aux droits d'une version précédente est remplacé : ajouter un droit à la console
    lui parvient au démarrage suivant.
    """
    raw = path.read_text().strip() if path.exists() else ""
    principal = tokens.authenticate(raw, _probe_ip(cidrs)) if raw else None
    if principal is not None and principal.label == CONSOLE_LABEL and principal.scopes == scopes:
        return False
    # Un seul jeton de projet à la fois : celui d'un fichier perdu ne doit plus rien ouvrir.
    for info in tokens.list():
        if info.label == CONSOLE_LABEL and info.revoked_at is None:
            tokens.revoke(info.id)
    _info, new = tokens.create(CONSOLE_LABEL, scopes, ttl_days=CONSOLE_TTL_DAYS, cidrs=cidrs)
    write_private(path, new + "\n")
    return True


# L'enrôlement


async def login_with_otp(dsm: DsmSettings, creds: DsmCredentials, otp: str | None) -> str | None:
    """Une connexion à DSM, avec le code s'il est donné ; rend le jeton d'appareil."""
    session = build_session(dsm)
    try:
        client = default_client_factory(session, dsm, creds)
        try:
            if otp:
                await client.login(otp)
            else:
                await client.login()
        except SynologyDSMLogin2SARequiredException:
            raise OtpRequired() from None
        token = client.device_token
        await client.logout()
        return token
    finally:
        await session.close()


Login = Callable[[DsmSettings, DsmCredentials, str | None], Awaitable[str | None]]


@dataclass
class Enroller:
    fetch: Callable[[str, int], tuple[str, str]] = fetch_certificate
    verifies: Callable[[str, int, str], bool] = certificate_verifies
    login: Login = login_with_otp
    gateway: Callable[[], str] = default_gateway


# L'adresse et le nom du certificat sont écrits dans la configuration de l'agent : rien que
# les caractères d'un nom d'hôte ou d'une adresse IP (v6 entre crochets).
HOST_PATTERN = r"^[A-Za-z0-9.:\[\]-]+$"


class CertificateBody(BaseModel):
    host: str = Field(min_length=1, max_length=253, pattern=HOST_PATTERN)
    port: int = Field(5001, ge=1, le=65535)
    server_name: str | None = Field(None, max_length=253, pattern=HOST_PATTERN)

    @field_validator("server_name", mode="before")
    @classmethod
    def _empty_name(cls, value: object) -> object:
        return None if value == "" else value


class EnrollBody(CertificateBody):
    fingerprint: str = Field(min_length=64, max_length=95)
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=512)
    otp: str | None = Field(None, max_length=16)


async def read_certificate(enroller: Enroller, body: CertificateBody) -> dict[str, Any]:
    """L'empreinte du certificat que présente DSM, et s'il se vérifie pour le nom donné."""
    try:
        _pem, fingerprint = await asyncio.to_thread(enroller.fetch, body.host, body.port)
        verifies = bool(body.server_name) and await asyncio.to_thread(
            enroller.verifies, body.host, body.port, body.server_name or ""
        )
    except OSError as exc:
        raise OpError(
            "dsm_unreachable",
            502,
            f"DSM does not answer over HTTPS at {body.host}:{body.port}.",
        ) from exc
    return {"fingerprint": fingerprint, "verifies": verifies}


@dataclass(frozen=True)
class Enrolled:
    """DSM joint et le compte admis : de quoi écrire la configuration et les identifiants."""

    dsm: DsmSettings
    creds: DsmCredentials
    fingerprint: str
    mode: str


Journal = Callable[..., None]


async def enroll_dsm(
    enroller: Enroller,
    body: EnrollBody,
    attempts: Lockout,
    ip: str,
    journal: Journal,
    check: Callable[[str], None] | None = None,
) -> Enrolled:
    """L'enrôlement, de l'installation comme de l'ajout d'un NAS au hub : l'empreinte relue et
    comparée à celle confirmée, le mode TLS, puis la connexion à DSM. `check` reçoit l'empreinte
    avant la connexion et peut refuser (NAS déjà suivi). Lève OpError, avec le refus noté."""
    if attempts.is_locked(ip):
        raise OpError(
            "rate_limited", 429, "Too many attempts: wait five minutes before trying again."
        )
    try:
        confirmed = normalize_fingerprint(body.fingerprint)
    except ConfigError as exc:
        raise OpError("invalid_request", 400, "Invalid certificate fingerprint.") from exc
    try:
        _pem, fingerprint = await asyncio.to_thread(enroller.fetch, body.host, body.port)
        verifies = bool(body.server_name) and await asyncio.to_thread(
            enroller.verifies, body.host, body.port, body.server_name or ""
        )
    except OSError as exc:
        journal("error", "dsm_unreachable")
        raise OpError(
            "dsm_unreachable",
            502,
            f"DSM does not answer over HTTPS at {body.host}:{body.port}.",
        ) from exc
    if fingerprint != confirmed:
        journal("denied", "certificate_changed")
        raise OpError(
            "certificate_changed",
            409,
            "DSM's certificate changed since it was confirmed: read it and confirm it again.",
        )
    if check is not None:
        check(fingerprint)
    mode, server_name, pinned = choose_tls_mode(fingerprint, body.server_name, verifies)
    dsm = DsmSettings(
        host=body.host,
        port=body.port,
        tls_mode=mode,
        tls_server_name=server_name,
        tls_fingerprint=pinned,
    )
    creds = DsmCredentials(body.username, body.password)
    try:
        device_token = await enroller.login(dsm, creds, body.otp)
    except OtpRequired:
        journal("denied", "otp_required")
        raise OpError(
            "otp_required", 400, "DSM asks for the two-factor authentication code."
        ) from None
    except SynologyDSMLoginFailedException as exc:
        code = _code(exc)
        attempts.failure(ip)
        journal("denied", "login_failed", code)
        reason = LOGIN_REASONS.get(code, "refused for no known reason")
        raise OpError("login_failed", 400, f"DSM refused the sign-in: {reason}.", code) from None
    except OSError as exc:
        journal("error", "dsm_unreachable")
        raise OpError("dsm_unreachable", 502, "DSM stopped answering.") from exc
    except SynologyDSMException as exc:
        # L'adresse répond en HTTPS, mais pas comme DSM (autre service, mauvais port).
        journal("error", "not_dsm")
        raise OpError(
            "not_dsm",
            502,
            f"{body.host}:{body.port} answers, but not as DSM does: "
            "check the address and the port.",
        ) from exc
    return Enrolled(
        dsm=dsm,
        creds=DsmCredentials(creds.username, creds.password, device_token),
        fingerprint=fingerprint,
        mode=mode,
    )


def create_setup_app(
    settings: SetupSettings,
    tokens: TokenStore,
    audit: AuditLog,
    enroller: Enroller,
    on_enrolled: Callable[[], None],
) -> FastAPI:
    """L'agent en attente : santé, puis enrôlement par la console, rien d'autre."""
    app = FastAPI(
        title="nas-agent",
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        redirect_slashes=False,
    )
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=[*settings.public_hosts, *_LOOPBACK_HOSTS]
    )
    authenticator = Authenticator(tokens, audit, settings.limits)
    attempts = Lockout(ENROLL_FAILURES, ENROLL_WINDOW_S, ENROLL_WINDOW_S)
    data_dir = settings.data_dir

    def ip_of(request: Request) -> str:
        # Aucun mandataire n'est cru ici : la console appelle l'agent directement.
        return request.client.host if request.client else "unknown"

    def setup_principal(request: Request, op: str) -> Principal:
        principal = authenticator.authenticate(
            request.headers.get("authorization"), ip_of(request), "rest", op
        )
        if "agent:setup" not in principal.scopes:
            raise OpError("forbidden", 403, "This token may not enroll the agent.")
        return principal

    @app.exception_handler(OpError)
    async def _op_error(_request: Request, exc: OpError) -> JSONResponse:
        return problem(exc.status, exc.code, exc.detail, exc.dsm_code)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else "invalid_request"
        return problem(exc.status_code, code, "Request refused.")

    @app.exception_handler(Exception)
    async def _unexpected(_request: Request, _exc: Exception) -> JSONResponse:
        return problem(500, "internal", "Internal agent error.")

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, Any]:
        return {"status": "ok", "enrolled": is_enrolled(data_dir)}

    @app.get("/v1/setup", include_in_schema=False)
    async def status(request: Request) -> dict[str, Any]:
        setup_principal(request, "agent.setup")
        if is_enrolled(data_dir):
            return {"enrolled": True}
        return {"enrolled": False, "dsm": {"host": enroller.gateway(), "port": 5001}}

    @app.post("/v1/setup/certificate", include_in_schema=False)
    async def certificate(request: Request, body: CertificateBody) -> dict[str, Any]:
        setup_principal(request, "agent.setup.certificate")
        if is_enrolled(data_dir):
            raise OpError("already_enrolled", 409, "The agent is already enrolled with DSM.")
        return await read_certificate(enroller, body)

    @app.post("/v1/setup/enroll", include_in_schema=False)
    async def enroll(request: Request, body: EnrollBody) -> dict[str, Any]:
        op = "agent.setup.enroll"
        principal = setup_principal(request, op)
        ip = ip_of(request)
        if is_enrolled(data_dir):
            raise OpError("already_enrolled", 409, "The agent is already enrolled with DSM.")

        def journal(outcome: str, code: str | None = None, dsm_code: int | None = None) -> None:
            audit.record(
                channel="rest",
                op=op,
                token_id=principal.token_id,
                client_ip=ip,
                outcome=outcome,  # type: ignore[arg-type]
                code=code,
                dsm_code=dsm_code,
                params={"host": body.host, "port": body.port, "username": body.username},
            )

        done = await enroll_dsm(enroller, body, attempts, ip, journal)
        dsm, creds = done.dsm, done.creds
        data_dir.mkdir(parents=True, exist_ok=True)
        save_credentials(data_dir / "secrets" / "dsm.json", creds)
        (data_dir / "config.toml").write_text(render_config(dsm, settings.public_hosts))
        journal("ok")
        on_enrolled()
        return {"enrolled": True, "tls_mode": done.mode}

    return app


def add_setup_status(app: FastAPI, authenticator: Authenticator, trusted: list[str]) -> None:
    """Agent enrôlé : la console lit qu'il n'y a plus rien à faire."""
    from nas_agent.auth import client_ip

    @app.get("/v1/setup", include_in_schema=False)
    async def status(request: Request) -> dict[str, Any]:
        peer = request.client.host if request.client else None
        principal = authenticator.authenticate(
            request.headers.get("authorization"),
            client_ip(peer, request.headers, trusted),
            "rest",
            "agent.setup",
        )
        if "agent:setup" not in principal.scopes:
            raise OpError("forbidden", 403, "This token may not enroll the agent.")
        return {"enrolled": True}
