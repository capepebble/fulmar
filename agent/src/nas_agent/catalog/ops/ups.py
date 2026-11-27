"""Onduleur : réglage, état, batterie ; jamais les secrets SNMP."""

from __future__ import annotations

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import VERIFIED_DS420P_DSM741, as_bool, as_int, as_map, as_str

# Version qu'emploie le Panneau de configuration.
UPS_GET = DsmCall("SYNO.Core.ExternalDevice.UPS", "get", 1)

_MODES = {"USB": "usb", "SNMP": "snmp", "SLAVE": "network"}
# Textes de DSM : « usb_ups_status_online » (branché), « battery », « low_batt », « off ».
_STATUSES = {
    "online": "online",
    "battery": "on_battery",
    "low_batt": "low_battery",
    "off": "off",
    "unknown": "unknown",
}


class UpsStatus(BaseModel):
    enabled: bool | None = Field(description="UPS support enabled in DSM.")
    mode: str | None = Field(
        description='"usb", "snmp" or "network" (client of a network UPS server); missing '
        "when UPS support is off."
    )
    status: str | None = Field(
        description='"online", "on_battery", "low_battery", "off" or "unknown".'
    )
    on_battery: bool | None
    charge_percent: int | None
    runtime_seconds: int | None = Field(description="Estimated runtime on battery.")
    manufacturer: str | None
    model: str | None
    usb_detected: bool | None = Field(description="A USB UPS is plugged in.")
    network_server: str | None = Field(description="Network UPS server being followed.")


def _measure(value, enabled: bool) -> int | None:
    number = as_int(value)
    return number if enabled and number is not None and number >= 0 else None


def _ups(_ctx: OpContext, responses) -> UpsStatus:
    m = as_map(responses[UPS_GET.key])
    enabled = as_bool(m.get("enable"))
    raw = as_str(m.get("status")) or ""
    status = _STATUSES.get(raw.removeprefix("usb_ups_status_"), raw or None)
    mode = _MODES.get(as_str(m.get("mode")) or "") if enabled else None
    return UpsStatus(
        enabled=enabled,
        mode=mode,
        status=status,
        on_battery=status in ("on_battery", "low_battery") if enabled else None,
        charge_percent=_measure(m.get("charge"), bool(enabled)),
        runtime_seconds=_measure(m.get("runtime"), bool(enabled)),
        manufacturer=as_str(m.get("manufacture")),
        model=as_str(m.get("model")),
        usb_detected=as_bool(m.get("usb_ups_connect")),
        network_server=as_str(m.get("net_server_ip")) if mode == "network" else None,
    )


OPERATIONS = [
    Operation(
        id="ups.status",
        title="UPS",
        description="UPS: support enabled or not, mode (USB, SNMP, network), state (on mains, on "
        "battery, low battery), charge and runtime, make and model.",
        kind="read",
        scope="system:read",
        path="/ups",
        result_model=UpsStatus,
        transform=_ups,
        calls=(UPS_GET,),
        cache_ttl=30,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
