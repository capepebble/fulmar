"""Réglages de sécurité et Security Advisor."""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import VERIFIED_DS420P_DSM741, as_bool, as_int, as_map, as_str

# Versions qu'emploie le Panneau de configuration de DSM.
FIREWALL = DsmCall("SYNO.Core.Security.Firewall", "get", 1)
AUTO_BLOCK = DsmCall("SYNO.Core.Security.AutoBlock", "get", 1)
SMART_BLOCK = DsmCall("SYNO.Core.SmartBlock", "get", 1)
OTP_ENFORCE = DsmCall("SYNO.Core.OTP.EnforcePolicy", "get", 1)
TERMINAL = DsmCall("SYNO.Core.Terminal", "get", 3)
# Pas de `get` en version 3.
QUICKCONNECT = DsmCall("SYNO.Core.QuickConnect", "get", 2)
QUICKCONNECT_STATUS = DsmCall("SYNO.Core.QuickConnect", "status", 1)
DSM_SECURITY = DsmCall("SYNO.Core.Security.DSM", "get", 6)
# Ajouts du 2026-11-26 (Utilisateur et groupe, Avancé) : facultatifs, un DSM plus ancien les
# refuse sans faire échouer le reste.
PASSWORD_POLICY = DsmCall("SYNO.Core.User.PasswordPolicy", "get", 1, optional=True)
PASSWORD_EXPIRY = DsmCall("SYNO.Core.User.PasswordExpiry", "get", 1, optional=True)


class Firewall(BaseModel):
    enabled: bool | None
    profile: str | None


class AutoBlock(BaseModel):
    enabled: bool | None
    attempts: int | None = Field(description="Failed sign-ins before the address is blocked.")
    within_minutes: int | None
    block_days: int | None = Field(description="Block duration; 0: forever.")


class Ssh(BaseModel):
    enabled: bool | None
    port: int | None


class QuickConnect(BaseModel):
    enabled: bool | None
    status: str | None = Field(description='State as DSM records it ("not_running").')


class Session(BaseModel):
    timeout_minutes: int | None = Field(description="Sign-out after inactivity.")
    csrf_protection: bool | None


class PasswordPolicy(BaseModel):
    min_length: int | None = Field(description="Minimum length; 0 when none is required.")
    mixed_case: bool | None
    numbers: bool | None
    special_chars: bool | None
    exclude_common: bool | None = Field(description="Common passwords refused.")
    exclude_username: bool | None


class SecuritySettings(BaseModel):
    firewall: Firewall
    auto_block: AutoBlock
    account_protection_enabled: bool | None = Field(
        description="Account protection (an account is blocked after repeated failures)."
    )
    two_factor_enforced: str | None = Field(
        description='Enforced two-factor authentication, as DSM records it: "none" (nobody), '
        '"admin" (administrators), "user" (everyone), "custom" (chosen '
        "accounts)."
    )
    ssh: Ssh
    telnet_enabled: bool | None
    quickconnect: QuickConnect = Field(description="Without the NAS's QuickConnect ID.")
    session: Session
    password_policy: PasswordPolicy | None = Field(
        description="Password strength rules for local accounts; missing when unreadable."
    )
    password_expiry_enabled: bool | None


