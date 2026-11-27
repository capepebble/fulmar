"""Le journal des verdicts (conception 2026-11-26-bilan-du-mois, section 2).

Toutes les dix minutes, l'agent lit ses propres contrôles et note chaque changement d'état
(contrôle, état, état d'avant, heure) dans `agent.db`, gardé 400 jours. Un état inconnu (une
lecture ratée) n'est pas un changement. Au premier passage d'un nouveau mois, l'état de fin du
mois précédent est figé : le bilan d'un mois passé dit où il s'est fini.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from nas_agent.db import transaction
from nas_agent.tokens import Principal

log = logging.getLogger(__name__)

LOOP_S = 600.0
KEEP = timedelta(days=400)
READER = Principal(
    token_id="verdicts",  # noqa: S106 - un nom, pas un secret
    label="monthly report",
    scopes=frozenset({"audit:checks"}),
)


@dataclass(frozen=True)
class Event:
    at: str
    check_id: str
    status: str
    previous: str | None


def month_of(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m")


class VerdictLog:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def state(self) -> dict[str, tuple[str, str]]:
        rows = self._conn.execute("SELECT check_id, status, since FROM verdict_state").fetchall()
        return {r["check_id"]: (r["status"], r["since"]) for r in rows}

    def _freeze(self, month: str) -> None:
        state = self.state()
        counts = {
            s: sum(1 for st, _ in state.values() if st == s) for s in ("ok", "warning", "failed")
        }
        failing = [
            {"id": cid, "status": st}
            for cid, (st, _since) in sorted(state.items())
            if st in ("warning", "failed")
        ]
        self._conn.execute(
            "INSERT OR IGNORE INTO verdict_months (month, data) VALUES (?, ?)",
            (month, json.dumps({**counts, "failing": failing})),
        )

    def observe(self, checks: Iterable[tuple[str, str]], at: datetime) -> int:
        """Note les changements d'état ; rend leur nombre. Fige le mois qui vient de finir."""
        now = at.astimezone(UTC)
        changed = 0
        with transaction(self._conn):
            last = self._conn.execute("SELECT MAX(since) AS at FROM verdict_state").fetchone()
            seen = self._conn.execute(
                "SELECT value FROM relay_kv WHERE key = 'verdicts_last'"
            ).fetchone()
            previous_at = seen["value"] if seen else (last["at"] if last else None)
            if previous_at and month_of(datetime.fromisoformat(previous_at)) != month_of(now):
                self._freeze(month_of(datetime.fromisoformat(previous_at)))
            state = self.state()
            for check_id, status in checks:
                if status == "unknown":
                    continue
                before = state.get(check_id)
                if before is not None and before[0] == status:
                    continue
                self._conn.execute(
                    "INSERT INTO verdict_events (at, check_id, status, previous)"
                    " VALUES (?, ?, ?, ?)",
                    (now.isoformat(), check_id, status, before[0] if before else None),
                )
                self._conn.execute(
                    "INSERT INTO verdict_state (check_id, status, since) VALUES (?, ?, ?)"
                    " ON CONFLICT (check_id) DO UPDATE SET status = excluded.status,"
                    " since = excluded.since",
                    (check_id, status, now.isoformat()),
                )
                changed += 1
            self._conn.execute(
                "INSERT INTO relay_kv (key, value) VALUES ('verdicts_last', ?)"
                " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (now.isoformat(),),
            )
            self._conn.execute(
                "DELETE FROM verdict_events WHERE at < ?", ((now - KEEP).isoformat(),)
            )
        return changed

    def events(self, start: datetime, end: datetime) -> list[Event]:
        rows = self._conn.execute(
            "SELECT at, check_id, status, previous FROM verdict_events"
            " WHERE at >= ? AND at < ? ORDER BY seq",
            (start.astimezone(UTC).isoformat(), end.astimezone(UTC).isoformat()),
        ).fetchall()
        return [Event(r["at"], r["check_id"], r["status"], r["previous"]) for r in rows]

    def before(self, start: datetime) -> dict[str, Event]:
        """Le dernier état de chaque contrôle avant un instant (incident déjà ouvert)."""
        rows = self._conn.execute(
            "SELECT at, check_id, status, previous FROM verdict_events WHERE seq IN"
            " (SELECT MAX(seq) FROM verdict_events WHERE at < ? GROUP BY check_id)",
            (start.astimezone(UTC).isoformat(),),
        ).fetchall()
        return {
            r["check_id"]: Event(r["at"], r["check_id"], r["status"], r["previous"]) for r in rows
        }

    def month_end(self, month: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT data FROM verdict_months WHERE month = ?", (month,)
        ).fetchone()
        return json.loads(row["data"]) if row else None

    async def run(self, engine: Any, every_s: float = LOOP_S) -> None:
        while True:
            try:
                report, _at = await engine.read_internal("audit.checks", None, READER)
                self.observe([(c.id, c.status) for c in report.checks], datetime.now(UTC))
            except Exception:  # la boucle ne meurt jamais d'une lecture ratée
                log.exception("Verdict log failed")
            await asyncio.sleep(every_s)
