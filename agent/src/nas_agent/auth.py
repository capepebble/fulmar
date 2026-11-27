"""Authentification par jeton porteur, avec blocage des adresses qui insistent."""

from __future__ import annotations

import ipaddress
import re
import time
from collections.abc import Callable, Mapping, Sequence

from starlette.datastructures import Headers

from nas_agent.audit import AuditLog, Channel
from nas_agent.config import Limits
from nas_agent.engine import OpError
from nas_agent.ratelimit import Lockout
from nas_agent.tokens import Principal, TokenStore

_ID_RE = re.compile(r"^nag_([a-z0-9]{8})_")


def client_ip(
    peer: str | None, headers: Headers | Mapping[str, str], trusted: Sequence[str]
) -> str:
    """Adresse de l'appelant ; X-Forwarded-For n'est cru que d'un mandataire de confiance.

    On prend la dernière valeur (celle qu'a ajoutée le mandataire), et seulement si c'est une
    adresse IP valide.
    """
    peer = peer or "unknown"
    if peer not in trusted:
        return peer
    values = (
        headers.getlist("x-forwarded-for")
        if isinstance(headers, Headers)
        else [headers.get("x-forwarded-for") or ""]
    )
    hops = [h.strip() for v in values for h in v.split(",") if h.strip()]
    if not hops:
        return peer
    try:
        return str(ipaddress.ip_address(hops[-1]))
    except ValueError:
        return peer


class Authenticator:
    def __init__(
        self,
        tokens: TokenStore,
        audit: AuditLog,
        limits: Limits,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._tokens = tokens
        self._audit = audit
        self._lockout = Lockout(limits.auth_failures, limits.auth_window_s, limits.lockout_s, clock)

    def authenticate(
        self, authorization: str | None, ip: str, channel: Channel, op: str | None = None
    ) -> Principal:
        if self._lockout.is_locked(ip):
            if self._lockout.should_log(ip):
                self._audit.record(
                    channel=channel,
                    op=op,
                    token_id=None,
                    client_ip=ip,
                    outcome="denied",
                    code="rate_limited",
                )
            raise OpError(
                "rate_limited",
                429,
                "Too many authentication failures: address blocked for a while.",
            )
        raw = None
        if authorization:
            scheme, _, value = authorization.partition(" ")
            if scheme.lower() == "bearer":
                raw = value.strip()
        principal = self._tokens.authenticate(raw, ip) if raw else None
        if principal is None:
            match = _ID_RE.match(raw or "")
            self._audit.record(
                channel=channel,
                op=op,
                token_id=match.group(1) if match else None,
                client_ip=ip,
                outcome="denied",
                code="unauthorized",
            )
            self._lockout.failure(ip)
            raise OpError("unauthorized", 401, "Token missing, invalid, expired or revoked.")
        return principal
