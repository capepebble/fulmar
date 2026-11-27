"""S.M.A.R.T. des disques : les attributs qui annoncent la panne, le dernier test, les tests
planifiés (conception 2026-11-26-meilleur-produit, section 3.3).

Lire SMART fait travailler le disque : cache de 6 heures, et le relevé ne note une nouvelle
valeur que quand la lecture est neuve.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, Each, OpContext, Operation
from nas_agent.catalog.ops._util import as_bool, as_int, as_list, as_map, as_str, local_time
from nas_agent.catalog.ops.storage import LOAD_INFO

MAX_DISKS = 64
SMART_HEALTH = DsmCall(
    "SYNO.Storage.CGI.Smart",
    "get_health_info",
    1,
    each=Each(LOAD_INFO.key, "disks", "device", limit=MAX_DISKS),
)
TEST_LOG = DsmCall(
    "SYNO.Core.Storage.Disk",
    "get_smart_test_log",
    1,
    each=Each(LOAD_INFO.key, "disks", "device", limit=MAX_DISKS),
    optional=True,
)
SCHEDULER = DsmCall("SYNO.Storage.CGI.Smart.Scheduler", "list", 1, optional=True)

VERIFIED = "DS420+, DSM 7.4.1-90080 Update 2 (NAS d'essai, 2026-11-26)"
CACHE_S = 6 * 3600
# Résultats du dernier test, tels que l'interface de DSM les connaît.
_RESULTS = ("completed", "damage", "aborted", "interrupted", "extended_test_suggested")
_LEADING = re.compile(r"^\s*(\d+)")


class SmartAttribute(BaseModel):
    id: int
    name: str | None
    current: int | None = Field(description="Normalised value; lower is worse.")
    worst: int | None
    threshold: int | None = Field(description="Failure threshold of the normalised value.")
    raw: str | None = Field(description="Raw value as the disk gives it.")
    status: str | None


class SmartDisk(BaseModel):
    id: str | None
    device: str | None
    name: str | None
    model: str | None
    is_ssd: bool | None
    smart_status: str | None
    power_on_hours: int | None
    reallocated_sectors: int | None = Field(description="SMART 5.")
    pending_sectors: int | None = Field(description="SMART 197, sectors waiting to be remapped.")
    uncorrectable_sectors: int | None = Field(description="SMART 198.")
    reported_uncorrect: int | None = Field(description="SMART 187.")
    command_timeouts: int | None = Field(description="SMART 188.")
    crc_errors: int | None = Field(description="SMART 199: cable or backplane errors.")
    ssd_life_pct: int | None = Field(description="Remaining life of an SSD; missing for HDDs.")
    failing_attributes: list[str] = Field(description="Attributes DSM marks as failing.")
    last_test_result: str | None = Field(
        description='"completed", "damage" (attention required), "aborted", "interrupted" or '
        '"extended_test_suggested".'
    )
    last_test_at: str | None = Field(description="Local NAS time, ISO 8601 without zone.")
    attributes: list[SmartAttribute]


class ScheduledTest(BaseModel):
    name: str | None
    action: str | None = Field(description="Test kind as DSM words it (quick or extended).")
    enabled: bool | None
    next_run: str | None = Field(description="Local NAS time, ISO 8601 without zone.")


class SmartReport(BaseModel):
    disks: list[SmartDisk]
    scheduled_tests: list[ScheduledTest] | None = Field(
        description="Scheduled SMART tests; missing when unreadable."
    )


def _raw_count(attributes: dict[int, SmartAttribute], attr_id: int) -> int | None:
    attr = attributes.get(attr_id)
    match = _LEADING.match(attr.raw or "") if attr else None
    return int(match.group(1)) if match else None


def _attribute(item) -> SmartAttribute | None:
    m = as_map(item)
    attr_id = as_int(m.get("id"))
    if attr_id is None:
        return None
    return SmartAttribute(
        id=attr_id,
        name=as_str(m.get("name")),
        current=as_int(m.get("current")),
        worst=as_int(m.get("worst")),
        threshold=as_int(m.get("threshold")),
        raw=as_str(m.get("raw")),
        status=as_str(m.get("status")),
    )


def _smart(_ctx: OpContext, responses) -> SmartReport:
    health_by_device = as_map(responses[SMART_HEALTH.key])
    logs = as_map(responses.get(TEST_LOG.key))
    disks: list[SmartDisk] = []
    for item in as_list(as_map(responses[LOAD_INFO.key]).get("disks"))[:MAX_DISKS]:
        d = as_map(item)
        device = as_str(d.get("device"))
        # DSM 7.4 range tout sous « healthInfo ».
        raw = as_map(health_by_device.get(device or ""))
        health = as_map(raw.get("healthInfo")) or raw
        if not health:
            continue
        overview = as_map(health.get("overview"))
        attrs = [a for a in map(_attribute, as_list(health.get("smartInfo"))) if a]
        by_id = {a.id: a for a in attrs}
        life = as_map(overview.get("remain_life"))
        life_value = as_int(life.get("value"))
        log = as_map(logs.get(device or ""))
        info = as_map(next(iter(as_list(log.get("testInfo"))), {}))
        result = as_str(info.get("latest_test_result"))
        ssd = as_bool(overview.get("isSsd"))
        disks.append(
            SmartDisk(
                id=as_str(d.get("id")),
                device=device,
                name=as_str(d.get("name")),
                model=as_str(d.get("model")),
                is_ssd=ssd if ssd is not None else as_bool(d.get("isSsd")),
                smart_status=as_str(overview.get("smart")) or as_str(d.get("smart_status")),
                power_on_hours=as_int(overview.get("poweron")) or _raw_count(by_id, 9),
                reallocated_sectors=_raw_count(by_id, 5),
                pending_sectors=_raw_count(by_id, 197),
                uncorrectable_sectors=_raw_count(by_id, 198),
                reported_uncorrect=_raw_count(by_id, 187),
                command_timeouts=_raw_count(by_id, 188),
                crc_errors=_raw_count(by_id, 199),
                ssd_life_pct=life_value if life_value is not None and life_value >= 0 else None,
                failing_attributes=[
                    s for s in (as_str(x) for x in as_list(overview.get("smart_fail"))) if s
                ],
                last_test_result=result if result in _RESULTS else None,
                last_test_at=local_time(log.get("latest_test_time")),
                attributes=attrs,
            )
        )
    sched = responses.get(SCHEDULER.key)
    scheduled = None
    if sched is not None:
        scheduled = [
            ScheduledTest(
                name=as_str(as_map(t).get("task_name")),
                action=as_str(as_map(t).get("action")),
                enabled=as_bool(as_map(t).get("enabled")),
                next_run=local_time(as_map(t).get("next_trigger_time")),
            )
            for t in as_list(as_map(sched).get("items"))
        ]
    return SmartReport(disks=disks, scheduled_tests=scheduled)


OPERATIONS = [
    Operation(
        id="storage.smart",
        title="Storage: S.M.A.R.T.",
        description="S.M.A.R.T. of each disk: power-on hours, the attributes that announce a "
        "failure (reallocated, pending and uncorrectable sectors, reported errors, timeouts, "
        "cable errors), SSD life, last self-test and its result, every raw attribute; "
        "scheduled SMART tests. Cached 6 hours: reading SMART wakes the disks.",
        kind="read",
        scope="storage:read",
        path="/storage/smart",
        result_model=SmartReport,
        transform=_smart,
        calls=(LOAD_INFO, SMART_HEALTH, TEST_LOG, SCHEDULER),
        cache_ttl=CACHE_S,
        verified_on=VERIFIED,
    ),
]
