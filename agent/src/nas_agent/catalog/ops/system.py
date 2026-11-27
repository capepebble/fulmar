"""Système : identité du NAS, version de DSM, constantes instantanées."""

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
)

DSM_INFO = DsmCall("SYNO.DSM.Info", "getinfo", 2)
UTILIZATION = DsmCall("SYNO.Core.System.Utilization", "get", 1)
# Version qu'emploie le Centre d'infos ; seuls l'heure, le fuseau et NTP en sont lus.
SYSTEM_INFO = DsmCall("SYNO.Core.System", "info", 3)
# Synchronisation réelle avec le serveur NTP (Région, Heure) ; facultatif.
NTP_STATUS = DsmCall("SYNO.Core.Region.NTP", "status", 1, optional=True)

_SYSTEM_TIME = "%Y-%m-%d %H:%M:%S"
# Aucun fuseau ne dépasse 14 h d'écart avec UTC : au-delà, l'horloge du NAS est fausse.
_MAX_OFFSET_MIN = 14 * 60


class SystemInfo(BaseModel):
    model: str | None
    serial: str | None = Field(description="Serial number (inventory, warranty).")
    ram_mb: int | None
    dsm_version: str | None = Field(description='Readable version, e.g. "DSM 7.2.2-72806".')
    dsm_build: str | None
    uptime_s: int | None
    temperature_c: int | None
    temperature_warning: bool | None


def _system_info(_ctx: OpContext, responses) -> SystemInfo:
    d = as_map(responses[DSM_INFO.key])
    return SystemInfo(
        model=as_str(d.get("model")),
        serial=as_str(d.get("serial")),
        ram_mb=as_int(d.get("ram")),
        dsm_version=as_str(d.get("version_string")),
        dsm_build=as_str(d.get("version")),
        uptime_s=as_int(d.get("uptime")),
        temperature_c=as_int(d.get("temperature")),
        temperature_warning=as_bool(d.get("temperature_warn")),
    )


class SystemTime(BaseModel):
    time_zone: str | None = Field(description='Time zone as DSM records it ("Amsterdam").')
    time_zone_label: str | None
    local_time: str | None = Field(description="NAS local time at the time of reading (ISO 8601).")
    utc_offset_minutes: int | None = Field(
        description="Offset of the NAS local time from UTC at the time of reading, to the nearest "
        "quarter hour (daylight saving included); used to read the local times of "
        "Hyper Backup and the logs. Missing when the NAS clock is off by more than 14 "
        "hours."
    )
    ntp_enabled: bool | None = Field(description="Time synchronized with an NTP server.")
    ntp_server: str | None
    ntp_synced: bool | None = Field(description="Last synchronization with the NTP server worked.")


def utc_offset(local: datetime | None, read_at: datetime | None) -> int | None:
    """Écart en minutes entre l'heure locale lue sur le NAS et l'heure UTC de la lecture."""
    if local is None or read_at is None:
        return None
    seconds = (local - read_at.astimezone(UTC).replace(tzinfo=None)).total_seconds()
    minutes = round(seconds / 900) * 15
    return minutes if abs(minutes) <= _MAX_OFFSET_MIN else None


def _system_time(ctx: OpContext, responses) -> SystemTime:
    d = as_map(responses[SYSTEM_INFO.key])
    text = as_str(d.get("time"))
    try:
        local = datetime.strptime(text, _SYSTEM_TIME) if text else None
    except ValueError:
        local = None
    return SystemTime(
        time_zone=as_str(d.get("time_zone")),
        time_zone_label=as_str(d.get("time_zone_desc")),
        local_time=local.isoformat() if local else None,
        utc_offset_minutes=utc_offset(local, ctx.fetched_at),
        ntp_enabled=as_bool(d.get("enabled_ntp")),
        ntp_server=as_str(d.get("ntp_server")),
        ntp_synced=as_bool(as_map(responses.get(NTP_STATUS.key)).get("ntp_status")),
    )


