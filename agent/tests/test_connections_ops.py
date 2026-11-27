import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, principal
from tests.real_nas import real

CONN = "SYNO.Core.CurrentConnection.get"


async def run(responses, audit, settings, *scopes, **params):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings, service_account="claude")
    p = principal(*(scopes or ("personal:read",)))
    env = await engine.run("connections.current", params, p, channel="rest", client_ip=None)
    return env.data, dsm


# Réponse réelle du NAS d'essai (DS420+, DSM 7.4.1), nettoyée : la forme qui fait foi.


async def test_connections_real_ds420p_dsm741(audit, settings):
    data, dsm = await run({CONN: real("current_connection")}, audit, settings)
    assert data["total"] == 2
    assert data["sessions"] == [
        {
            "account": "claude",
            "service": "DiskStation Manager",
            "protocol": "HTTP/HTTPS",
            "address": "192.0.2.1",
            "since": "2026-11-09T07:43:23",
            "client": None,
            "is_agent": True,
        },
        {
            "account": "utilisateur",
            "service": "DiskStation Manager",
            "protocol": "HTTP/HTTPS",
            "address": "192.0.2.1",
            "since": "2026-11-06T15:49:04",
            "client": None,
            "is_agent": False,
        },
    ]
    assert dsm.calls == [("SYNO.Core.CurrentConnection", "get", {})]


async def test_connections_shape_tolerates_odd_items(audit, settings):
    odd = {"items": [{"who": "jeanne", "type": "SMB3", "user_agent": "macOS"}, "x", None]}
    data, _ = await run({CONN: odd}, audit, settings)
    assert data["total"] == 1
    assert data["sessions"] == [
        {
            "account": "jeanne",
            "service": None,
            "protocol": "SMB3",
            "address": None,
            "since": None,
            "client": "macOS",
            "is_agent": False,
        }
    ]


async def test_connections_need_personal_read(audit, settings):
    with pytest.raises(OpError) as info:
        await run({CONN: {}}, audit, settings, "system:read", "security:read", "audit:checks")
    assert info.value.status == 403


async def test_connections_take_no_params(audit, settings):
    with pytest.raises(OpError) as info:
        await run({CONN: {}}, audit, settings, limit=3)
    assert info.value.status == 422


def test_connections_scope_and_verification():
    op = build_catalog().get("connections.current")
    assert op.scope == "personal:read" and op.personal is True and op.kind == "read"
    assert op.path == "/connections"
    assert op.verified_on
