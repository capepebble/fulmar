"""Stockage : volumes, groupes de stockage, disques et leur santé."""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import (
    VERIFIED_DS420P_DSM741,
    as_bool,
    as_int,
    as_list,
    as_map,
    as_str,
    pct,
)

LOAD_INFO = DsmCall("SYNO.Storage.CGI.Storage", "load_info", 1)

HEALTHY = {"normal"}


class Volume(BaseModel):
    id: str | None
    path: str | None
    status: str | None
    fs_type: str | None
    raid: str | None
    pool_id: str | None
    size_total_bytes: int | None
    size_used_bytes: int | None
    used_pct: float | None


class Pool(BaseModel):
    id: str | None
    status: str | None
    raid: str | None
    disks: list[str]
    disk_failures: int | None
    redundant: bool | None = Field(
        description="Survives the loss of a disk; false for Basic, JBOD, RAID 0 and SHR without "
        "protection."
    )
    scrubbing_last_at: str | None = Field(description="Last data scrubbing, ISO 8601 UTC.")
    scrubbing_scheduled: bool | None


class Disk(BaseModel):
    id: str | None
    name: str | None
    model: str | None
    vendor: str | None
    serial: str | None
    firmware: str | None
    type: str | None
    size_bytes: int | None
    status: str | None
    smart_status: str | None
    temperature_c: int | None
    bad_sectors_exceeded: bool | None
    remaining_life_low: bool | None
    healthy: bool = Field(description='Status and SMART both "normal".')


class StorageSummary(BaseModel):
    disks_total: int
    disks_unhealthy: int
    volumes_total: int
    volumes_not_normal: int
    pools_not_normal: int


class StorageOverview(BaseModel):
    summary: StorageSummary
    volumes: list[Volume]
    pools: list[Pool]
    disks: list[Disk]
    scrubbing_schedule_enabled: bool | None = Field(
        description="Data scrubbing schedule turned on (Storage Manager)."
    )


def _disk(item) -> Disk:
    m = as_map(item)
    status, smart = as_str(m.get("status")), as_str(m.get("smart_status"))
    bad = as_bool(m.get("exceed_bad_sector_thr"))
    low = as_bool(m.get("below_remain_life_thr"))
    return Disk(
        id=as_str(m.get("id")),
        name=as_str(m.get("name")),
        model=as_str(m.get("model")),
        vendor=as_str(m.get("vendor")),
        serial=as_str(m.get("serial")),
        firmware=as_str(m.get("firm")),
        type=as_str(m.get("diskType")),
        size_bytes=as_int(m.get("size_total")),
        status=status,
        smart_status=smart,
        temperature_c=as_int(m.get("temp")),
        bad_sectors_exceeded=bad,
        remaining_life_low=low,
        healthy=status in HEALTHY and smart in HEALTHY and not bad and not low,
    )


def _volume(item) -> Volume:
    m = as_map(item)
    size = as_map(m.get("size"))
    total, used = as_int(size.get("total")), as_int(size.get("used"))
    return Volume(
        id=as_str(m.get("id")),
        path=as_str(m.get("vol_path")),
        status=as_str(m.get("status")),
        fs_type=as_str(m.get("fs_type")),
        raid=as_str(m.get("device_type")),
        pool_id=as_str(m.get("pool_path")),
        size_total_bytes=total,
        size_used_bytes=used,
        used_pct=pct(used, total),
    )


# Types de groupe du Gestionnaire de stockage (DSM 7.4) : sans redondance, un disque perdu
# emporte le volume.
_NOT_REDUNDANT = frozenset({"basic", "raid_0", "raid_linear", "shr_without_disk_protect"})
_REDUNDANT = frozenset(
    {
        "raid_1",
        "raid_5",
        "raid_6",
        "raid_10",
        "raid_f1",
        "shr_with_1_disk_protect",
        "shr_with_2_disk_protect",
        "shr_2",
    }
)


def _epoch(value) -> str | None:
    seconds = as_int(value)
    if not seconds or seconds < 0:
        return None
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _pool(item) -> Pool:
    m = as_map(item)
    raid = as_str(m.get("device_type"))
    return Pool(
        id=as_str(m.get("id")),
        status=as_str(m.get("status")),
        raid=raid,
        disks=[str(d) for d in as_list(m.get("disks"))],
        disk_failures=as_int(m.get("disk_failure_number")),
        redundant=True if raid in _REDUNDANT else False if raid in _NOT_REDUNDANT else None,
        scrubbing_last_at=_epoch(m.get("last_done_time")),
        scrubbing_scheduled=as_bool(m.get("is_scheduled")),
    )


def _overview(_ctx: OpContext, responses) -> StorageOverview:
    d = as_map(responses[LOAD_INFO.key])
    disks = [_disk(x) for x in as_list(d.get("disks"))]
    volumes = [_volume(x) for x in as_list(d.get("volumes"))]
    pools = [_pool(x) for x in as_list(d.get("storagePools"))]
    return StorageOverview(
        summary=StorageSummary(
            disks_total=len(disks),
            disks_unhealthy=sum(not x.healthy for x in disks),
            volumes_total=len(volumes),
            volumes_not_normal=sum(v.status not in HEALTHY for v in volumes),
            pools_not_normal=sum(p.status not in HEALTHY for p in pools),
        ),
        volumes=volumes,
        pools=pools,
        disks=disks,
        scrubbing_schedule_enabled=as_bool(
            as_map(as_map(d.get("env")).get("data_scrubbing")).get("sche_enabled")
        ),
    )


OPERATIONS = [
    Operation(
        id="storage.overview",
        title="Storage: volumes, pools and disks",
        description="State of the volumes (usage, file system, RAID), storage pools and disks "
        "(SMART, temperature, bad sectors, wear).",
        kind="read",
        scope="storage:read",
        path="/storage/overview",
        result_model=StorageOverview,
        transform=_overview,
        calls=(LOAD_INFO,),
        cache_ttl=60,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
