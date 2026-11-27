"""Qui est connecté au NAS en ce moment (Moniteur de ressources, onglet Connexions)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import (
    VERIFIED_DS420P_DSM741,
    as_list,
    as_map,
    as_str,
    local_time,
)

CURRENT = DsmCall("SYNO.Core.CurrentConnection", "get", 1)


class Session(BaseModel):
    account: str | None = Field(description="Signed-in DSM account.")
    service: str | None = Field(description="Service in use, as DSM names it.")
    protocol: str | None = Field(description="Protocol: HTTP/HTTPS, SMB3, AFP, FTP, WebDAV…")
    address: str | None = Field(description="Address the connection comes from.")
    since: str | None = Field(description="Session start, NAS local time.")
    client: str | None = Field(description="Client software reported, when DSM knows it.")
    is_agent: bool = Field(description="Session of the agent's own account.")


class CurrentConnections(BaseModel):
    total: int = Field(description="Open sessions.")
    sessions: list[Session]


def _connections(ctx: OpContext, responses) -> CurrentConnections:
    sessions = []
    for item in as_list(as_map(responses[CURRENT.key]).get("items")):
        if not isinstance(item, dict):
            continue
        account = as_str(item.get("who"))
        sessions.append(
            Session(
                account=account,
                service=as_str(item.get("descr")),
                protocol=as_str(item.get("type")) or as_str(item.get("protocol")),
                address=as_str(item.get("from")),
                since=local_time(item.get("time")),
                client=as_str(item.get("user_agent")),
                is_agent=account is not None and account == ctx.service_account,
            )
        )
    return CurrentConnections(total=len(sessions), sessions=sessions)


OPERATIONS = [
    Operation(
        id="connections.current",
        title="Current connections",
        description="Who is connected to the NAS right now: account, service, protocol, address "
        "and start time of each session (DSM, SMB, AFP, FTP, WebDAV, API). The "
        "agent's own session is flagged.",
        kind="read",
        scope="personal:read",
        personal=True,
        path="/connections",
        result_model=CurrentConnections,
        transform=_connections,
        calls=(CURRENT,),
        cache_ttl=15,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
