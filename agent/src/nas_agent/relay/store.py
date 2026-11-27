"""Ce que le module relay garde dans agent.db : téléphones, codes, mémoire, alertes.

La base est partagée entre `nas-agent serve` et la ligne de commande (`relay pair` ouvre un
code que la boucle de `serve` voit à son tour suivant) : chaque écriture est une transaction
courte, les décisions qui ne doivent passer qu'une fois sont des écritures conditionnelles.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from nas_agent.db import transaction
from nas_agent.relay.encoding import b64u, unb64u

ALERTS_KEEP = timedelta(days=30)
ALERTS_MAX = 500


@dataclass(frozen=True)
class Device:
    id: str
    sign_public: bytes
    box_public: bytes
    name: str
    via: str
    paired_at: datetime
    revoked_at: datetime | None
    last_read_at: datetime | None
    # Heure signée de la demande d'appairage (secondes) : un oubli plus ancien est ignoré.
    pair_at: int = 0


@dataclass(frozen=True)
class PairingCode:
    id: str
    code: bytes
    opened_at: datetime
    expires_at: datetime
    reusable: bool
    used_at: datetime | None
    device_id: str | None
    closed_at: datetime | None

    def open_at(self, now: datetime) -> bool:
        return (
            self.closed_at is None
            and now < self.expires_at
            and (self.reusable or self.used_at is None)
        )


@dataclass(frozen=True)
class StoredAlert:
    seq: int
    at: datetime
    sev: str
    ring: bool
    recipients: tuple[str, ...]
    body: bytes


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


class RelayStore:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn
        self._lock = threading.Lock()

    # Téléphones ----------------------------------------------------------------------------

    @staticmethod
    def _device(row: sqlite3.Row) -> Device:
        return Device(
            id=row["id"],
            sign_public=unb64u(row["sign_pk"], 32),
            box_public=unb64u(row["box_pk"], 32),
            name=row["name"],
            via=row["via"],
            paired_at=datetime.fromisoformat(row["paired_at"]),
            revoked_at=_dt(row["revoked_at"]),
            last_read_at=_dt(row["last_read_at"]),
            pair_at=row["pair_at"] or 0,
        )

    def devices(self, *, include_revoked: bool = False) -> list[Device]:
        sql = "SELECT * FROM relay_devices"
        if not include_revoked:
            sql += " WHERE revoked_at IS NULL"
        rows = self._conn.execute(sql + " ORDER BY paired_at, id").fetchall()
        return [self._device(r) for r in rows]

    def device(self, device_id: str) -> Device | None:
        row = self._conn.execute(
            "SELECT * FROM relay_devices WHERE id = ? AND revoked_at IS NULL", (device_id,)
        ).fetchone()
        return self._device(row) if row else None

    def add_device(
        self,
        device_id: str,
        sign_public: bytes,
        box_public: bytes,
        name: str,
        via: str,
        at: datetime,
        pair_at: int = 0,
    ) -> None:
        with self._lock, transaction(self._conn):
            self._conn.execute(
                "INSERT INTO relay_devices (id, sign_pk, box_pk, name, via, paired_at, pair_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET"
                " box_pk = excluded.box_pk, name = excluded.name, via = excluded.via,"
                " paired_at = excluded.paired_at, pair_at = excluded.pair_at, revoked_at = NULL",
                (
                    device_id,
                    b64u(sign_public),
                    b64u(box_public),
                    name,
                    via,
                    at.isoformat(),
                    pair_at,
                ),
            )

    def revoke_device(self, device_id: str, at: datetime) -> bool:
        with self._lock, transaction(self._conn):
            cur = self._conn.execute(
                "UPDATE relay_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                (at.isoformat(), device_id),
            )
        return cur.rowcount == 1

    def touch_device(self, device_id: str, at: datetime) -> None:
        """Dernière lecture directe, notée au plus une fois par minute."""
        with self._lock, transaction(self._conn):
            self._conn.execute(
                "UPDATE relay_devices SET last_read_at = ? WHERE id = ?"
                " AND (last_read_at IS NULL OR last_read_at < ?)",
                (at.isoformat(), device_id, (at - timedelta(minutes=1)).isoformat()),
            )

    # Codes d'appairage ---------------------------------------------------------------------

    @staticmethod
    def _code(row: sqlite3.Row) -> PairingCode:
        return PairingCode(
            id=row["id"],
            code=unb64u(row["code"], 16) if row["code"] else b"",
            opened_at=datetime.fromisoformat(row["opened_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]),
            reusable=bool(row["reusable"]),
            used_at=_dt(row["used_at"]),
            device_id=row["device_id"],
            closed_at=_dt(row["closed_at"]),
        )

    def open_code(
        self, code: bytes, now: datetime, ttl: timedelta, *, reusable: bool = False
    ) -> PairingCode:
        """Ouvre un code ; ferme ceux qui l'étaient (un seul code ouvert à la fois)."""
        code_id = secrets.token_hex(6)
        with self._lock, transaction(self._conn):
            self._conn.execute(
                "UPDATE relay_codes SET closed_at = ?, code = '' WHERE closed_at IS NULL",
                (now.isoformat(),),
            )
            self._conn.execute(
                "INSERT INTO relay_codes (id, code, opened_at, expires_at, reusable)"
                " VALUES (?, ?, ?, ?, ?)",
                (code_id, b64u(code), now.isoformat(), (now + ttl).isoformat(), int(reusable)),
            )
        found = self.code(code_id)
        if found is None:  # pragma: no cover - écrit à l'instant
            raise RuntimeError("code introuvable")
        return found

    def code(self, code_id: str) -> PairingCode | None:
        row = self._conn.execute("SELECT * FROM relay_codes WHERE id = ?", (code_id,)).fetchone()
        return self._code(row) if row else None

    def open_code_at(self, now: datetime) -> PairingCode | None:
        rows = self._conn.execute(
            "SELECT * FROM relay_codes WHERE closed_at IS NULL ORDER BY opened_at DESC"
        ).fetchall()
        for row in rows:
            code = self._code(row)
            if code.open_at(now):
                return code
        return None

    def use_code(self, code: PairingCode, device_id: str, now: datetime) -> bool:
        """Marque le code utilisé, une seule fois (sauf code de revue, réutilisable)."""
        with self._lock, transaction(self._conn):
            if code.reusable:
                cur = self._conn.execute(
                    "UPDATE relay_codes SET device_id = ? WHERE id = ? AND closed_at IS NULL"
                    " AND expires_at > ?",
                    (device_id, code.id, now.isoformat()),
                )
            else:
                cur = self._conn.execute(
                    "UPDATE relay_codes SET used_at = ?, device_id = ?, code = ''"
                    " WHERE id = ? AND used_at IS NULL AND closed_at IS NULL AND expires_at > ?",
                    (now.isoformat(), device_id, code.id, now.isoformat()),
                )
        return cur.rowcount == 1

    def close_codes(self, now: datetime) -> int:
        with self._lock, transaction(self._conn):
            cur = self._conn.execute(
                "UPDATE relay_codes SET closed_at = ?, code = '' WHERE closed_at IS NULL",
                (now.isoformat(),),
            )
        return cur.rowcount

    def purge_codes(self, now: datetime) -> None:
        """Le code s'efface à son échéance ; la ligne, sans le code, reste un jour."""
        with self._lock, transaction(self._conn):
            self._conn.execute(
                "UPDATE relay_codes SET code = '' WHERE code != '' AND expires_at <= ?",
                (now.isoformat(),),
            )
            self._conn.execute(
                "DELETE FROM relay_codes WHERE expires_at < ?",
                ((now - timedelta(days=1)).isoformat(),),
            )

    # Mémoire -------------------------------------------------------------------------------

    def get(self, key: str, default: Any = None) -> Any:
        row = self._conn.execute("SELECT value FROM relay_kv WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set(self, key: str, value: Any) -> None:
        with self._lock, transaction(self._conn):
            self._conn.execute(
                "INSERT INTO relay_kv (key, value) VALUES (?, ?)"
                " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value, ensure_ascii=False)),
            )

    def next_seq(self, now: datetime) -> int:
        """Compteur de fraîcheur : max(dernier + 1, heure en millisecondes), écrit d'abord."""
        with self._lock, transaction(self._conn):
            row = self._conn.execute("SELECT value FROM relay_kv WHERE key = 'seq'").fetchone()
            last = int(json.loads(row["value"])) if row else 0
            seq = max(last + 1, int(now.timestamp() * 1000))
            self._conn.execute(
                "INSERT INTO relay_kv (key, value) VALUES ('seq', ?)"
                " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (json.dumps(seq),),
            )
        return seq

    # Alertes gardées (lecture directe) ------------------------------------------------------

    def add_alert(self, alert: StoredAlert) -> None:
        with self._lock, transaction(self._conn):
            self._conn.execute(
                "INSERT INTO relay_alerts (seq, at, sev, ring, recipients, body)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    alert.seq,
                    alert.at.isoformat(),
                    alert.sev,
                    int(alert.ring),
                    ",".join(alert.recipients),
                    alert.body.decode(),
                ),
            )
            self._conn.execute(
                "DELETE FROM relay_alerts WHERE at < ? OR seq NOT IN"
                " (SELECT seq FROM relay_alerts ORDER BY seq DESC LIMIT ?)",
                ((alert.at - ALERTS_KEEP).isoformat(), ALERTS_MAX),
            )

    def alerts_after(self, seq: int, limit: int = 100) -> list[StoredAlert]:
        rows = self._conn.execute(
            "SELECT * FROM relay_alerts WHERE seq > ? ORDER BY seq LIMIT ?", (seq, limit)
        ).fetchall()
        return [
            StoredAlert(
                seq=r["seq"],
                at=datetime.fromisoformat(r["at"]),
                sev=r["sev"],
                ring=bool(r["ring"]),
                recipients=tuple(x for x in r["recipients"].split(",") if x),
                body=r["body"].encode(),
            )
            for r in rows
        ]


def utcnow() -> datetime:
    return datetime.now(UTC)
