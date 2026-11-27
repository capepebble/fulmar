"""Session HTTP vers DSM, TLS toujours vérifié : par nom d'hôte ou par empreinte épinglée."""

from __future__ import annotations

import socket
import ssl
from typing import Any

import aiohttp
from aiohttp.abc import AbstractResolver, ResolveResult

from nas_agent.config import DsmSettings


class PinnedResolver(AbstractResolver):
    """Résout le nom du certificat de DSM vers son adresse locale (pont Docker, 127.0.0.1)."""

    def __init__(self, name: str, address: str):
        self._name = name.lower()
        self._address = address
        self._fallback = aiohttp.ThreadedResolver()

    async def resolve(
        self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET
    ) -> list[ResolveResult]:
        if host.lower() != self._name:
            raise OSError(f"Resolution refused for {host}: only {self._name} is reachable.")
        fam = socket.AF_INET6 if ":" in self._address else socket.AF_INET
        return [
            ResolveResult(
                hostname=host,
                host=self._address,
                port=port,
                family=fam,
                proto=0,
                flags=socket.AI_NUMERICHOST,
            )
        ]

    async def close(self) -> None:
        await self._fallback.close()


def dsm_url_host(settings: DsmSettings) -> str:
    """Hôte à mettre dans l'URL : le nom du certificat en mode hostname, l'adresse sinon."""
    if settings.tls_mode == "hostname":
        return _required(settings.tls_server_name, "tls_server_name")
    return settings.host


def connector_kwargs(settings: DsmSettings) -> dict[str, Any]:
    if settings.tls_mode == "pin":
        fingerprint = _required(settings.tls_fingerprint, "tls_fingerprint")
        return {"ssl": aiohttp.Fingerprint(bytes.fromhex(fingerprint))}
    name = _required(settings.tls_server_name, "tls_server_name")
    return {"ssl": ssl.create_default_context(), "resolver": PinnedResolver(name, settings.host)}


def _required(value: str | None, name: str) -> str:
    if not value:
        raise ValueError(f"{name} missing: TLS cannot be verified.")
    return value


def https_only(expected_host: str):
    """Intergiciel client : HTTPS vers l'hôte attendu, et aucune redirection suivie.

    Sans lui, une redirection vers http:// ferait renvoyer le mot de passe en clair :
    l'empreinte épinglée ne s'applique qu'aux connexions TLS.
    """

    async def middleware(request: aiohttp.ClientRequest, handler) -> aiohttp.ClientResponse:
        if request.url.scheme != "https" or (request.url.host or "").lower() != expected_host:
            raise aiohttp.ClientError("Request refused: DSM is reached over HTTPS, on its host.")
        response = await handler(request)
        if 300 <= response.status < 400:
            response.release()
            raise aiohttp.ClientError(f"Redirect from DSM refused (HTTP {response.status}).")
        return response

    return middleware


def build_session(settings: DsmSettings) -> aiohttp.ClientSession:
    connector = aiohttp.TCPConnector(limit=4, **connector_kwargs(settings))
    return aiohttp.ClientSession(
        connector=connector,
        cookie_jar=aiohttp.DummyCookieJar(),
        middlewares=(https_only(dsm_url_host(settings).lower()),),
    )
