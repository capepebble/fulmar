"""Mises à jour des paquets (conception 2026-11-26-mises-a-jour-paquets) : réponses réelles du
NAS d'essai pour le chemin vérifié (Text Editor 1.2.5 vers 1.2.6) ; avertissements, blocages
et échecs synthétiques, aucun n'ayant pu être provoqué."""

import copy

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmError
from nas_agent.engine import Engine, OpError
from nas_agent.updates import UpdateService
from tests.conftest import FakeDsm, load_fixture, principal

LIST = "SYNO.Core.Package.list"
CATALOG = "SYNO.Core.Package.Server.list"
FEASIBILITY = "SYNO.Core.Package.feasibility_check"
INSTALL = "SYNO.Core.Package.Installation.install"
STATUS = "SYNO.Core.Package.Installation.status"


def real(name):
    return load_fixture(f"ds420p_dsm741_pkg_update_{name}")


class Sequence:
    """Les réponses successives d'un même appel : la dernière se répète."""

    def __init__(self, *answers):
        self.answers = list(answers)

    def __call__(self, _params):
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


class Nas:
    """Le NAS d'essai tel qu'il a répondu : Text Editor en 1.2.5 jusqu'à la mise à jour."""

    def __init__(self):
        self.updated = False

    def listing(self, _params):
        return real("list_after" if self.updated else "list_before")

    def install(self, _params):
        self.updated = True
        return real("install")


def responses():
    nas = Nas()
    return {
        LIST: nas.listing,
        CATALOG: real("catalog"),
        FEASIBILITY: real("feasibility_ok"),
        INSTALL: nas.install,
        STATUS: Sequence(real("status_running"), real("status_finished")),
    }


def engine_for(dsm, audit, settings):
    engine = Engine(build_catalog(), dsm, audit, settings)
    engine.updates = UpdateService(
        dsm, audit, poll_s=0, on_done=lambda: engine.invalidate("SYNO.Core.Package")
    )
    return engine


async def run(engine, op, params=None, scope="packages:update"):
    env = await engine.run(op, params or {}, principal(scope), channel="rest", client_ip=None)
    return env.data


async def test_check_says_what_would_be_updated(audit, settings):
    engine = engine_for(FakeDsm(responses()), audit, settings)
    plan = await run(engine, "packages.update_check", {"packages": "TextEditor,HyperBackup,Nope"})
    assert [(p["id"], p["state"]) for p in plan["packages"]] == [
        ("TextEditor", "ready"),
        ("HyperBackup", "up_to_date"),
        ("Nope", "not_installed"),
    ]
    assert plan["packages"][0]["installed"] == "1.2.5-0254"
    assert plan["packages"][0]["available"] == "1.2.6-0260"
    assert (plan["feasibility"], plan["reasons"]) == ("ok", [])


async def test_update_runs_and_checks_the_new_version(audit, settings):
    dsm = FakeDsm(responses())
    engine = engine_for(dsm, audit, settings)
    job = await run(engine, "packages.update", {"packages": "TextEditor"})
    assert job["state"] == "running"
    assert [(p["id"], p["from_version"], p["to_version"]) for p in job["packages"]] == [
        ("TextEditor", "1.2.5-0254", "1.2.6-0260")
    ]
    await engine.updates.wait()
    status = await run(engine, "updates.status")
    assert status["running"] is False
    (done,) = status["jobs"]
    assert (done["state"], done["packages"][0]["state"], done["packages"][0]["error"]) == (
        "done",
        "done",
        None,
    )
    # L'adresse, la somme et la taille viennent du catalogue de DSM, jamais de l'appelant.
    (call,) = [c for c in dsm.calls if c[1] == "install"]
    assert call[2]["url"].startswith("https://global.synologydownload.com/")
    assert call[2]["checksum"] == "df3bf9e83af7b85cd7df43ecb21cccfe"
    assert (call[2]["operation"], call[2]["blqinst"]) == ("upgrade", "true")
    assert "url" not in str(status) and "checksum" not in str(status)
    # Chaque paquet laisse sa trace au journal de l'agent.
    assert any(e.op == "packages.update.package" and e.outcome == "ok" for e in audit.tail(10))


async def test_a_version_that_did_not_change_is_a_failure(audit, settings):
    answers = responses()
    answers[LIST] = real("list_before")
    answers[INSTALL] = real("install")
    engine = engine_for(FakeDsm(answers), audit, settings)
    await run(engine, "packages.update", {"packages": "TextEditor"})
    await engine.updates.wait()
    (job,) = (await run(engine, "updates.status"))["jobs"]
    assert job["state"] == "failed"
    assert job["packages"][0]["error"] == "version still 1.2.5-0254 after the update"


