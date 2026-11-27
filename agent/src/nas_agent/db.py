"""Base SQLite locale : jetons, journal et module relay (téléphones, codes, alertes)."""

from __future__ import annotations

import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    scopes TEXT NOT NULL,
    cidrs TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    channel TEXT NOT NULL,
    op TEXT,
    token_id TEXT,
    client_ip TEXT,
    outcome TEXT NOT NULL,
    code TEXT,
    dsm_code INTEGER,
    duration_ms INTEGER NOT NULL,
    params TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
);
-- Module relay : téléphones appairés, codes d'appairage, mémoire, alertes gardées.
CREATE TABLE IF NOT EXISTS relay_devices (
    id TEXT PRIMARY KEY,
    sign_pk TEXT NOT NULL,
    box_pk TEXT NOT NULL,
    name TEXT NOT NULL,
    via TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    revoked_at TEXT,
    last_read_at TEXT,
    pair_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS relay_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    reusable INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    device_id TEXT,
    closed_at TEXT
);
CREATE TABLE IF NOT EXISTS relay_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_alerts (
    seq INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    sev TEXT NOT NULL,
    ring INTEGER NOT NULL,
    recipients TEXT NOT NULL,
    body TEXT NOT NULL
);
-- Le journal des verdicts (conception 2026-11-26-bilan-du-mois) : chaque changement d'état
-- d'un contrôle, l'état présent de chacun, et l'état figé à la fin de chaque mois.
CREATE TABLE IF NOT EXISTS verdict_events (
    seq INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    check_id TEXT NOT NULL,
    status TEXT NOT NULL,
    previous TEXT
);
CREATE INDEX IF NOT EXISTS verdict_events_at ON verdict_events (at);
CREATE TABLE IF NOT EXISTS verdict_state (
    check_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    since TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verdict_months (
    month TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
"""


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        # Créé d'emblée en 600 : le fichier porte les empreintes des jetons.
        os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Colonnes ajoutées après la création d'une table (bases déjà en service)."""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(relay_devices)")}
    if "pair_at" not in columns:
        # Heure signée de la demande d'appairage : un oubli plus ancien est ignoré.
        conn.execute("ALTER TABLE relay_devices ADD COLUMN pair_at INTEGER NOT NULL DEFAULT 0")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Transaction écrivante (BEGIN IMMEDIATE), ou point de sauvegarde si l'on est déjà dedans."""
    if conn.in_transaction:
        conn.execute("SAVEPOINT nas_agent")
        try:
            yield
        except BaseException:
            conn.execute("ROLLBACK TO nas_agent")
            conn.execute("RELEASE nas_agent")
            raise
        conn.execute("RELEASE nas_agent")
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