class Cpu(BaseModel):
    total_pct: int | None = Field(description="Total load (user + system + other).")
    user_pct: int | None
    system_pct: int | None
    other_pct: int | None
    load_1m: float | None = Field(
        description="1-minute load average, as in /proc/loadavg (DSM gives it in hundredths)."
    )
    load_5m: float | None
    load_15m: float | None


class Memory(BaseModel):
    size_kb: int | None
    total_real_kb: int | None
    avail_real_kb: int | None
    cached_kb: int | None
    real_usage_pct: int | None
    swap_usage_pct: int | None


class NetworkRate(BaseModel):
    device: str | None
    rx_bps: int | None = Field(description="Bytes received per second.")
    tx_bps: int | None


class IoRate(BaseModel):
    device: str | None
    name: str | None
    utilization_pct: int | None
    read_bps: int | None
    write_bps: int | None


class Utilization(BaseModel):
    cpu: Cpu
    memory: Memory
    network: list[NetworkRate]
    disks: list[IoRate]
    volumes: list[IoRate]


def _io(item) -> IoRate:
    m = as_map(item)
    return IoRate(
        device=as_str(m.get("device")),
        name=as_str(m.get("display_name")),
        utilization_pct=as_int(m.get("utilization")),
        read_bps=as_int(m.get("read_byte")),
        write_bps=as_int(m.get("write_byte")),
    )


def _hundredths(value) -> float | None:
    n = as_int(value)
    return None if n is None else n / 100


def _utilization(_ctx: OpContext, responses) -> Utilization:
    d = as_map(responses[UTILIZATION.key])
    cpu, mem = as_map(d.get("cpu")), as_map(d.get("memory"))
    parts = [as_int(cpu.get(k)) for k in ("user_load", "system_load", "other_load")]
    return Utilization(
        cpu=Cpu(
            total_pct=sum(parts) if all(p is not None for p in parts) else None,
            user_pct=parts[0],
            system_pct=parts[1],
            other_pct=parts[2],
            load_1m=_hundredths(cpu.get("1min_load")),
            load_5m=_hundredths(cpu.get("5min_load")),
            load_15m=_hundredths(cpu.get("15min_load")),
        ),
        memory=Memory(
            size_kb=as_int(mem.get("memory_size")),
            total_real_kb=as_int(mem.get("total_real")),
            avail_real_kb=as_int(mem.get("avail_real")),
            cached_kb=as_int(mem.get("cached")),
            real_usage_pct=as_int(mem.get("real_usage")),
            swap_usage_pct=as_int(mem.get("swap_usage")),
        ),
        network=[
            NetworkRate(
                device=as_str(as_map(n).get("device")),
                rx_bps=as_int(as_map(n).get("rx")),
                tx_bps=as_int(as_map(n).get("tx")),
            )
            for n in as_list(d.get("network"))
        ],
        disks=[_io(x) for x in as_list(as_map(d.get("disk")).get("disk"))],
        volumes=[_io(x) for x in as_list(as_map(d.get("space")).get("volume"))],
    )


OPERATIONS = [
    Operation(
        id="system.info",
        title="System: identity and version",
        description="Model, serial number, memory, DSM version, uptime, NAS temperature.",
        kind="read",
        scope="system:read",
        path="/system/info",
        result_model=SystemInfo,
        transform=_system_info,
        calls=(DSM_INFO,),
        cache_ttl=60,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
    Operation(
        id="system.time",
        title="System: time and time zone",
        description="NAS time zone, local time, offset from UTC (daylight saving included), NTP "
        "synchronization.",
        kind="read",
        scope="system:read",
        path="/system/time",
        result_model=SystemTime,
        transform=_system_time,
        calls=(SYSTEM_INFO, NTP_STATUS),
        cache_ttl=60,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
    Operation(
        id="system.utilization",
        title="System: live vitals",
        description="CPU load, memory, network throughput, disk and volume activity, right now.",
        kind="read",
        scope="system:read",
        path="/system/utilization",
        result_model=Utilization,
        transform=_utilization,
        calls=(UTILIZATION,),
        cache_ttl=5,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
