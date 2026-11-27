"""Carte sur table : ce que Fulmar fait sur ce NAS, qui y accède, vers où il se connecte, et
comment l'en détacher (conception 2026-11-26-carte-sur-table).

`agent.access` ne rend jamais un secret (ni mot de passe, ni jeton) ni l'adresse d'un appelant ;
la liste des jetons et le journal entier vont à l'installateur (`agent:setup`) et au droit du
journal (`audit:read`), chacun des autres ne voit que son jeton et ses appels.
`agent.detach` est l'inverse de l'installation : droit `agent:setup`, que seul le jeton de la
console du projet reçoit.
"""

from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from functools import cache
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from nas_agent import __version__
from nas_agent.catalog.model import OpContext, Operation, OpRefused

# Les droits qui modifient DSM, et ceux qui modifient Fulmar lui-même.
DSM_WRITES = ("packages:update", "dsm:update", "access:close")
FULMAR_WRITES = ("devices:pair", "fleet:manage", "agent:setup")
# Voir tous les jetons et tous les appels : l'installateur (qui peut tous les révoquer) ou le
# droit du journal (agent.audit). Les autres ne voient que le leur.
SEE_ALL = ("agent:setup", "audit:read")
JOURNAL_LINES = 20


@cache
def _catalog_counts() -> tuple[dict[str, int], list[tuple[str, str, str]]]:
    from nas_agent.catalog.ops import build_catalog

    reads: Counter[str] = Counter()
    writes: list[tuple[str, str, str]] = []
    for op in build_catalog():
        if op.kind == "read" and op.scope not in (*DSM_WRITES, *FULMAR_WRITES):
            reads[op.scope] += 1
        elif op.kind == "action" and op.scope in DSM_WRITES:
            writes.append((op.id, op.scope, op.title))
    return dict(sorted(reads.items())), writes


class DsmLink(BaseModel):
    host: str = Field(description="DSM address the agent reads.")
    port: int
    tls_mode: str = Field(description='"pin" (certificate pinned) or "hostname".')
    account: str | None = Field(description="DSM account the agent signs in with.")


class WriteOp(BaseModel):
    op: str
    scope: str
    title: str


class TokenOut(BaseModel):
    id: str
    label: str
    scopes: list[str]
    networks: list[str] = Field(description="Networks the token is accepted from.")
    created_at: str
    expires_at: str
    last_used_at: str | None
    changes_dsm: bool = Field(description="Holds a right that changes DSM (updates).")


Why = Literal["synology_advisories", "phones_relay", "alert_ntfy", "alert_email", "alert_webhook"]


class Outbound(BaseModel):
    to: str = Field(description="Host outside the NAS.")
    why: Why


class JournalLine(BaseModel):
    ts: str
    channel: str
    op: str | None
    outcome: str
    token: str | None = Field(description="Name of the token, never its secret.")


class AccessReport(BaseModel):
    agent_version: str
    dsm: DsmLink
    reads: dict[str, int] = Field(description="Read operations, by scope.")
    writes: list[WriteOp] = Field(description="The only operations that change DSM.")
    tokens: list[TokenOut] = Field(
        description="Active tokens (neither revoked nor expired); only the caller's without "
        "agent:setup or audit:read."
    )
    tokens_others: int = Field(description="Active tokens not listed for this caller.")
    phones: int | None = Field(description="Paired phones; null without the relay module.")
    outbound: list[Outbound] = Field(description="Connections the agent opens outside the NAS.")
    fleet_members: int | None = Field(
        description="NAS added to this hub; null when this agent is not a hub."
    )
    can_detach: bool = Field(description="This token may detach the NAS (agent.detach).")
    journal_ok: bool = Field(description="The hash chain of the call log is intact.")
    journal_all: bool = Field(
        description="The journal shows every call; otherwise only the caller's own."
    )
    journal: list[JournalLine] = Field(description="Latest calls, most recent first.")


