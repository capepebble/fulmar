from datetime import UTC, datetime

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, load_fixture, principal

SYSTEM_INFO = "SYNO.Core.System.info"
NTP_STATUS = "SYNO.Core.Region.NTP.status"
# Heure UTC de la lecture du NAS d'essai : sa réponse donne 10:37:55 en heure locale.
READ_AT = datetime(2026, 11, 9, 9, 37, 57, tzinfo=UTC)


async def run(response, audit, settings, *scopes, at=READ_AT):
    dsm = FakeDsm({SYSTEM_INFO: response, NTP_STATUS: load_fixture("ds420p_dsm741_ntp_status")})
    engine = Engine(build_catalog(), dsm, audit, settings, wall_clock=lambda: at)
    env = await engine.run(
        "system.time", {}, principal(*(scopes or ("system:read",))), channel="rest", client_ip=None
    )
    return env.data, dsm


async def test_time_real_ds420p_dsm741(audit, settings):
    data, dsm = await run(load_fixture("ds420p_dsm741_system_info"), audit, settings)
    assert data == {
        "time_zone": "Amsterdam",
        "time_zone_label": "(GMT+01:00) Amsterdam, Berlin, Rome, Stockholm, Vienna",
        "local_time": "2026-11-09T10:37:55",
        "utc_offset_minutes": 60,
        "ntp_enabled": True,
        "ntp_server": "time.google.com",
        "ntp_synced": True,
    }
    # Version du Centre d'infos ; seuls l'heure et le fuseau sortent de cette réponse.
    assert dsm.calls == [("SYNO.Core.System", "info", {}), ("SYNO.Core.Region.NTP", "status", {})]
    assert "<serial>" not in str(data)


@pytest.mark.parametrize(
    ("local", "offset"),
    [
        ("2026-11-09 15:07:50", 330),  # Inde, UTC+5:30, horloge du NAS en retard de 7 s
        ("2026-11-08 22:38:10", -660),  # UTC-11, la veille
        ("2026-11-09 09:37:57", 0),
    ],
)
async def test_time_offset_rounded_to_quarter_hour(audit, settings, local, offset):
    data, _ = await run({"time": local, "time_zone": "X"}, audit, settings)
    assert data["utc_offset_minutes"] == offset


@pytest.mark.parametrize("local", ["2026-11-11 09:37:57", "n'importe quoi", None])
async def test_time_offset_unknown_when_clock_or_shape_is_off(audit, settings, local):
    # Plus de 14 h d'écart : l'horloge du NAS est fausse, aucun fuseau n'explique l'écart.
    data, _ = await run({"time": local}, audit, settings)
    assert data["utc_offset_minutes"] is None and data["ntp_enabled"] is None


async def test_time_needs_system_read(audit, settings):
    with pytest.raises(OpError) as info:
        await run({}, audit, settings, "storage:read")
    assert info.value.status == 403