def _settings(_ctx: OpContext, responses) -> SecuritySettings:
    def get(call: DsmCall):
        return as_map(responses[call.key])

    fw, block, term, dsm = get(FIREWALL), get(AUTO_BLOCK), get(TERMINAL), get(DSM_SECURITY)
    return SecuritySettings(
        firewall=Firewall(
            enabled=as_bool(fw.get("enable_firewall")), profile=as_str(fw.get("profile_name"))
        ),
        auto_block=AutoBlock(
            enabled=as_bool(block.get("enable")),
            attempts=as_int(block.get("attempts")),
            within_minutes=as_int(block.get("within_mins")),
            block_days=as_int(block.get("expire_day")),
        ),
        account_protection_enabled=as_bool(get(SMART_BLOCK).get("enabled")),
        two_factor_enforced=as_str(get(OTP_ENFORCE).get("otp_enforce_option")),
        ssh=Ssh(enabled=as_bool(term.get("enable_ssh")), port=as_int(term.get("ssh_port"))),
        telnet_enabled=as_bool(term.get("enable_telnet")),
        quickconnect=QuickConnect(
            enabled=as_bool(get(QUICKCONNECT).get("enabled")),
            status=as_str(get(QUICKCONNECT_STATUS).get("status")),
        ),
        session=Session(
            timeout_minutes=as_int(dsm.get("timeout")),
            csrf_protection=as_bool(dsm.get("enable_csrf_protection")),
        ),
        password_policy=_policy(responses.get(PASSWORD_POLICY.key)),
        password_expiry_enabled=as_bool(
            as_map(responses.get(PASSWORD_EXPIRY.key)).get("password_expire_enable")
        ),
    )


def _policy(raw) -> PasswordPolicy | None:
    if raw is None:
        return None
    strong = as_map(as_map(raw).get("strong_password"))
    return PasswordPolicy(
        min_length=(as_int(strong.get("min_length")) or 0)
        if as_bool(strong.get("min_length_enable"))
        else 0,
        mixed_case=as_bool(strong.get("mixed_case")),
        numbers=as_bool(strong.get("included_numeric_char")),
        special_chars=as_bool(strong.get("included_special_char")),
        exclude_common=as_bool(strong.get("exclude_common_password")),
        exclude_username=as_bool(strong.get("exclude_username")),
    )


# Security Advisor : appels et versions de son interface.
ADVISOR_CONF = DsmCall("SYNO.Core.SecurityScan.Conf", "get", 1)
ADVISOR_STATUS = DsmCall("SYNO.Core.SecurityScan.Status", "system_get", 1)
ADVISOR_RULES = DsmCall("SYNO.Core.SecurityScan.Status", "rule_get", 1, params={"items": "ALL"})

# Noms stables des catégories de DSM, dans l'ordre de l'interface.
_CATEGORIES = {
    "malware": "malware",
    "network": "network",
    "systemCheck": "system",
    "update": "updates",
    "userInfo": "accounts",
}
# Gravités, de la plus haute à la plus basse (ordre de l'interface).
_SEVERITIES = {
    "danger": "danger",
    "risk": "risk",
    "warning": "warning",
    "outOfDate": "out_of_date",
    "info": "info",
}


class AdvisorSchedule(BaseModel):
    enabled: bool | None
    week_day: str | None = Field(description="Day as DSM records it.")
    hour: int | None
    minute: int | None


class AdvisorCategory(BaseModel):
    category: str = Field(description="malware, network, system, updates or accounts.")
    status: str | None = Field(
        description='Worst severity found: "safe", "info", "out_of_date", "warning", '
        '"risk" or "danger".'
    )
    rules: int | None = Field(description="Rules checked in this category.")
    failed: dict[str, int] = Field(description="Failed rules, by severity.")


class FailedRule(BaseModel):
    id: str = Field(description='Synology\'s rule identifier ("ruleDB.…").')
    category: str
    severity: str | None


class AdvisorSummary(BaseModel):
    rules: int = Field(description="Rules of the chosen group, checked or not applicable.")
    passed: int
    failed: int
    skipped: int = Field(description="Not applicable to this NAS (service missing).")
    errors: int


class SecurityAdvisor(BaseModel):
    status: str | None = Field(
        description='Overall state as DSM records it: "safe", "info", "outOfDate", '
        '"warning", "risk", "danger", or "firstScan" before the first scan.'
    )
    scanning: bool
    last_scan_at: datetime | None
    group: str | None = Field(
        description='Rule group: "home", "company" or "custom" (chosen by hand, sometimes '
        "very few: see summary.rules)."
    )
    schedule: AdvisorSchedule
    summary: AdvisorSummary
    categories: list[AdvisorCategory]
    failed_rules: list[FailedRule] = Field(description="From most to least severe.")


