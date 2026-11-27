"""Client du relais (protocole, section 9.1) : connexions sortantes en HTTPS, jamais d'entrée.

Le transport se remplace dans les tests (faux relais en mémoire) ; par défaut, aiohttp avec la
vérification TLS du système.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import aiohttp

from nas_agent.relay.encoding import b64u

# (méthode, adresse, en-têtes, corps JSON ou None) -> (code HTTP, corps décodé ou None)
Transport = Callable[
    [str, str, Mapping[str, str], Any], Awaitable[tuple[int, dict[str, Any] | None]]
]

TIMEOUT_S = 15
MAX_RESPONSE = 512 * 1024


class RelayError(Exception):
    """Refus ou panne du relais : un code stable, jamais un contenu."""

    def __init__(self, status: int, code: str, detail: str = ""):
        super().__init__(f"{status} {code}")
        self.status = status
        self.code = code
        self.detail = detail


async def aiohttp_transport(
    method: str, url: str, headers: Mapping[str, str], body: Any
) -> tuple[int, dict[str, Any] | None]:
    timeout = aiohttp.ClientTimeout(total=TIMEOUT_S)
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    async with (
        aiohttp.ClientSession(timeout=timeout) as session,
        # Jamais de redirection : un relais hostile ne doit pas pouvoir envoyer l'agent (et
        # son corps) vers une adresse du réseau du propriétaire.
        session.request(
            method, url, headers=dict(headers), data=data, allow_redirects=False
        ) as response,
    ):
        if 300 <= response.status < 400:
            raise RelayError(response.status, "redirect", "the relay answered with a redirect")
        # Lecture jusqu'au bout du flux, morceau par morceau, bornée.
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.content.iter_chunked(64 * 1024):
            total += len(chunk)
            if total > MAX_RESPONSE:
                raise RelayError(response.status, "too_large", "relay answer too large")
            chunks.append(chunk)
        raw = b"".join(chunks)
        if not raw:
            return response.status, None
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        if not isinstance(parsed, dict):
            if 200 <= response.status < 300:
                raise RelayError(response.status, "bad_response", "unreadable relay answer")
            parsed = None
        return response.status, parsed


class RelayClient:
    def __init__(self, base_url: str, transport: Transport | None = None):
        self.base_url = base_url.rstrip("/")
        self._transport = transport or aiohttp_transport

    async def _call(
        self,
        method: str,
        path: str,
        body: Any = None,
        secret: bytes | None = None,
        ok: tuple[int, ...] = (200, 201, 202, 204),
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if secret is not None:
            headers["Authorization"] = f"Bearer {b64u(secret)}"
        try:
            status, data = await self._transport(method, f"{self.base_url}{path}", headers, body)
        except RelayError:
            raise
        except (aiohttp.ClientError, TimeoutError, OSError) as exc:
            raise RelayError(0, "unreachable", type(exc).__name__) from None
        if status not in ok:
            code = str((data or {}).get("code") or "http_error")[:40]
            detail = str((data or {}).get("detail") or "")[:200]
            raise RelayError(status, code, detail)
        return data or {}

    async def register(self, signed: Mapping[str, str]) -> dict[str, Any]:
        return await self._call("POST", "/v1/nas", dict(signed))

    async def put_state(self, nas: str, secret: bytes, envelope: Mapping) -> dict[str, Any]:
        return await self._call("PUT", f"/v1/nas/{nas}/state", {"envelope": envelope}, secret)

    async def post_alert(
        self, nas: str, secret: bytes, envelope: Mapping, text: str | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"envelope": envelope}
        if text:
            body["text"] = text
        return await self._call("POST", f"/v1/nas/{nas}/alerts", body, secret)

    async def pairing_window(self, nas: str, secret: bytes, window: Mapping) -> dict[str, Any]:
        return await self._call("PUT", f"/v1/nas/{nas}/pairing", {"window": window}, secret)

    async def inbox(self, nas: str, secret: bytes) -> list[dict[str, Any]]:
        data = await self._call("GET", f"/v1/nas/{nas}/inbox", None, secret)
        messages = data.get("messages")
        return [m for m in messages if isinstance(m, dict)] if isinstance(messages, list) else []

    async def ack(self, nas: str, secret: bytes, ids: list[str]) -> None:
        if ids:
            await self._call("POST", f"/v1/nas/{nas}/inbox/ack", {"ids": ids[:50]}, secret)

    async def status(self, nas: str, secret: bytes) -> dict[str, Any]:
        return await self._call("GET", f"/v1/nas/{nas}", None, secret)
