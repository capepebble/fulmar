"""Jetons d'accès : nag_<id>_<secret>, seule l'empreinte du secret est stockée."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import re
import secrets
import sqlite3
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

KNOWN_SCOPES: frozenset[str] = frozenset(
    {
        "system:read",
        "storage:read",
        "backup:read",
        "security:read",
        "personal:read",
        # Journal de l'agent (agent.audit).
        "audit:read",
        # Contrôles d'audit (audit.checks) : l'état de sécurité du NAS, séparé du journal.
        "audit:checks",
        "backup:run",
        # Mettre à jour des paquets (conception 2026-11-26-mises-a-jour-paquets) : la seule
        # écriture de l'agent sur DSM, à part de toute lecture.
        "packages:update",
        # Mettre à jour DSM, qui redémarre le NAS : à part des paquets.
        "dsm:update",
        # Fermer SSH ou Telnet resté ouvert, jamais l'ouvrir (conception 2026-11-26-fermer-acces).
        "access:close",
        # Téléphones : ouvrir un code d'appairage, lister ou retirer les téléphones appairés
        # (jeton de la console ; un téléphone appairé n'a pas de jeton, il signe ses requêtes).
        "devices:pair",
        # Enrôlement par la console du projet (moteur installable) : relier l'agent à DSM tant
        # qu'il ne l'est pas, et lire s'il l'est.
        "agent:setup",
        # Le parc du hub (conception 2026-11-26) : ajouter un NAS par l'adresse de son DSM, le
        # retirer ; jeton de la console du projet seulement.
        "fleet:manage",
    }
)

_TOKEN_RE = re.compile(r"^nag_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$")
_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


@dataclass(frozen=True)
class Principal:
    token_id: str
    label: str
    scopes: frozenset[str]


@dataclass(frozen=True)
class TokenInfo:
    id: str
    label: str
    scopes: frozenset[str]
    created_at: datetime
    expires_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None
    cidrs: tuple[str, ...]


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


class TokenStore:
    def __init__(self, conn: sqlite3.Connection, clock: Callable[[], datetime] | None = None):
        self._conn = conn
        self.clock = clock or (lambda: datetime.now(UTC))

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    def create(
        self,
        label: str,
        scopes: Iterable[str],
        ttl_days: int = 90,
        cidrs: Sequence[str] = (),
    ) -> tuple[TokenInfo, str]:
        scope_set = frozenset(scopes)
        unknown = scope_set - KNOWN_SCOPES
        if not scope_set or unknown:
            raise ValueError(f"Unknown or empty scopes: {sorted(unknown) or '(none)'}")
        if ttl_days < 1:
            raise ValueError("A token lives at least one day.")
        for cidr in cidrs:
            ipaddress.ip_network(cidr, strict=False)

        token_id = "".join(secrets.choice(_ID_ALPHABET) for _ in range(8))
        secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
        now = self.clock()
        expires = now + timedelta(days=ttl_days)
        self._conn.execute(
            "INSERT INTO tokens (id, label, secret_hash, scopes, cidrs, created_at, expires_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                token_id,
                label,
                _hash(secret),
                ",".join(sorted(scope_set)),
                ",".join(cidrs),
                now.isoformat(),
                expires.isoformat(),
            ),
        )
        info = TokenInfo(token_id, label, scope_set, now, expires, None, None, tuple(cidrs))
        return info, f"nag_{token_id}_{secret}"

    def authenticate(self, raw: str, client_ip: str) -> Principal | None:
        match = _TOKEN_RE.match(raw or "")
        if not match:
            return None
        token_id, secret = match.groups()
        row = self._conn.execute("SELECT * FROM tokens WHERE id = ?", (token_id,)).fetchone()
        # Comparaison faite même sans ligne, pour ne pas trahir l'existence d'un identifiant.
        expected = row["secret_hash"] if row else _hash("")
        if not hmac.compare_digest(expected, _hash(secret)) or row is None:
            return None
        now = self.clock()
        if row["revoked_at"] or datetime.fromisoformat(row["expires_at"]) <= now:
            return None
        if row["cidrs"] and not _ip_allowed(client_ip, row["cidrs"].split(",")):
            return None
        self._conn.execute(
            "UPDATE tokens SET last_used_at = ? WHERE id = ?", (now.isoformat(), token_id)
        )
        return Principal(token_id, row["label"], frozenset(row["scopes"].split(",")))

    def revoke(self, token_id: str) -> bool:
        cur = self._conn.execute(
            "UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (self.clock().isoformat(), token_id),
        )
        return cur.rowcount == 1

    def list(self) -> list[TokenInfo]:
        rows = self._conn.execute("SELECT * FROM tokens ORDER BY created_at").fetchall()
        return [
            TokenInfo(
                id=r["id"],
                label=r["label"],
                scopes=frozenset(r["scopes"].split(",")),
                created_at=datetime.fromisoformat(r["created_at"]),
                expires_at=datetime.fromisoformat(r["expires_at"]),
                last_used_at=_dt(r["last_used_at"]),
                revoked_at=_dt(r["revoked_at"]),
                cidrs=tuple(c for c in r["cidrs"].split(",") if c),
            )
            for r in rows
        ]


def _ip_allowed(client_ip: str, cidrs: Sequence[str]) -> bool:
    try:
        ip = ipaddress.ip_address(client_ip)
    except ValueError:
        return False
    return any(ip in ipaddress.ip_network(c, strict=False) for c in cidrs)