def _host(url: str | None) -> str | None:
    return urlsplit(url).hostname if url else None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _access(ctx: OpContext, _responses) -> AccessReport:
    reads, writes = _catalog_counts()
    sources = ctx.access
    tokens = sources.tokens.list() if sources is not None else []
    now = datetime.now(UTC)
    active = [t for t in tokens if t.revoked_at is None and t.expires_at > now]
    labels = {t.id: t.label for t in tokens}
    me = ctx.principal.token_id
    see_all = any(sc in ctx.principal.scopes for sc in SEE_ALL)
    shown = active if see_all else [t for t in active if t.id == me]
    entries = ctx.audit.tail(JOURNAL_LINES if see_all else 500)
    if not see_all:
        entries = [e for e in entries if e.token_id == me][:JOURNAL_LINES]
    s = ctx.settings
    outbound: list[Outbound] = []
    if s.synology.enabled:
        outbound.append(Outbound(to="www.synology.com", why="synology_advisories"))
    for host, why in (
        (_host(s.relay.url), "phones_relay"),
        (_host(s.notify.ntfy.url) if s.notify.ntfy else None, "alert_ntfy"),
        (s.notify.email.host if s.notify.email else None, "alert_email"),
        (_host(s.notify.webhook.url) if s.notify.webhook else None, "alert_webhook"),
    ):
        if host:
            outbound.append(Outbound(to=host, why=why))  # type: ignore[arg-type]
    verify = ctx.audit.verify(incremental=True)
    return AccessReport(
        agent_version=__version__,
        dsm=DsmLink(
            host=s.dsm.host,
            port=s.dsm.port,
            tls_mode=s.dsm.tls_mode,
            account=ctx.service_account,
        ),
        reads=reads,
        writes=[WriteOp(op=o, scope=sc, title=t) for o, sc, t in writes],
        tokens=[
            TokenOut(
                id=t.id,
                label=t.label,
                scopes=sorted(t.scopes),
                networks=list(t.cidrs),
                created_at=t.created_at.isoformat(),
                expires_at=t.expires_at.isoformat(),
                last_used_at=_iso(t.last_used_at),
                changes_dsm=any(sc in t.scopes for sc in DSM_WRITES),
            )
            for t in sorted(shown, key=lambda t: t.created_at)
        ],
        tokens_others=len(active) - len(shown),
        phones=len(ctx.relay.devices()) if ctx.relay is not None else None,
        outbound=outbound,
        fleet_members=sources.fleet_size() if sources is not None else None,
        can_detach="agent:setup" in ctx.principal.scopes
        and sources is not None
        and sources.detach is not None,
        journal_ok=verify.ok,
        journal_all=see_all,
        journal=[
            JournalLine(
                ts=e.ts,
                channel=e.channel,
                op=e.op,
                outcome=e.outcome,
                token=labels.get(e.token_id) if e.token_id else None,
            )
            for e in entries
        ],
    )


class Detached(BaseModel):
    phones_removed: int
    tokens_revoked: int
    credentials_removed: bool
    restarting: bool = Field(
        description="The agent stops now; restarted by Container Manager, it waits for a new "
        "installation."
    )


def _detach(ctx: OpContext, _responses) -> Detached:
    sources = ctx.access
    if sources is None or sources.detach is None:
        raise OpRefused("not_offered", 409, "This agent cannot be detached from here.")
    members = sources.fleet_size()
    if members:
        raise OpRefused(
            "fleet_not_empty",
            409,
            f"Remove the {members} NAS added to this hub first.",
        )
    result: dict[str, Any] = sources.detach(keep_token=ctx.principal.token_id)
    return Detached(**result)


OPERATIONS = [
    Operation(
        id="agent.access",
        title="Agent: everything on the table",
        description=(
            "What Fulmar does on this NAS: the DSM account it uses, what it reads, the only "
            "operations that change DSM, active tokens with their rights and last use, paired "
            "phones, connections outside the NAS, NAS added to this hub, latest calls. Never a "
            "secret nor a caller's address."
        ),
        kind="read",
        scope="system:read",
        path="/agent/access",
        result_model=AccessReport,
        transform=_access,
        cache_ttl=0,
    ),
    Operation(
        id="agent.detach",
        title="Agent: detach this NAS",
        description=(
            "Detach this NAS from Fulmar: remove the paired phones, revoke every token but the "
            "caller's, forget DSM's credentials, then stop; restarted, the agent waits for a "
            "new installation. Refused while NAS are added to this hub."
        ),
        kind="action",
        scope="agent:setup",
        path="/agent/detach",
        result_model=Detached,
        transform=_detach,
        cache_ttl=0,
    ),
]
