"""Fermer un accès resté ouvert, jamais l'ouvrir (conception 2026-11-26-fermer-acces).

Les seuls appels qui écrivent : `SYNO.Core.Terminal` `set` en version 3, avec le seul champ de
l'accès à fermer, toujours « false » (DSM n'applique que les champs reçus : vérifié sur le NAS
d'essai, Telnet fermé seul, SSH resté ouvert). Le gardien (`nas_agent.access_guard`) et
l'opération `access.close` n'en ont pas d'autres.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation, OpRefused

SERVICES = ("ssh", "telnet")
Service = Literal["ssh", "telnet"]

TERMINAL_GET = DsmCall("SYNO.Core.Terminal", "get", 3)
CLOSE: dict[str, DsmCall] = {
    s: DsmCall("SYNO.Core.Terminal", "set", 3, params={f"enable_{s}": "false"}) for s in SERVICES
}


def _close_params(p: BaseModel | None) -> dict[str, str]:
    service = getattr(p, "service", None)
    if service not in CLOSE:
        raise ValueError("unknown access")
    return dict(CLOSE[service].params)  # type: ignore[arg-type]


# L'appel de l'opération : celui de l'accès demandé, pris tel quel dans CLOSE.
CLOSE_REQUESTED = DsmCall("SYNO.Core.Terminal", "set", 3, params=_close_params)


class PolicyOut(BaseModel):
    mode: Literal["off", "remind", "close"] = Field(
        description='"off": nothing; "remind": alert at the deadline; "close": alert 10 '
        "minutes before, then close."
    )
    minutes: int


class ServiceWatch(BaseModel):
    service: Service
    open: bool | None = Field(description="Open in DSM; null before the first read.")
    open_since: str | None = Field(description="When the agent first saw it open (UTC).")
    deadline: str | None = Field(description="When the rule applies (UTC).")
    closed_at: str | None = Field(description="When Fulmar closed it (UTC).")
    checked_at: str | None
    policy: PolicyOut


class AccessWatch(BaseModel):
    watching: bool = Field(description="The agent's guard runs (nas-agent serve).")
    can_act: bool = Field(description="This token may close, extend and set rules (access:close).")
    services: list[ServiceWatch]


class ServiceParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    service: Service


class ExtendParams(ServiceParams):
    minutes: int = Field(60, ge=15, le=480)


class PolicyParams(ServiceParams):
    mode: Literal["off", "remind", "close"]
    minutes: int = Field(60, ge=15, le=1440)


def _empty(service: str) -> ServiceWatch:
    return ServiceWatch(
        service=service,  # type: ignore[arg-type]
        open=None,
        open_since=None,
        deadline=None,
        closed_at=None,
        checked_at=None,
        policy=PolicyOut(mode="off", minutes=60),
    )


def _watch(ctx: OpContext, _responses) -> AccessWatch:
    guard = ctx.guard
    services = (
        [ServiceWatch(**w) for w in guard.snapshot()]
        if guard is not None
        else [_empty(s) for s in SERVICES]
    )
    return AccessWatch(
        watching=guard is not None,
        can_act="access:close" in ctx.principal.scopes,
        services=services,
    )


def _guard(ctx: OpContext):
    if ctx.guard is None:
        raise OpRefused("not_configured", 409, "The access guard is not running.")
    return ctx.guard


def _close(ctx: OpContext, _responses) -> ServiceWatch:
    service = ctx.params.service  # type: ignore[union-attr]
    if ctx.guard is None:
        return _empty(service).model_copy(update={"open": False})
    return ServiceWatch(**ctx.guard.closed_by_request(service))


def _extend(ctx: OpContext, _responses) -> ServiceWatch:
    p = ctx.params
    try:
        return ServiceWatch(**_guard(ctx).extend(p.service, p.minutes))  # type: ignore[union-attr]
    except ValueError:
        raise OpRefused(
            "no_deadline", 409, "This access is closed or has no rule with a deadline."
        ) from None


def _policy(ctx: OpContext, _responses) -> ServiceWatch:
    p = ctx.params
    return ServiceWatch(**_guard(ctx).set_policy(p.service, p.mode, p.minutes))  # type: ignore[union-attr]


OPERATIONS = [
    Operation(
        id="access.watch",
        title="Access: open doors and their deadline",
        description=(
            "SSH and Telnet: open or closed, open since when, the rule chosen (nothing, remind, "
            "close), its deadline, and when Fulmar closed them. Fulmar can close them, never open "
            "them."
        ),
        kind="read",
        scope="security:read",
        path="/access/watch",
        result_model=AccessWatch,
        transform=_watch,
        cache_ttl=0,
    ),
    Operation(
        id="access.close",
        title="Access: close now",
        description=(
            "Close SSH or Telnet in DSM now (Control Panel, Terminal & SNMP). Closing SSH cuts the "
            "open sessions. This operation can only close."
        ),
        kind="action",
        scope="access:close",
        path="/access/close",
        result_model=ServiceWatch,
        transform=_close,
        calls=(CLOSE_REQUESTED,),
        params_model=ServiceParams,
        cache_ttl=0,
    ),
    Operation(
        id="access.extend",
        title="Access: push the deadline back",
        description="Push back the deadline of an open access, by 15 minutes to 8 hours.",
        kind="action",
        scope="access:close",
        path="/access/extend",
        result_model=ServiceWatch,
        transform=_extend,
        params_model=ExtendParams,
        cache_ttl=0,
    ),
    Operation(
        id="access.policy",
        title="Access: rule",
        description=(
            "The rule of an access: off, remind after a while, or close after a while (15 minutes "
            "to 24 hours). Set on an access already open, the deadline starts now."
        ),
        kind="action",
        scope="access:close",
        path="/access/policy",
        result_model=ServiceWatch,
        transform=_policy,
        params_model=PolicyParams,
        cache_ttl=0,
    ),
]
