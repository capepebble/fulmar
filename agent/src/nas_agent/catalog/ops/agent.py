"""Opérations sur l'agent lui-même : version, journal."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from nas_agent import __version__
from nas_agent.catalog.model import OpContext, Operation


class AgentInfo(BaseModel):
    agent_version: str
    operations: list[str] = Field(description="Operations this token may call.")
    scopes: list[str] = Field(description="Scopes of this token.")


class AuditParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: int = Field(100, ge=1, le=500, description="Number of entries, most recent first.")


class AuditEntryOut(BaseModel):
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
    hash: str


class AuditTail(BaseModel):
    chain_ok: bool = Field(
        description="Hash chain intact (checked in full on the first call, then from the last "
        "checked entry; full check: nas-agent audit verify)."
    )
    checked: int = Field(description="Entries checked during this call.")
    entries: list[AuditEntryOut]


def _info(ctx: OpContext, _responses) -> AgentInfo:
    return AgentInfo(
        agent_version=__version__,
        operations=list(ctx.visible_ops),
        scopes=sorted(ctx.principal.scopes),
    )


def _audit_tail(ctx: OpContext, _responses) -> AuditTail:
    params = ctx.params if isinstance(ctx.params, AuditParams) else AuditParams()
    result = ctx.audit.verify(incremental=True)
    entries = [
        AuditEntryOut(**{k: getattr(e, k) for k in AuditEntryOut.model_fields})
        for e in ctx.audit.tail(params.limit)
    ]
    return AuditTail(chain_ok=result.ok, checked=result.checked, entries=entries)


OPERATIONS = [
    Operation(
        id="agent.info",
        title="Agent: version and scopes",
        description="Agent version, and the operations and scopes of the token in use.",
        kind="read",
        scope="system:read",
        path="/agent/info",
        result_model=AgentInfo,
        transform=_info,
        cache_ttl=0,
    ),
    Operation(
        id="agent.audit",
        title="Agent: call log",
        description=(
            "Latest entries of the agent's call log (who called what, when, with what outcome) "
            "and the state of its hash chain."
        ),
        kind="read",
        scope="audit:read",
        path="/agent/audit",
        result_model=AuditTail,
        transform=_audit_tail,
        params_model=AuditParams,
        cache_ttl=0,
    ),
]
