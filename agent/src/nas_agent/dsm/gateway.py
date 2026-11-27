"""Passerelle vers DSM : connexion paresseuse, reconnexion unique, concurrence bornée."""

from __future__ import annotations

import asyncio
import logging
import ssl
import time
from collections.abc import Callable, Mapping
from typing import Any, Protocol

import aiohttp
from synology_dsm import SynologyDSM
from synology_dsm.exceptions import (
    SynologyDSMAPIErrorException,
    SynologyDSMAPINotExistsException,
    SynologyDSMException,
    SynologyDSMLoginFailedException,
    SynologyDSMNotLoggedInException,
    SynologyDSMRequestException,
)

from nas_agent.config import DsmSettings
from nas_agent.dsm.credentials import DsmCredentials
from nas_agent.dsm.tls import build_session, dsm_url_host

log = logging.getLogger(__name__)

# Codes DSM d'une session invalide ou expirée.
SESSION_CODES = frozenset({106, 107, 119})
# Codes DSM d'une API, d'une méthode ou d'une version absente.
UNSUPPORTED_CODES = frozenset({102, 103, 104})
# Attente après un refus de connexion : DSM bloquerait le compte ou l'adresse si on insistait.
AUTH_BACKOFF_START = 60.0
AUTH_BACKOFF_MAX = 900.0


class DsmGatewayError(Exception):
    """Base des erreurs de la passerelle ; le message ne porte jamais de secret."""


class DsmError(DsmGatewayError):
    def __init__(self, code: int, api: str | None = None, details: Any = None):
        super().__init__(f"DSM answered with error {code}" + (f" ({api})" if api else ""))
        self.code = code
        self.api = api
        # Le détail que DSM joint à certaines erreurs (« errors ») : les raisons d'un refus.
        self.details = details


class DsmAuthError(DsmError):
    pass


class DsmUnreachable(DsmGatewayError):
    pass


class DsmCertificateError(DsmUnreachable):
    """DSM ne présente plus le certificat attendu (empreinte épinglée ou nom)."""


_CERT_ERRORS = (
    aiohttp.ServerFingerprintMismatch,
    aiohttp.ClientConnectorCertificateError,
    ssl.SSLCertVerificationError,
)


def _unreachable(exc: BaseException, where: str) -> DsmUnreachable:
    """Injoignable, sauf si la cause est un certificat changé : on le dit, c'est à corriger."""
    seen: BaseException | None = exc
    for _ in range(8):
        if seen is None:
            break
        if isinstance(seen, _CERT_ERRORS):
            return DsmCertificateError(
                f"Unexpected DSM certificate ({where}): check it, then enroll again"
            )
        seen = seen.__cause__ or seen.__context__
    return DsmUnreachable(f"DSM unreachable ({where})")


class DsmUnsupported(DsmGatewayError):
    def __init__(self, api: str):
        super().__init__(f"API {api} missing on this NAS")
        self.api = api


class DsmCaller(Protocol):
    async def call(
        self,
        api: str,
        method: str,
        *,
        max_version: int,
        min_version: int = 1,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]: ...


class DsmClient(Protocol):
    """Ce que la passerelle attend du client (SynologyDSM le satisfait)."""

    device_token: str | None
    apis: Mapping[str, Any]

    async def login(self, otp_code: str | None = None) -> bool: ...
    async def logout(self) -> bool: ...
    async def get(
        self, api: str, method: str, params: dict | None = None, **kwargs: Any
    ) -> Any: ...


ClientFactory = Callable[[aiohttp.ClientSession, DsmSettings, DsmCredentials], DsmClient]


def default_client_factory(
    session: aiohttp.ClientSession, settings: DsmSettings, creds: DsmCredentials
) -> DsmClient:
    return SynologyDSM(
        session,
        dsm_url_host(settings),
        settings.port,
        creds.username,
        creds.password,
        use_https=True,
        timeout=int(settings.timeout),
        device_token=creds.device_token,
    )


def _code(exc: SynologyDSMException) -> int:
    info = exc.args[0] if exc.args else None
    return int(info.get("code", -1)) if isinstance(info, dict) else -1


def _details(exc: SynologyDSMException) -> Any:
    info = exc.args[0] if exc.args else None
    return info.get("details") if isinstance(info, dict) else None


