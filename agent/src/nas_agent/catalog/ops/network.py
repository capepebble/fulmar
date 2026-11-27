"""Réseau du NAS : nom, passerelle, DNS, interfaces et services réseau."""

from __future__ import annotations

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

# Versions et paramètres du Panneau de configuration.
NETWORK = DsmCall("SYNO.Core.Network", "get", 1)
INTERFACES = DsmCall("SYNO.Core.Network.Interface", "list", 1)
SERVICES = DsmCall("SYNO.Core.Service", "get", 3, params={"additional": '["active_status"]'})

_ENABLED = {"enabled": True, "disabled": False}
_ACTIVE = {"active": True, "inactive": False}


class Gateway(BaseModel):
    address: str | None
    interface: str | None


class Interface(BaseModel):
    name: str | None
    kind: str | None = Field(description='Type as DSM records it: "lan", "pppoe", "bond"…')
    connected: bool | None
    address: str | None = Field(description="IPv4 address.")
    netmask: str | None
    dhcp: bool | None
    speed_mbps: int | None


class Service(BaseModel):
    id: str = Field(description='Service as DSM names it ("ssh-shell", "nfs-server"…).')
    enabled: bool | None = Field(
        description="Enabled in the settings; missing: started by DSM when needed."
    )
    running: bool | None


class NetworkOverview(BaseModel):
    hostname: str | None
    gateway: Gateway
    ipv6_gateway: str | None
    dns_servers: list[str]
    dns_manual: bool | None = Field(description="DNS servers entered by hand, not from DHCP.")
    interfaces: list[Interface]
    services: list[Service]


def _interface(item) -> Interface:
    m = as_map(item)
    speed = as_int(m.get("speed"))
    status = as_str(m.get("status"))
    return Interface(
        name=as_str(m.get("ifname")),
        kind=as_str(m.get("type")),
        connected=None if status is None else status == "connected",
        address=as_str(m.get("ip")),
        netmask=as_str(m.get("mask")),
        dhcp=as_bool(m.get("use_dhcp")),
        speed_mbps=speed if speed and speed > 0 else None,
    )


def _service(item) -> Service | None:
    m = as_map(item)
    sid = as_str(m.get("service_id"))
    if sid is None:
        return None
    return Service(
        id=sid,
        enabled=_ENABLED.get(as_str(m.get("enable_status")) or ""),
        running=_ACTIVE.get(as_str(as_map(m.get("additional")).get("active_status")) or ""),
    )


def _overview(_ctx: OpContext, responses) -> NetworkOverview:
    net = as_map(responses[NETWORK.key])
    services = [_service(s) for s in as_list(as_map(responses[SERVICES.key]).get("service"))]
    return NetworkOverview(
        hostname=as_str(net.get("server_name")),
        gateway=Gateway(
            address=as_str(net.get("gateway")),
            interface=as_str(as_map(net.get("gateway_info")).get("ifname")),
        ),
        ipv6_gateway=as_str(net.get("v6gateway")),
        dns_servers=[
            d for d in (as_str(net.get("dns_primary")), as_str(net.get("dns_secondary"))) if d
        ],
        dns_manual=as_bool(net.get("dns_manual")),
        interfaces=[_interface(i) for i in as_list(as_map(responses[INTERFACES.key]).get("items"))],
        services=[s for s in services if s is not None],
    )


OPERATIONS = [
    Operation(
        id="network.overview",
        title="Network",
        description="NAS name, gateway, DNS servers, interfaces (IPv4 address, netmask, DHCP, "
        "link and speed) and network services, enabled or not, running or not.",
        kind="read",
        scope="system:read",
        path="/network",
        result_model=NetworkOverview,
        transform=_overview,
        calls=(NETWORK, INTERFACES, SERVICES),
        cache_ttl=300,
        verified_on=VERIFIED_DS420P_DSM741,
    ),
]