async def test_dsm_error_during_the_update(audit, settings):
    answers = responses()
    failed = copy.deepcopy(real("status_running"))
    failed["error"] = {"code": 4501}
    answers[STATUS] = failed
    engine = engine_for(FakeDsm(answers), audit, settings)
    await run(engine, "packages.update", {"packages": "TextEditor"})
    await engine.updates.wait()
    (job,) = (await run(engine, "updates.status"))["jobs"]
    assert (job["packages"][0]["state"], job["packages"][0]["dsm_code"]) == ("failed", 4501)


def refused(code, check_type, *reasons):
    return DsmError(
        code,
        "SYNO.Core.Package",
        {
            "check_type": check_type,
            "reasons": [{"pkg": "ActiveBackup", "task": r} for r in reasons],
        },
    )


async def test_warnings_need_a_confirmation(audit, settings):
    answers = responses()
    task = "Active Backup for Business is performing backup or restore tasks"
    answers[FEASIBILITY] = refused(4556, "soft", task)
    engine = engine_for(FakeDsm(answers), audit, settings)
    plan = await run(engine, "packages.update_check", {"packages": "TextEditor"})
    assert (plan["feasibility"], plan["dsm_code"]) == ("warning", 4556)
    assert plan["reasons"] == [task]
    with pytest.raises(OpError) as err:
        await run(engine, "packages.update", {"packages": "TextEditor"})
    assert (err.value.code, err.value.status) == ("needs_confirmation", 409)
    assert task in err.value.detail
    job = await run(
        engine, "packages.update", {"packages": "TextEditor", "accept_warnings": "true"}
    )
    assert job["state"] == "running"
    await engine.updates.wait()


async def test_a_block_is_never_overridden(audit, settings):
    answers = responses()
    answers[FEASIBILITY] = refused(
        4556, "hard", "Active Backup for Business is performing an instant restore"
    )
    engine = engine_for(FakeDsm(answers), audit, settings)
    with pytest.raises(OpError) as err:
        await run(engine, "packages.update", {"packages": "TextEditor", "accept_warnings": "true"})
    assert err.value.code == "blocked"
    assert not [c for c in engine.updates._dsm.calls if c[1] == "install"]


async def test_nothing_to_update_busy_and_rights(audit, settings):
    engine = engine_for(FakeDsm(responses()), audit, settings)
    with pytest.raises(OpError) as err:
        await run(engine, "packages.update", {"packages": "HyperBackup,Nope"})
    assert err.value.code == "nothing_to_update"
    with pytest.raises(OpError) as err:
        await run(engine, "packages.update", {"packages": "TextEditor"}, scope="system:read")
    assert err.value.code == "forbidden"
    with pytest.raises(OpError) as err:
        await run(engine, "packages.update", {"packages": "../etc,TextEditor"})
    assert err.value.code == "invalid_params"
    await run(engine, "packages.update", {"packages": "TextEditor"})
    with pytest.raises(OpError) as err:
        await run(engine, "packages.update", {"packages": "TextEditor"})
    assert err.value.code == "busy"
    await engine.updates.wait()


async def test_a_third_party_or_odd_link_is_refused(audit, settings):
    answers = responses()
    catalog = copy.deepcopy(real("catalog"))
    for p in catalog["packages"]:
        if p["id"] == "TextEditor":
            p["link"] = "https://example.com/TextEditor.spk"
    answers[CATALOG] = catalog
    engine = engine_for(FakeDsm(answers), audit, settings)
    plan = await run(engine, "packages.update_check", {"packages": "TextEditor"})
    assert plan["packages"][0]["state"] == "not_from_synology"


def test_the_update_scopes_are_their_own():
    catalog = build_catalog()
    for op_id in (
        "packages.update",
        "packages.update_check",
        "updates.status",
        "updates.schedule",
        "updates.unschedule",
        "updates.protections",
        "updates.protect",
    ):
        assert catalog.get(op_id).scope == "packages:update"
    for op_id in ("dsm.update_check", "dsm.update_run"):
        assert catalog.get(op_id).scope == "dsm:update"
    assert catalog.get("packages.update").kind == "action"
    assert catalog.get("dsm.update_run").kind == "action"
    writers = [op for op in catalog if op.scope in ("packages:update", "dsm:update")]
    assert len(writers) == 9
