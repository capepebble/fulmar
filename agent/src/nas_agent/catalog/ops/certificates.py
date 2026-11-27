"""Certificats du NAS : émetteur, validité, services qui les emploient."""

from __future__ import annotations

import re
from datetime import UTC, datetime

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import VERIFIED_DS420P_DSM741, as_bool, as_list, as_map, as_str

# Version qu'emploie le Panneau de configuration.
CERT_LIST = DsmCall("SYNO.Core.Certificate.CRT", "list", 1)

EXPIRING_DAYS = 30
_MONTHS = ("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec").split()
# « Nov  6 11:56:52 2026 GMT », forme d'OpenSSL, indépendante de la langue du NAS.
_CERT_TIME = re.compile(r"^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT$")


def cert_time(text: str | None) -> datetime | None:
    match = _CERT_TIME.match(text or "")
    if not match or match.group(1) not in _MONTHS:
        return None
    month = _MONTHS.index(match.group(1)) + 1
    day, hour, minute, second, year = (int(g) for g in match.groups()[1:])
    try:
        return datetime(year, month, day, hour, minute, second, tzinfo=UTC)
    except ValueError:
        return None


class Certificate(BaseModel):
    id: str | None
    description: str | None
    common_name: str | None
    alt_names: list[str]
    issuer: str | None
    self_signed: bool = Field(
        description="Issued by the NAS itself (DSM's own authority): not trusted by browsers."
    )
    is_default: bool | None
    renewable: bool | None = Field(description="Renewed by DSM (Let's Encrypt).")
    broken: bool | None
    valid_from: datetime | None
    valid_until: datetime | None
    expires_in_days: int | None = Field(description="Whole days left; negative: expired.")
    expired: bool | None
    services: list[str] = Field(description="Services and packages that present this certificate.")


class CertificatesSummary(BaseModel):
    total: int
    expired: int
    expiring_within_30_days: int


class CertificatesList(BaseModel):
    summary: CertificatesSummary
    certificates: list[Certificate]


def _certificate(item, now: datetime) -> Certificate:
    m = as_map(item)
    subject, issuer = as_map(m.get("subject")), as_map(m.get("issuer"))
    until = cert_time(as_str(m.get("valid_till")))
    days = None if until is None else int((until - now).total_seconds() // 86400)
    own_ca = bool(as_map(m.get("self_signed_cacrt_info")))
    return Certificate(
        id=as_str(m.get("id")),
        description=as_str(m.get("desc")),
        common_name=as_str(subject.get("common_name")),
        alt_names=[s for s in map(as_str, as_list(subject.get("sub_alt_name"))) if s],
        issuer=as_str(issuer.get("common_name")),
        self_signed=own_ca or (bool(subject) and subject == issuer),
        is_default=as_bool(m.get("is_default")),
        renewable=as_bool(m.get("renewable")),
        broken=as_bool(m.get("is_broken")),
        valid_from=cert_time(as_str(m.get("valid_from"))),
        valid_until=until,
        expires_in_days=days,
        expired=None if until is None else until <= now,
        services=[
            s
            for s in (as_str(as_map(x).get("display_name")) for x in as_list(m.get("services")))
            if s
        ],
    )


def _certificates(ctx: OpContext, responses) -> CertificatesList:
    now = ctx.fetched_at or datetime.now(UTC)
    certs = [
        _certificate(c, now) for c in as_list(as_map(responses[CERT_LIST.key]).get("certificates"))
    ]
    return CertificatesList(
        summary=CertificatesSummary(
            total=len(certs),
            expired=sum(bool(c.expired) for c in certs),
            expiring_within_30_days=sum(
                not c.expired
                and c.expires_in_days is not None
                and c.expires_in_days < EXPIRING_DAYS
                for c in certs
            ),
        ),
        certificates=certs,
    )


OPERATIONS = [
    Operation(
        id="certificates.list",
        title="Certificates",
        description="NAS certificates: name, issuer, self-issued by the NAS, validity dates and "
        "days left, automatic renewal, services that present them; expired ones and "
        "those close to expiry (under 30 days) counted.",
        kind="read",
        scope="security:read",
        path="/certificates",
        result_model=CertificatesList,
        transform=_certificates,
        calls=(CERT_LIST,),
        cache_ttl=600,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