class DsmGateway:
    def __init__(
        self,
        settings: DsmSettings,
        credentials: DsmCredentials,
        *,
        concurrency: int = 2,
        client_factory: ClientFactory = default_client_factory,
        session_factory: Callable[[DsmSettings], aiohttp.ClientSession] = build_session,
        on_device_token: Callable[[str], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._settings = settings
        self._credentials = credentials
        self._client_factory = client_factory
        self._session_factory = session_factory
        self._on_device_token = on_device_token
        self._semaphore = asyncio.Semaphore(concurrency)
        self._login_lock = asyncio.Lock()
        self._session: aiohttp.ClientSession | None = None
        self._client: DsmClient | None = None
        self._logged_in = False
        self._generation = 0
        self._clock = clock
        self._auth_failure: DsmAuthError | None = None
        self._auth_retry_at = 0.0
        self._auth_backoff = AUTH_BACKOFF_START

    async def _login(self) -> tuple[DsmClient, int]:
        async with self._login_lock:
            if self._client is None:
                self._session = self._session_factory(self._settings)
                self._client = self._client_factory(
                    self._session, self._settings, self._credentials
                )
            if not self._logged_in:
                if self._auth_failure is not None and self._clock() < self._auth_retry_at:
                    raise self._auth_failure
                try:
                    ok = await asyncio.wait_for(self._client.login(), self._settings.timeout)
                except SynologyDSMLoginFailedException as exc:
                    self._auth_failed(DsmAuthError(_code(exc), "SYNO.API.Auth"))
                except (SynologyDSMRequestException, aiohttp.ClientError, TimeoutError) as exc:
                    raise _unreachable(exc, "sign-in") from None
                except SynologyDSMException as exc:
                    # login() interroge aussi SYNO.API.Info et SYNO.DSM.Info.
                    raise DsmError(_code(exc), "SYNO.API.Auth") from None
                except (KeyError, TypeError, ValueError):
                    raise DsmError(-1, "SYNO.API.Auth") from None
                if not ok:
                    self._auth_failed(DsmAuthError(-1, "SYNO.API.Auth"))
                self._logged_in = True
                self._generation += 1
                self._auth_failure, self._auth_backoff = None, AUTH_BACKOFF_START
                self._remember_device_token()
            return self._client, self._generation

    def _auth_failed(self, error: DsmAuthError) -> None:
        self._auth_failure = error
        self._auth_retry_at = self._clock() + self._auth_backoff
        log.warning(
            "DSM sign-in refused (code %s): retrying in %.0f s",
            error.code,
            self._auth_backoff,
        )
        self._auth_backoff = min(self._auth_backoff * 2, AUTH_BACKOFF_MAX)
        raise error

    def _remember_device_token(self) -> None:
        token = getattr(self._client, "device_token", None)
        if token and token != self._credentials.device_token and self._on_device_token:
            try:
                self._on_device_token(token)
            except OSError:
                log.warning("DSM device token not saved (write failed)")

    async def _invalidate(self, generation: int) -> None:
        # Une réponse d'une ancienne session n'invalide pas une session plus récente.
        async with self._login_lock:
            if self._generation == generation:
                self._logged_in = False

    def _check_version(self, client: DsmClient, api: str, min_version: int) -> None:
        info = getattr(client, "apis", {}).get(api) if api != "SYNO.API.Info" else None
        if isinstance(info, Mapping):
            max_available = info.get("maxVersion")
            if isinstance(max_available, int) and max_available < min_version:
                raise DsmUnsupported(api)

    async def call(
        self,
        api: str,
        method: str,
        *,
        max_version: int,
        min_version: int = 1,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        async with self._semaphore:
            for attempt in (1, 2):
                client, generation = await self._login()
                self._check_version(client, api, min_version)
                try:
                    response = await asyncio.wait_for(
                        client.get(api, method, dict(params or {}), max_version=max_version),
                        self._settings.timeout,
                    )
                except SynologyDSMNotLoggedInException:
                    pass
                except SynologyDSMAPINotExistsException:
                    raise DsmUnsupported(api) from None
                except SynologyDSMAPIErrorException as exc:
                    code = _code(exc)
                    if code in UNSUPPORTED_CODES:
                        raise DsmUnsupported(api) from None
                    if code not in SESSION_CODES:
                        raise DsmError(code, api, _details(exc)) from None
                except (SynologyDSMRequestException, aiohttp.ClientError, TimeoutError) as exc:
                    raise _unreachable(exc, api) from None
                except SynologyDSMException as exc:
                    raise DsmError(_code(exc), api) from None
                else:
                    if not isinstance(response, dict):
                        raise DsmError(-1, api)
                    data = response.get("data")
                    return data if isinstance(data, dict) else {"items": data}
                # Session expirée : une seule reconnexion.
                await self._invalidate(generation)
                if attempt == 2:
                    raise DsmError(119, api)
                log.info("DSM session expired, signing in again")
        raise AssertionError("inaccessible")  # pragma: no cover

    async def close(self) -> None:
        if self._client is not None and self._logged_in:
            try:
                await asyncio.wait_for(self._client.logout(), 5)
            except Exception:  # la fermeture ne doit jamais échouer
                log.debug("DSM sign-out failed", exc_info=False)
        if self._session is not None:
            await self._session.close()
        self._client, self._session, self._logged_in = None, None, False
