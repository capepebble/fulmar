import pytest

from nas_agent.audit import AuditLog
from nas_agent.db import open_db


@pytest.fixture
def conn(tmp_path):
    return open_db(tmp_path / "agent.db")


def _fill(log: AuditLog) -> None:
    log.record(
        channel="rest",
        op="system.info",
        token_id="abcd1234",
        client_ip="100.64.0.1",
        outcome="ok",
        duration_ms=12,
    )
    log.record(
        channel="mcp",
        op="storage.overview",
        token_id="abcd1234",
        client_ip="100.64.0.1",
        outcome="denied",
        code="forbidden",
    )
    log.record(
        channel="rest",
        op=None,
        token_id=None,
        client_ip="100.64.0.9",
        outcome="denied",
        code="unauthorized",
    )


def test_chain_verifies(conn):
    log = AuditLog(conn)
    _fill(log)
    result = log.verify()
    assert result.ok and result.checked == 3 and result.broken_at is None
    entries = log.tail()
    assert entries[0].seq == 3  # le plus récent d'abord
    assert entries[-1].prev_hash == "0" * 64


def test_tampered_field_detected(conn):
    log = AuditLog(conn)
    _fill(log)
    conn.execute("UPDATE audit SET outcome = 'ok' WHERE seq = 2")
    result = log.verify()
    assert not result.ok and result.broken_at == 2


def test_deleted_entry_detected(conn):
    log = AuditLog(conn)
    _fill(log)
    conn.execute("DELETE FROM audit WHERE seq = 2")
    result = log.verify()
    assert not result.ok and result.broken_at == 3


def test_chain_continues_after_reopen(tmp_path):
    log = AuditLog(open_db(tmp_path / "agent.db"))
    _fill(log)
    log2 = AuditLog(open_db(tmp_path / "agent.db"))
    log2.record(channel="cli", op="token.create", token_id=None, client_ip=None, outcome="ok")
    assert log2.verify().ok


def test_sensitive_params_masked(conn):
    log = AuditLog(conn)
    entry = log.record(
        channel="rest",
        op="x",
        token_id=None,
        client_ip=None,
        outcome="ok",
        params={"password": "hunter2", "otp_code": "123456", "limit": 5, "api_token": "t"},
    )
    assert entry.params == {"password": "***", "otp_code": "***", "limit": 5, "api_token": "***"}
    assert "hunter2" not in "\n".join(conn.iterdump())


def test_incremental_verify_uses_checkpoint(conn):
    log = AuditLog(conn)
    _fill(log)
    assert log.verify(incremental=True).checked == 3
    log.record(channel="cli", op="x", token_id=None, client_ip=None, outcome="ok")
    result = log.verify(incremental=True)
    assert result.ok and result.checked == 1
    conn.execute("UPDATE audit SET hash = 'f' WHERE seq = 4")
    assert not log.verify(incremental=True).ok
    assert not log.verify().ok


def test_two_connections_do_not_collide(tmp_path):
    a = AuditLog(open_db(tmp_path / "agent.db"))
    b = AuditLog(open_db(tmp_path / "agent.db"))
    for i in range(20):
        (a if i % 2 else b).record(
            channel="cli", op="x", token_id=None, client_ip=None, outcome="ok"
        )
    assert a.verify().ok and a.verify().checked == 20
