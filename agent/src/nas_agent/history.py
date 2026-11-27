"""Historique des constantes : relevés d'une minute résumés par paliers, dans SQLite.

Chaque relevé met à jour le palier en cours de chacun des quatre paliers (moyenne pondérée,
maximum, nombre de relevés) : aucune tâche de regroupement, le palier en cours se lit
toujours. Une purge horaire retire ce qui dépasse la durée de chaque palier.
"""

from __future__ import annotations

import math
import os
import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from nas_agent.db import transaction


@dataclass(frozen=True)
class Tier:
    name: str
    step_s: int
    # Durée de garde, et fenêtre maximale d'une lecture.
    retention_h: int
    # Fenêtre lue par défaut : la période que sert ce palier dans la console.
    default_h: int


# Les noms sont ceux des paliers de Beszel, que la console demande déjà.
TIERS: tuple[Tier, ...] = (
    Tier("1m", 60, 24, 1),
    Tier("20m", 20 * 60, 14 * 24, 24),
    Tier("120m", 2 * 3600, 90 * 24, 7 * 24),
    Tier("480m", 8 * 3600, 400 * 24, 30 * 24),
)
_BY_NAME = {t.name: t for t in TIERS}

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    tier TEXT NOT NULL,
    ts INTEGER NOT NULL,
    metric TEXT NOT NULL,
    subject TEXT NOT NULL,
    avg REAL NOT NULL,
    max REAL NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (tier, ts, metric, subject)
) WITHOUT ROWID;
PRAGMA user_version = 1;
"""

_UPSERT = """
INSERT INTO samples (tier, ts, metric, subject, avg, max, n) VALUES (?, ?, ?, ?, ?, ?, 1)
ON CONFLICT (tier, ts, metric, subject) DO UPDATE SET
    avg = (samples.avg * samples.n + excluded.avg) / (samples.n + 1),
    max = MAX(samples.max, excluded.max),
    n = samples.n + 1
"""

# Une série : (métrique, sujet), le sujet vide pour le NAS entier.
SeriesKey = tuple[str, str]


def tier_named(name: str) -> Tier | None:
    return _BY_NAME.get(name)


@dataclass(frozen=True)
class Point:
    t: datetime
    avg: float
    max: float
    n: int


@dataclass(frozen=True)
class FailingRead:
    code: str
    dsm_code: int | None
    since: datetime


@dataclass
class SamplingStatus:
    """État du relevé, tenu par la boucle et lu par `metrics.history`."""

    interval_s: int = 60
    running: bool = False
    last_sample_at: datetime | None = None
    failing: dict[str, FailingRead] = field(default_factory=dict)


def _instant(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, UTC)


def _open(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    # Une coupure peut perdre le dernier relevé, jamais la base.
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn


class HistoryStore:
    def __init__(self, path: Path):
        self.path = path
        self._conn = _open(path)
        self._lock = threading.Lock()
        self.status = SamplingStatus()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def record(self, at: datetime, values: Iterable[tuple[str, str, float]]) -> int:
        """Note un relevé dans le palier en cours de chaque palier ; rend le nombre de valeurs."""
        ts = int(at.timestamp())
        kept = [(m, s, float(v)) for m, s, v in values if math.isfinite(v)]
        rows = [
            (tier.name, ts - ts % tier.step_s, metric, subject, value, value)
            for tier in TIERS
            for metric, subject, value in kept
        ]
        if rows:
            with self._lock, transaction(self._conn):
                self._conn.executemany(_UPSERT, rows)
        return len(kept)

    def prune(self, now: datetime) -> None:
        ts = int(now.timestamp())
        with self._lock, transaction(self._conn):
            for tier in TIERS:
                cutoff = ts - tier.retention_h * 3600 - tier.step_s
                self._conn.execute(
                    "DELETE FROM samples WHERE tier = ? AND ts < ?", (tier.name, cutoff)
                )

    def read(self, tier: str, since: datetime) -> dict[SeriesKey, list[Point]]:
        """Points d'un palier depuis le palier qui contient `since`, par série, dans l'ordre."""
        step = _BY_NAME[tier].step_s
        start = int(since.timestamp())
        start -= start % step
        rows = self._conn.execute(
            "SELECT ts, metric, subject, avg, max, n FROM samples"
            " WHERE tier = ? AND ts >= ? ORDER BY metric, subject, ts",
            (tier, start),
        ).fetchall()
        out: dict[SeriesKey, list[Point]] = {}
        for ts, metric, subject, avg, mx, n in rows:
            out.setdefault((metric, subject), []).append(Point(_instant(ts), avg, mx, n))
        return out

    def latest(self) -> dict[SeriesKey, tuple[datetime, float]]:
        """Dernier relevé d'une minute de chaque série."""
        # SQLite rend les colonnes de la ligne qui porte le MAX (agrégat simple).
        rows = self._conn.execute(
            "SELECT metric, subject, MAX(ts), avg FROM samples WHERE tier = '1m'"
            " GROUP BY metric, subject"
        ).fetchall()
        return {(m, s): (_instant(ts), avg) for m, s, ts, avg in rows}
