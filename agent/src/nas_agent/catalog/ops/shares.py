"""Dossiers partagés : chiffrement, corbeille, taille, instantanés et leur planification."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, Each, OpContext, Operation
from nas_agent.catalog.ops._util import (
    VERIFIED_DS420P_DSM741,
    as_bool,
    as_int,
    as_list,
    as_map,
    as_str,
)

SHARE_LIST = DsmCall(
    "SYNO.Core.Share",
    "list",
    1,
    params={"additional": '["encryption","recyclebin","share_quota","hidden","is_aclmode"]'},
)
# Dossier par dossier, comme le Panneau de configuration : instantanés en version 2, sans les
# instantanés cachés. Facultatifs : un dossier sur ext4 ou sur USB n'en a pas.
_EACH_SHARE = Each(source=SHARE_LIST.key, items="shares", key="name", limit=64, as_json=True)
SNAPSHOT_LIST = DsmCall(
    "SYNO.Core.Share.Snapshot",
    "list",
    2,
    params={
        "offset": 0,
        "limit": -1,
        "filter": '{"attr":["!hide==true"]}',
        "additional": '["desc","lock","schedule_snapshot"]',
    },
    each=_EACH_SHARE,
    optional=True,
)
SNAPSHOT_SCHEDULE = DsmCall(
    "SYNO.Core.Share.Snapshot", "get_schedule", 1, each=_EACH_SHARE, optional=True
)

# « GMT+01-2026.11.09-07.40.22 » : nom d'un instantané, avec le décalage horaire du NAS.
_SNAP_TIME = re.compile(
    r"^GMT([+-])(\d{1,2})(?::?(\d{2}))?-(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$"
)


def snapshot_time(text: str | None) -> datetime | None:
    match = _SNAP_TIME.match(text or "")
    if not match:
        return None
    sign, hours, minutes, *parts = match.groups()
    offset = timedelta(hours=int(hours), minutes=int(minutes or 0))
    try:
        return datetime(
            *(int(p) for p in parts), tzinfo=timezone(-offset if sign == "-" else offset)
        )
    except ValueError:
        return None


def _next_run(text: str | None) -> str | None:
    """« 2026-11-10 03:00 », heure locale du NAS, sans décalage connu."""
    try:
        return datetime.strptime(text or "", "%Y-%m-%d %H:%M").isoformat()
    except ValueError:
        return None


class ShareSnapshots(BaseModel):
    supported: bool = Field(description="DSM answered; false on a volume without snapshots.")
    count: int | None
    locked: int | None = Field(description="Locked snapshots, never deleted automatically.")
    oldest_at: datetime | None
    latest_at: datetime | None
    scheduled: bool | None = Field(description="Scheduled snapshots.")
    next_scheduled_at: str | None = Field(description="Next scheduled snapshot, NAS local time.")


class Share(BaseModel):
    name: str | None
    volume: str | None
    description: str | None
    encrypted: bool | None
    hidden: bool | None
    usb: bool | None
    recycle_bin: bool | None
    recycle_bin_admins_only: bool | None
    used_mib: float | None
    quota_mib: float | None = Field(description="Quota; missing: no quota.")
    snapshots: ShareSnapshots | None = Field(
        description="Missing: not read (beyond 64 folders, or an unexpected name)."
    )


class SharesSummary(BaseModel):
    total: int
    encrypted: int
    with_recycle_bin: int
    with_snapshots: int
    with_snapshot_schedule: int


class SharesList(BaseModel):
    summary: SharesSummary
    shares: list[Share]


def _mib(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return round(float(value), 2)


def _snapshots(name: str | None, lists, schedules) -> ShareSnapshots | None:
    if name is None or name not in lists:
        return None
    listing = lists[name]
    schedule = as_map(schedules.get(name))
    if listing is None:
        return ShareSnapshots(
            supported=False,
            count=None,
            locked=None,
            oldest_at=None,
            latest_at=None,
            scheduled=as_bool(schedule.get("enable_snapshot_schedule")),
            next_scheduled_at=None,
        )
    snaps = as_list(as_map(listing).get("snapshots"))
    times = [t for t in (snapshot_time(as_str(as_map(s).get("time"))) for s in snaps) if t]
    return ShareSnapshots(
        supported=True,
        count=len(snaps),
        locked=sum(as_bool(as_map(s).get("lock")) is True for s in snaps),
        oldest_at=min(times, default=None),
        latest_at=max(times, default=None),
        scheduled=as_bool(schedule.get("enable_snapshot_schedule")),
        next_scheduled_at=_next_run(
            as_str(as_map(schedule.get("schedule")).get("next_trigger_time"))
        ),
    )


def _share(item, lists, schedules) -> Share:
    m = as_map(item)
    name = m.get("name") if isinstance(m.get("name"), str) else None
    quota = _mib(m.get("quota_value"))
    encryption = as_int(m.get("encryption"))
    return Share(
        name=name,
        volume=as_str(m.get("vol_path")),
        description=as_str(m.get("desc")),
        encrypted=None if encryption is None else encryption != 0,
        hidden=as_bool(m.get("hidden")),
        usb=as_bool(m.get("is_usb_share")),
        recycle_bin=as_bool(m.get("enable_recycle_bin")),
        recycle_bin_admins_only=as_bool(m.get("recycle_bin_admin_only")),
        used_mib=_mib(m.get("share_quota_used")),
        quota_mib=quota or None,
        snapshots=_snapshots(name, lists, schedules),
    )


def _shares(_ctx: OpContext, responses) -> SharesList:
    lists = as_map(responses[SNAPSHOT_LIST.key])
    schedules = as_map(responses[SNAPSHOT_SCHEDULE.key])
    shares = [
        _share(s, lists, schedules)
        for s in as_list(as_map(responses[SHARE_LIST.key]).get("shares"))
    ]
    snaps = [s.snapshots for s in shares if s.snapshots is not None]
    return SharesList(
        summary=SharesSummary(
            total=len(shares),
            encrypted=sum(bool(s.encrypted) for s in shares),
            with_recycle_bin=sum(bool(s.recycle_bin) for s in shares),
            with_snapshots=sum(bool(s.count) for s in snaps),
            with_snapshot_schedule=sum(bool(s.scheduled) for s in snaps),
        ),
        shares=shares,
    )


OPERATIONS = [
    Operation(
        id="shares.list",
        title="Shared folders",
        description="Shared folders: volume, encryption, recycle bin, used size and quota, "
        "snapshots (count, locked, oldest and newest) and their schedule.",
        kind="read",
        scope="storage:read",
        path="/shares",
        result_model=SharesList,
        transform=_shares,
        calls=(SHARE_LIST, SNAPSHOT_LIST, SNAPSHOT_SCHEDULE),
        cache_ttl=300,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
