from contextlib import asynccontextmanager

import httpx
import pytest

from nas_agent.api import create_app
from nas_agent.auth import Authenticator
from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine
from nas_agent.mcp_server import McpEndpoint
from tests.conftest import FakeDsm, load_fixture

ACCEPT = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "1"},
    },
}


@pytest.fixture
def stack(settings, audit, tokens):
    catalog = build_catalog()
    engine = Engine(
        catalog, FakeDsm({"SYNO.DSM.Info.getinfo": load_fixture("dsm_info")}), audit, settings
    )
    auth = Authenticator(tokens, audit, settings.limits)
    endpoint = McpEndpoint(engine, catalog, auth, settings)
    return create_app(settings, engine, catalog, auth, mcp_app=endpoint), endpoint


@asynccontextmanager
async def client(stack, host="127.0.0.1:8765"):
    # Le gestionnaire MCP doit tourner dans la tâche du test (groupe de tâches anyio).
    app, endpoint = stack
    async with endpoint.run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=f"http://{host}") as c:
            yield c


def headers(tokens, *scopes):
    _, raw = tokens.create("mcp", scopes or ["system:read"])
    return {**ACCEPT, "Authorization": f"Bearer {raw}"}


async def rpc(c, h, method, params=None, id_=2):
    body = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        body["params"] = params
    r = await c.post("/mcp", headers=h, json=body)
    assert r.status_code == 200, r.text
    return r.json()["result"]


async def test_tools_filtered_by_scope(stack, tokens):
    h = headers(tokens, "system:read")
    async with client(stack) as c:
        assert (await rpc(c, h, "initialize", INIT["params"], 1))["serverInfo"][
            "name"
        ] == "nas-agent"
        tools = {t["name"]: t for t in (await rpc(c, h, "tools/list"))["tools"]}
    assert "system_info" in tools and "agent_audit" not in tools
    assert "storage_overview" not in tools
    assert tools["system_info"]["annotations"]["readOnlyHint"] is True
    assert tools["system_info"]["outputSchema"]["type"] == "object"


async def test_call_returns_structured_content(stack, tokens):
    h = headers(tokens, "system:read")
    async with client(stack) as c:
        result = await rpc(c, h, "tools/call", {"name": "system_info", "arguments": {}})
    assert result["isError"] is False
    assert result["structuredContent"]["data"]["model"] == "DS918+"


async def test_forbidden_tool_is_tool_error(stack, tokens, audit):
    h = headers(tokens, "system:read")
    async with client(stack) as c:
        result = await rpc(c, h, "tools/call", {"name": "storage_overview", "arguments": {}})
    assert result["isError"] is True and result["content"][0]["text"].startswith(
        "forbidden: This token lacks"
    )
    assert audit.tail()[0].channel == "mcp" and audit.tail()[0].code == "forbidden"


async def test_no_token_is_401(stack):
    async with client(stack) as c:
        r = await c.post("/mcp", headers=ACCEPT, json=INIT)
    assert r.status_code == 401 and r.json()["code"] == "unauthorized"


async def test_foreign_host_refused(stack, tokens):
    h = headers(tokens)
    async with client(stack, host="evil.example.com") as c:
        r = await c.post("/mcp", headers=h, json=INIT)
    assert r.status_code in (400, 403, 421)


async def test_public_host_accepted(stack, tokens):
    h = headers(tokens)
    async with client(stack, host="nas-agent-test.example.ts.net") as c:
        r = await c.post("/mcp", headers=h, json=INIT)
    assert r.status_code == 200
