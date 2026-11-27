"""Journal des appels, chaîné par empreintes SHA-256."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from nas_agent.db import transaction

# « internal » : l'agent pour lui-même (relevé des constantes, module relay), sans jeton ni
# adresse ; « phone » : lecture directe par un téléphone appairé (requête signée).
Channel = Literal["rest", "mcp", "cli", "internal", "phone"]
Outcome = Literal["ok", "denied", "error"]

GENESIS = "0" * 64
_MASKED_KEYS = ("pass", "secret", "token", "otp")


@dataclass(frozen=True)
class AuditEntry:
    seq: int
    ts: str
    channel: str
    op: str | None
    token_id: str | None
    client_ip: str | None
    outcome: str
    code: str | None
    dsm_code: int | None
    duration_ms: int
    params: dict[str, Any]
    prev_hash: str
    hash: str


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    checked: int
    broken_at: int | None


def mask_params(params: Mapping[str, Any] | None) -> dict[str, Any]:
    if not params:
        return {}
    return {k: "***" if any(m in k.lower() for m in _MASKED_KEYS) else v for k, v in params.items()}


def _digest(fields: Mapping[str, Any]) -> str:
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _hashed_fields(entry: Mapping[str, Any]) -> dict[str, Any]:
    # seq fait partie de l'empreinte : une suppression casse la chaîne.
    return {k: entry[k] for k in AuditEntry.__dataclass_fields__ if k != "hash"}


class AuditLog:
    def __init__(self, conn: sqlite3.Connection, clock: Callable[[], datetime] | None = None):
        self._conn = conn
        self._lock = threading.Lock()
        self.clock = clock or (lambda: datetime.now(UTC))
        # Dernière entrée vérifiée : la vérification suivante repart de là.
        self._checkpoint: tuple[int, str] | None = None

    def record(
        self,
        *,
        channel: Channel,
        op: str | None,
        token_id: str | None,
        client_ip: str | None,
        outcome: Outcome,
        code: str | None = None,
        dsm_code: int | None = None,
        duration_ms: int = 0,
        params: Mapping[str, Any] | None = None,
    ) -> AuditEntry:
        with self._lock, transaction(self._conn):
            last = self._conn.execute(
                "SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1"
            ).fetchone()
            fields: dict[str, Any] = {
                "seq": (last["seq"] + 1) if last else 1,
                "ts": self.clock().isoformat(),
                "channel": channel,
                "op": op,
                "token_id": token_id,
                "client_ip": client_ip,
                "outcome": outcome,
                "code": code,
                "dsm_code": dsm_code,
                "duration_ms": int(duration_ms),
                "params": mask_params(params),
                "prev_hash": last["hash"] if last else GENESIS,
            }
            fields["hash"] = _digest(fields)
            row = dict(fields, params=json.dumps(fields["params"], sort_keys=True))
            self._conn.execute(
                f"INSERT INTO audit ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",  # noqa: S608
                tuple(row.values()),
            )
            return AuditEntry(**fields)

    def summary(self, start: str, end: str) -> list[tuple[str | None, str, int]]:
        """Les appels entre deux instants ISO (UTC), par opération et par issue."""
        rows = self._conn.execute(
            "SELECT op, outcome, COUNT(*) AS n FROM audit WHERE ts >= ? AND ts < ?"
            " GROUP BY op, outcome",
            (start, end),
        ).fetchall()
        return [(r["op"], r["outcome"], r["n"]) for r in rows]

    def tail(self, limit: int = 100) -> list[AuditEntry]:
        rows = self._conn.execute(
            "SELECT * FROM audit ORDER BY seq DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self._entry(r) for r in rows]

    def verify(self, *, incremental: bool = False) -> VerifyResult:
        """Vérifie la chaîne ; `incremental` repart de la dernière entrée déjà vérifiée."""
        prev_hash, expected_seq, checked = GENESIS, 1, 0
        if incremental and self._checkpoint is not None:
            last_seq, prev_hash = self._checkpoint
            expected_seq = last_seq + 1
            anchor = self._conn.execute(
                "SELECT hash FROM audit WHERE seq = ?", (last_seq,)
            ).fetchone()
            if anchor is None or anchor["hash"] != prev_hash:
                return VerifyResult(False, 0, last_seq)
        rows = self._conn.execute(
            "SELECT * FROM audit WHERE seq >= ? ORDER BY seq", (expected_seq,)
        )
        for row in rows:
            entry = asdict(self._entry(row))
            if (
                entry["seq"] != expected_seq
                or entry["prev_hash"] != prev_hash
                or _digest(_hashed_fields(entry)) != entry["hash"]
            ):
                return VerifyResult(False, checked, entry["seq"])
            prev_hash, expected_seq, checked = entry["hash"], expected_seq + 1, checked + 1
        if expected_seq > 1:
            self._checkpoint = (expected_seq - 1, prev_hash)
        return VerifyResult(True, checked, None)

    @staticmethod
    def _entry(row: sqlite3.Row) -> AuditEntry:
        data = dict(row)
        data["params"] = json.loads(data["params"])
        return AuditEntry(**data)
