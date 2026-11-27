"""Paquets installés et mises à jour de DSM."""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import (
    VERIFIED_DS420P_DSM741,
    as_bool,
    as_int,
    as_list,
    as_map,
    as_str,
)
from nas_agent.catalog.ops.system import DSM_INFO

# Versions et paramètres du Centre de paquets de DSM.
PACKAGE_LIST = DsmCall(
    "SYNO.Core.Package",
    "list",
    2,
    # `dependent_packages` : les paquets dont dépend chacun ; les protections s'en servent.
    params={
        "additional": '["status","autoupdate","silent_upgrade","install_type","updated_at",'
        '"dependent_packages"]'
    },
)
# Le catalogue de Synology, tel que DSM le garde en cache : pas de rechargement forcé.
# Facultatif : sans accès à Internet, les paquets restent lisibles, mises à jour inconnues.
PACKAGE_CATALOG = DsmCall(
    "SYNO.Core.Package.Server",
    "list",
    2,
    params={"blforcereload": "false", "blloadothers": "false"},
    optional=True,
)
PACKAGE_SETTING = DsmCall("SYNO.Core.Package.Setting", "get", 1)


def version_key(version: str | None) -> tuple[int, ...] | None:
    """« 4.2.10-100 » -> (4, 2, 10, 100) : les versions de DSM se comparent nombre à nombre."""
    numbers = re.findall(r"\d+", version or "")
    return tuple(int(n) for n in numbers) if numbers else None


class Package(BaseModel):
    id: str | None
    name: str | None
    version: str | None
    status: str | None = Field(description='State as DSM records it ("running", "stop").')
    system: bool = Field(description="Package shipped with DSM.")
    available_version: str | None = Field(
        description="Latest version in Synology's catalog, betas excluded; unknown when missing."
    )
    update_available: bool | None
    security_update: bool | None = Field(
        description="The available version fixes a security flaw (according to Synology)."
    )


class PackagesSummary(BaseModel):
    total: int
    running: int
    updates_available: int
    security_updates: int


class PackagesList(BaseModel):
    summary: PackagesSummary
    catalog_available: bool = Field(
        description="Synology's catalog read; false: updates unknown (NAS without Internet access)."
    )
    auto_update_all: bool | None = Field(description="Automatic update of all packages.")
    auto_update_important: bool | None = Field(
        description="Automatic update of important versions only."
    )
    packages: list[Package]


def _latest(catalog) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for item in map(as_map, as_list(as_map(catalog).get("packages"))):
        pid, key = as_str(item.get("id")), version_key(as_str(item.get("version")))
        if not pid or key is None or as_bool(item.get("beta")):
            continue
        current = latest.get(pid)
        if current is None or key > version_key(as_str(current.get("version"))):
            latest[pid] = dict(item)
    return latest


def _package(item, latest) -> Package:
    m = as_map(item)
    extra = as_map(m.get("additional"))
    version = as_str(m.get("version"))
    offer = latest.get(as_str(m.get("id")) or "")
    available = as_str(offer.get("version")) if offer else None
    have, want = version_key(version), version_key(available)
    update = None if have is None or want is None else want > have
    return Package(
        id=as_str(m.get("id")),
        name=as_str(m.get("name")),
        version=version,
        status=as_str(extra.get("status")),
        system=as_str(extra.get("install_type")) == "system",
        available_version=available,
        update_available=update,
        security_update=None
        if update is None
        else update and bool(as_bool(offer.get("is_security_version"))),
    )


def _packages(_ctx: OpContext, responses) -> PackagesList:
    catalog = responses[PACKAGE_CATALOG.key]
    latest = _latest(catalog)
    packages = [
        _package(p, latest) for p in as_list(as_map(responses[PACKAGE_LIST.key]).get("packages"))
    ]
    setting = as_map(responses[PACKAGE_SETTING.key])
    return PackagesList(
        summary=PackagesSummary(
            total=len(packages),
            running=sum(p.status == "running" for p in packages),
            updates_available=sum(bool(p.update_available) for p in packages),
            security_updates=sum(bool(p.security_update) for p in packages),
        ),
        catalog_available=catalog is not None,
        auto_update_all=as_bool(setting.get("autoupdateall")),
        auto_update_important=as_bool(setting.get("autoupdateimportant")),
        packages=packages,
    )