def _category(name: str | None) -> str:
    return _CATEGORIES.get(name or "", name or "unknown")


def _severity(name: str | None) -> str | None:
    return _SEVERITIES.get(name or "", name)


def _epoch(value) -> datetime | None:
    seconds = as_int(value)
    return datetime.fromtimestamp(seconds, UTC) if seconds else None


def _advisor(_ctx: OpContext, responses) -> SecurityAdvisor:
    conf = as_map(responses[ADVISOR_CONF.key])
    status = as_map(responses[ADVISOR_STATUS.key])
    rules = as_map(responses[ADVISOR_RULES.key])
    items = as_map(rules.get("items"))
    order = list(_CATEGORIES)

    categories = []
    for name, raw in sorted(
        as_map(status.get("items")).items(),
        key=lambda kv: order.index(kv[0]) if kv[0] in order else len(order),
    ):
        cat = as_map(raw)
        fail = as_map(cat.get("fail"))
        categories.append(
            AdvisorCategory(
                category=_category(name),
                status=_severity(as_str(cat.get("failSeverity"))),
                rules=as_int(cat.get("total")),
                failed={v: as_int(fail.get(k)) or 0 for k, v in _SEVERITIES.items()},
            )
        )

    ranks = list(_SEVERITIES)
    failed = sorted(
        (as_map(r) for r in items.values() if as_map(r).get("status") == "fail"),
        key=lambda r: (
            ranks.index(r.get("severity")) if r.get("severity") in ranks else len(ranks),
            str(r.get("id")),
        ),
    )
    statuses = [as_map(r).get("status") for r in items.values()]
    progress = as_int(status.get("sysProgress"))
    return SecurityAdvisor(
        status=as_str(status.get("sysStatus")),
        scanning=bool(as_bool(rules.get("isUpdating")))
        or (progress is not None and progress < 100),
        last_scan_at=_epoch(status.get("lastScanTime")),
        group=as_str(conf.get("defaultGroup")),
        schedule=AdvisorSchedule(
            enabled=as_bool(conf.get("enableSchedule")),
            week_day=as_str(conf.get("weekday")),
            hour=as_int(conf.get("hour")),
            minute=as_int(conf.get("minute")),
        ),
        summary=AdvisorSummary(
            rules=len(statuses),
            passed=statuses.count("pass"),
            failed=statuses.count("fail"),
            skipped=statuses.count("skip"),
            errors=statuses.count("error"),
        ),
        categories=categories,
        failed_rules=[
            FailedRule(
                id=as_str(r.get("id")) or "?",
                category=_category(as_str(r.get("category"))),
                severity=_severity(as_str(r.get("severity"))),
            )
            for r in failed
        ],
    )


OPERATIONS = [
    Operation(
        id="security.advisor",
        title="Security Advisor",
        description="Latest Security Advisor scan: overall state, rule group and number of rules "
        "checked, result by category, failed rules from most to least severe, scan "
        "schedule.",
        kind="read",
        scope="security:read",
        path="/security/advisor",
        result_model=SecurityAdvisor,
        transform=_advisor,
        calls=(ADVISOR_CONF, ADVISOR_STATUS, ADVISOR_RULES),
        cache_ttl=300,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
    Operation(
        id="security.settings",
        title="Security settings",
        description="Firewall, automatic address blocking, account protection, enforced "
        "two-factor authentication, SSH and Telnet, QuickConnect, DSM session length, password "
        "policy and expiry.",
        kind="read",
        scope="security:read",
        path="/security/settings",
        result_model=SecuritySettings,
        transform=_settings,
        calls=(
            FIREWALL,
            AUTO_BLOCK,
            SMART_BLOCK,
            OTP_ENFORCE,
            TERMINAL,
            QUICKCONNECT,
            QUICKCONNECT_STATUS,
            DSM_SECURITY,
            PASSWORD_POLICY,
            PASSWORD_EXPIRY,
        ),
        cache_ttl=300,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
