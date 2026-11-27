"""Protections (conception 2026-11-26-groupes-protections-parc, section 2) : ce que Fulmar ne
met jamais à jour sur un NAS. Dépendances réelles du NAS d'essai : Active Backup for Microsoft
365 dépend de Universal Search (SynoFinder)."""

from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.catalog.ops.updates import prepare
from nas_agent.engine import Engine, OpError
from nas_agent.protections import ProtectionStore
from nas_agent.updates import Refused, Schedule, UpdateService
from tests.conftest import FakeDsm, load_fixture, principal
from tests.test_updates import CATALOG, FEASIBILITY, LIST, real, responses
from tests.test_updates_dsm_schedule import Dsm

UPD = ("packages:update",)
ALL = ("packages:update", "dsm:update")


def store(tmp_path):
    return ProtectionStore(tmp_path / "protections.json")


def test_store_keeps_locks_and_a_clean_note(tmp_path, audit):
    s = store(tmp_path)
    assert s.get().model() == {"frozen": False, "dsm_locked": False, "packages": [], "note": None}
    s.update(lock=["SurveillanceStation", "TextEditor"], note="caméras\u0007 du client ")
    s.update(unlock=["TextEditor"], dsm_locked=True)
    again = ProtectionStore(tmp_path / "protections.json")
    assert again.get().model() == {
        "frozen": False,
        "dsm_locked": True,
        "packages": ["SurveillanceStation"],
        "note": "caméras du client",
    }
    again.update(note="")
    assert again.get().note is None
    with pytest.raises(ValueError):
        again.update(note="x" * 201)
    with pytest.raises(ValueError):
        again.update(lock=["../etc"])


def test_a_package_a_protected_one_depends_on_is_protected_too(tmp_path):
    s = store(tmp_path)
    s.update(lock=["ActiveBackup-Office365"])
    listing = load_fixture("ds420p_dsm741_package_list_dependents")
    reasons = s.get().reasons(listing)
    assert reasons["ActiveBackup-Office365"] == "protected"
    assert reasons["SynoFinder"] == "needed by ActiveBackup-Office365"
    assert "SMBService" not in reasons
    s.update(frozen=True)
    assert set(s.get().reasons(listing)) >= {"TextEditor", "SMBService"}


def engine_for(audit, settings, protections):
    dsm = FakeDsm({**responses(), **Dsm().responses()})
    engine = Engine(build_catalog(), dsm, audit, settings)
    engine.updates = UpdateService(dsm, audit)
    engine.protections = protections
    return engine


async def run(engine, op, scopes, **params):
    env = await engine.run(op, params, principal(*scopes), channel="rest", client_ip=None)
    return env.data


async def test_a_protected_package_is_shown_and_never_updated(audit, settings, tmp_path):
    p = store(tmp_path)
    p.update(lock=["TextEditor"], note="éditeur du client")
    engine = engine_for(audit, settings, p)
    plan = await run(engine, "packages.update_check", UPD, packages="TextEditor")
    assert [(x["id"], x["state"], x["protected"]) for x in plan["packages"]] == [
        ("TextEditor", "protected", "protected")
    ]
    with pytest.raises(OpError) as refused:
        await run(engine, "packages.update", UPD, packages="TextEditor")
    assert refused.value.code == "nothing_to_update"


async def test_dsm_locked_refuses_run_and_schedule(audit, settings, tmp_path):
    p = store(tmp_path)
    p.update(dsm_locked=True)
    engine = engine_for(audit, settings, p)
    with pytest.raises(OpError) as run_refused:
        await run(engine, "dsm.update_run", ALL)
    assert run_refused.value.code == "protected"
    at = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    with pytest.raises(OpError) as sched_refused:
        await run(engine, "updates.schedule", ALL, target="dsm", at=at)
    assert sched_refused.value.code == "protected"


async def test_making_possible_needs_dsm_update(audit, settings, tmp_path):
    p = store(tmp_path)
    engine = engine_for(audit, settings, p)
    done = await run(engine, "updates.protect", UPD, frozen=True, lock="TextEditor", note="gel")
    assert done["frozen"] is True and done["packages"] == ["TextEditor"]
    seen = await run(engine, "updates.protections", UPD)
    assert seen["frozen"] is True and seen["note"] == "gel"
    with pytest.raises(OpError) as refused:
        await run(engine, "updates.protect", UPD, frozen=False)
    assert refused.value.status == 403
    assert (await run(engine, "updates.protect", ALL, frozen=False))["frozen"] is False
    # Libérer un paquet ne demande que le droit de le mettre à jour.
    assert (await run(engine, "updates.protect", UPD, unlock="TextEditor"))["packages"] == []
    lines = [e.op for e in audit.tail(20) if e.op == "updates.protect"]
    assert len(lines) == 4


async def test_prepare_takes_every_package_but_the_protected(tmp_path):
    dsm = FakeDsm({**responses(), **Dsm().responses()})
    s = Schedule(
        id="r", target="packages", packages=[], at="", accept_warnings=False, by=None, created_at=""
    )
    ready = await prepare(dsm, s)
    assert [p.id for p in ready] == ["TextEditor"]
    p = store(tmp_path)
    p.update(lock=["TextEditor"])
    with pytest.raises(Refused) as nothing:
        await prepare(dsm, s, p.get())
    assert nothing.value.code == "nothing_to_update"
    p.update(unlock=["TextEditor"], dsm_locked=True)
    dsm_s = Schedule(
        id="r", target="dsm", packages=[], at="", accept_warnings=False, by=None, created_at=""
    )
    with pytest.raises(Refused) as locked:
        await prepare(dsm, dsm_s, p.get())
    assert locked.value.code == "protected"


def test_fixture_keys():
    # Les réponses du chemin vérifié restent celles d'avant : la liste garde sa forme.
    assert LIST and CATALOG and FEASIBILITY and real("list_before")