# Version et paramètres de la page « Mise à jour et restauration », sans `user_reading` :
# l'agent ne marque pas la mise à jour comme vue.
UPDATE_CHECK = DsmCall(
    "SYNO.Core.Upgrade.Server",
    "check",
    3,
    params={"need_auto_smallupdate": "true", "need_promotion": "true"},
)
UPDATE_SETTING = DsmCall("SYNO.Core.Upgrade.Setting", "get", 4)
# Une mise à jour installée qui attend un redémarrage ; facultatif.
NEED_REBOOT = DsmCall("SYNO.Core.Hardware.NeedReboot", "get", 1, optional=True)


class UpdateSchedule(BaseModel):
    week_day: str | None = Field(description="Day as DSM records it.")
    hour: int | None
    minute: int | None


class DsmUpdate(BaseModel):
    current_version: str | None
    check_ok: bool | None = Field(description="DSM could reach Synology.")
    update_available: bool | None = Field(description="Update within the same major version.")
    update_version: str | None
    major_upgrade_available: bool | None = Field(description="New major version of DSM.")
    major_upgrade_version: str | None
    auto_update: str | None = Field(
        description='Setting as DSM records it: "hotfix-security" (security fixes installed '
        'automatically), "hotfix" (important fixes), "notify" (notify only).'
    )
    schedule: UpdateSchedule
    reboot_pending: bool | None = Field(description="An installed update waits for a restart.")


def _dsm_update(_ctx: OpContext, responses) -> DsmUpdate:
    check = as_map(responses[UPDATE_CHECK.key])
    update, promotion = as_map(check.get("update")), as_map(check.get("promotion"))
    setting = as_map(responses[UPDATE_SETTING.key])
    schedule = as_map(setting.get("schedule"))
    rss = as_str(update.get("rss_result"))
    return DsmUpdate(
        current_version=as_str(as_map(responses[DSM_INFO.key]).get("version_string")),
        check_ok=None if rss is None else rss == "success",
        update_available=as_bool(update.get("available")),
        update_version=as_str(update.get("version")),
        major_upgrade_available=as_bool(promotion.get("available")),
        major_upgrade_version=as_str(promotion.get("version")),
        auto_update=as_str(setting.get("autoupdate_type")),
        schedule=UpdateSchedule(
            week_day=as_str(schedule.get("week_day")),
            hour=as_int(schedule.get("hour")),
            minute=as_int(schedule.get("minute")),
        ),
        reboot_pending=as_bool(as_map(responses.get(NEED_REBOOT.key)).get("need_reboot")),
    )


OPERATIONS = [
    Operation(
        id="packages.list",
        title="Installed packages and updates",
        description="Installed packages, their state and version, compared with the latest "
        "version in Synology's catalog (betas excluded); security updates flagged, "
        "automatic update setting.",
        kind="read",
        scope="system:read",
        path="/packages",
        result_model=PackagesList,
        transform=_packages,
        calls=(PACKAGE_LIST, PACKAGE_CATALOG, PACKAGE_SETTING),
        cache_ttl=600,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
    Operation(
        id="dsm.update",
        title="DSM updates",
        description="Installed DSM version, available update or new major version, automatic "
        "update setting and schedule, restart pending after an update.",
        kind="read",
        scope="system:read",
        path="/dsm/update",
        result_model=DsmUpdate,
        transform=_dsm_update,
        calls=(UPDATE_CHECK, UPDATE_SETTING, DSM_INFO, NEED_REBOOT),
        cache_ttl=600,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
