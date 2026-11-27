import re
from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.db import open_db
from nas_agent.tokens import TokenStore

TOKEN_RE = re.compile(r"^nag_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$")


@pytest.fixture
def store(tmp_path):
    return TokenStore(open_db(tmp_path / "agent.db"))


def test_format_and_authenticate(store):
    info, raw = store.create("claude-mac", ["system:read"])
    assert TOKEN_RE.match(raw)
    assert info.last_used_at is None
    principal = store.authenticate(raw, "100.64.0.1")
    assert principal is not None
    assert principal.token_id == info.id
    assert principal.scopes == frozenset({"system:read"})
    assert store.list()[0].last_used_at is not None


def test_wrong_secret_refused(store):
    _, raw = store.create("x", ["system:read"])
    forged = raw[:-4] + ("AAAA" if not raw.endswith("AAAA") else "BBBB")
    assert store.authenticate(forged, "100.64.0.1") is None
    assert store.authenticate(f"nag_zzzzzzzz_{raw.split('_', 2)[2]}", "100.64.0.1") is None
    assert store.authenticate("garbage", "100.64.0.1") is None
    assert store.authenticate("", "100.64.0.1") is None


def test_expired_refused(store):
    now = datetime(2026, 1, 1, tzinfo=UTC)
    store.clock = lambda: now
    _, raw = store.create("x", ["system:read"], ttl_days=1)
    store.clock = lambda: now + timedelta(days=2)
    assert store.authenticate(raw, "100.64.0.1") is None


def test_revoked_refused(store):
    info, raw = store.create("x", ["system:read"])
    assert store.revoke(info.id) is True
    assert store.authenticate(raw, "100.64.0.1") is None
    assert store.revoke("unknown1") is False


def test_cidr_enforced(store):
    _, raw = store.create("x", ["system:read"], cidrs=["100.64.0.0/10"])
    assert store.authenticate(raw, "100.100.1.2") is not None
    assert store.authenticate(raw, "192.168.1.10") is None
    assert store.authenticate(raw, "not-an-ip") is None


def test_secret_not_stored_in_clear(tmp_path):
    conn = open_db(tmp_path / "agent.db")
    _, raw = TokenStore(conn).create("x", ["system:read"])
    secret = raw.split("_", 2)[2]
    dump = "\n".join(conn.iterdump())
    assert secret not in dump


def test_unknown_scope_refused(store):
    with pytest.raises(ValueError):
        store.create("x", ["root:write"])
    with pytest.raises(ValueError):
        store.create("x", [])


def test_checks_scope_is_separate_from_journal(store):
    # Contrôles d'audit et journal de l'agent : deux droits distincts (décision du 2026-11-09).
    record, _ = store.create("console", ["audit:checks"])
    assert record.scopes == frozenset({"audit:checks"})


def test_db_file_is_private(tmp_path):
    open_db(tmp_path / "agent.db")
    assert (tmp_path / "agent.db").stat().st_mode & 0o077 == 0


def test_no_sqlite_injection_via_token(store):
    store.create("x", ["system:read"])
    assert store.authenticate("nag_' OR 1=1 --_" + "A" * 43, "100.64.0.1") is None
    assert isinstance(store.list(), list)
