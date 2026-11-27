"""Comptes locaux de DSM : administrateurs, comptes désactivés, double authentification."""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import VERIFIED_DS420P_DSM741, as_bool, as_list, as_map, as_str

# Paramètres de la page « Utilisateur » du Panneau de configuration, réduits au nécessaire :
# ni adresse de messagerie, ni description.
USER_LIST = DsmCall(
    "SYNO.Core.User",
    "list",
    1,
    params={"type": "local", "offset": 0, "limit": -1, "additional": '["expired","2fa_status"]'},
)
# Le nom du groupe part encodé en JSON, comme dans l'interface (sinon erreur 3201).
ADMIN_MEMBERS = DsmCall(
    "SYNO.Core.Group.Member",
    "list",
    1,
    params={"group": '"administrators"', "ingroup": "true", "offset": 0, "limit": -1},
)

_EXPIRY = re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})$")


class Account(BaseModel):
    name: str
    admin: bool = Field(description="Member of the administrators group.")
    disabled: bool | None
    expires_on: str | None = Field(description="Account expiry date, if it has one.")
    two_factor: bool | None = Field(description="Two-factor authentication enabled.")
    agent_account: bool = Field(description="DSM account of this agent.")


class AccountsSummary(BaseModel):
    total: int
    active: int
    active_admins: int
    admins_without_two_factor: int = Field(
        description="Active administrators without two-factor authentication, the agent's account "
        "excluded."
    )
    builtin_admin_enabled: bool | None = Field(description='Built-in "admin" account active.')
    guest_enabled: bool | None = Field(description='"guest" account active.')


class AccountsList(BaseModel):
    summary: AccountsSummary
    accounts: list[Account]


def _state(expired: str | None) -> tuple[bool | None, str | None]:
    if expired == "now":
        return True, None
    if expired == "normal":
        return False, None
    match = _EXPIRY.match(expired or "")
    if match:
        year, month, day = (int(g) for g in match.groups())
        return False, f"{year:04d}-{month:02d}-{day:02d}"
    return None, None


def _accounts(ctx: OpContext, responses) -> AccountsList:
    admins = {
        as_str(as_map(u).get("name"))
        for u in as_list(as_map(responses[ADMIN_MEMBERS.key]).get("users"))
    }
    accounts = []
    for item in as_list(as_map(responses[USER_LIST.key]).get("users")):
        m = as_map(item)
        name = as_str(m.get("name"))
        if name is None:
            continue
        disabled, expires_on = _state(as_str(m.get("expired")))
        accounts.append(
            Account(
                name=name,
                admin=name in admins,
                disabled=disabled,
                expires_on=expires_on,
                two_factor=as_bool(m.get("2fa_status")),
                agent_account=name == ctx.service_account,
            )
        )
    active = [a for a in accounts if a.disabled is False]
    by_name = {a.name: a for a in accounts}

    def enabled(name: str) -> bool | None:
        account = by_name.get(name)
        return None if account is None or account.disabled is None else not account.disabled

    return AccountsList(
        summary=AccountsSummary(
            total=len(accounts),
            active=len(active),
            active_admins=sum(a.admin for a in active),
            admins_without_two_factor=sum(
                a.admin and not a.agent_account and a.two_factor is not True for a in active
            ),
            builtin_admin_enabled=enabled("admin"),
            guest_enabled=enabled("guest"),
        ),
        accounts=accounts,
    )


OPERATIONS = [
    Operation(
        id="users.list",
        title="Accounts",
        description="Local DSM accounts: administrator or not, disabled or not, expiry date, "
        'two-factor authentication, the agent\'s account flagged; built-in "admin" '
        'and "guest" accounts, administrators without two-factor authentication '
        "counted. No email address or description.",
        kind="read",
        scope="personal:read",
        personal=True,
        path="/users",
        result_model=AccountsList,
        transform=_accounts,
        calls=(USER_LIST, ADMIN_MEMBERS),
        cache_ttl=300,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
