"""Mise à jour de DSM et rendez-vous (conception 2026-11-26-mises-a-jour-paquets, section 6).

Les lectures de DSM viennent du NAS d'essai (à jour : aucune mise à jour disponible) ; le
téléchargement et l'installation sont synthétiques, à la forme relevée dans le centre
d'administration de DSM (`admin_center.js`), le NAS d'essai n'ayant rien à installer.
"""

import copy
import json
from datetime import UTC, datetime, timedelta

import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.catalog.ops.updates import prepare
from nas_agent.dsm.gateway import DsmUnreachable
from nas_agent.engine import Engine, OpError
from nas_agent.updates import UpdateService
from tests.conftest import FakeDsm, load_fixture, principal
from tests.test_updates import responses as package_responses

INFO = "SYNO.DSM.Info.getinfo"
CHECK = "SYNO.Core.Upgrade.Server.check"
DL_START = "SYNO.Core.Upgrade.Server.Download.start"
DL_PROGRESS = "SYNO.Core.Upgrade.Server.Download.progress"
STATUS = "SYNO.Core.Upgrade.status"
PRECHECK = "SYNO.Core.Upgrade.PreCheck.start"
START = "SYNO.Core.Upgrade.start"
NEW = "DSM 7.4.1-90080 Update 3"


def real(name):
    return load_fixture(f"ds420p_dsm741_{name}")


class Dsm:
    """Un DSM qui a une mise à jour : téléchargée, installée, puis redémarré dans sa version."""

    def __init__(self, status=None):
        self.started = False
        self.down = 0
        self.status = status or {"allow_upgrade": True, "status": "none"}
        self.progress = iter(
            [{"status": "downloading", "percent": 40}, {"status": "finished", "percent": 100}]
        )

    def info(self, _params):
        info = copy.deepcopy(real("dsm_info"))
        info["version_string"] = "DSM 7.4.1-90080 Update 2"
        if self.started:
            # Redémarrage : DSM ne répond pas deux fois, puis revient dans sa nouvelle version.
            if self.down < 2:
                self.down += 1
                raise DsmUnreachable("rebooting")
            info["version_string"] = NEW
        return info

    def check(self, _params):
        check = copy.deepcopy(real("upgrade_server_check"))
        check["update"] = {"available": True, "rss_result": "success", "version": NEW}
        return check

    def download_progress(self, _params):
        return next(self.progress, {"status": "finished", "percent": 100})

    def start(self, _params):
        self.started = True
        return {}

    def responses(self):
        return {
            INFO: self.info,
            CHECK: self.check,
            DL_START: {},
            DL_PROGRESS: self.download_progress,
            STATUS: self.status,
            PRECHECK: {"precheck": True, "precheck_info": {"can_continue": True}},
            START: self.start,
        }


def engine_for(responses, audit, settings, *, clock=None, path=None):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings)
    kw = {"clock": clock} if clock else {}
    engine.updates = UpdateService(dsm, audit, poll_s=0.001, reboot_timeout_s=5, path=path, **kw)
    return engine


async def run(engine, op, params=None, *scopes):
    env = await engine.run(
        op,
        params or {},
        principal(*(scopes or ("packages:update", "dsm:update"))),
        channel="rest",
        client_ip=None,
    )
    return env.data


async def test_the_test_nas_has_nothing_to_install(audit, settings):
    answers = {
        INFO: real("dsm_info"),
        CHECK: real("upgrade_server_check"),
        DL_PROGRESS: real("dsm_upgrade_download_progress"),
        STATUS: real("dsm_upgrade_status"),
    }
    engine = engine_for(answers, audit, settings)
    plan = await run(engine, "dsm.update_check")
    assert (plan["available"], plan["download"], plan["feasibility"]) == (False, "none", "ok")
    with pytest.raises(OpError) as err:
        await run(engine, "dsm.update_run")
    assert err.value.code == "nothing_to_update"


async def test_dsm_update_downloads_installs_and_comes_back(audit, settings):
    nas = Dsm()
    engine = engine_for(nas.responses(), audit, settings)
    job = await run(engine, "dsm.update_run")
    assert (job["kind"], job["dsm"]["to_version"]) == ("dsm", NEW)
    await engine.updates.wait()
    (done,) = (await run(engine, "updates.status"))["jobs"]
    assert (done["state"], done["dsm"]["state"], done["dsm"]["step"]) == ("done", "done", "end")
    assert done["dsm"]["percent"] == 100
    called = [c[:2] for c in engine.updates._dsm.calls]
    assert ("SYNO.Core.Upgrade", "start") in called
    assert ("SYNO.Core.Upgrade.Server.Download", "start") in called


async def test_dsm_needs_its_own_scope(audit, settings):
    engine = engine_for(Dsm().responses(), audit, settings)
    with pytest.raises(OpError) as err:
        await run(engine, "dsm.update_run", {}, "packages:update")
    assert err.value.code == "forbidden"


async def test_dsm_warnings_and_blocks(audit, settings):
    soft = {
        "check_type": "soft",
        "upgrade": {"check_msg": [{"task": "Active Backup for Business is performing backup"}]},
    }
    engine = engine_for(Dsm(status=soft).responses(), audit, settings)
    plan = await run(engine, "dsm.update_check")
    assert plan["feasibility"] == "warning"
    assert plan["reasons"] == ["Active Backup for Business is performing backup"]
    with pytest.raises(OpError) as err:
        await run(engine, "dsm.update_run")
    assert err.value.code == "needs_confirmation"
    hard = {**soft, "check_type": "hard"}
    engine = engine_for(Dsm(status=hard).responses(), audit, settings)
    with pytest.raises(OpError) as err:
        await run(engine, "dsm.update_run", {"accept_warnings": "true"})
    assert err.value.code == "blocked"


async def test_a_refusing_precheck_stops_before_installing(audit, settings):
    nas = Dsm(status={"check_type": "", "patch_info": {"upgradetype": "dsm"}})
    answers = nas.responses()
    answers[PRECHECK] = {"precheck_info": {"can_continue": False, "message": "Not enough space"}}
    engine = engine_for(answers, audit, settings)
    await run(engine, "dsm.update_run")
    await engine.updates.wait()
    (job,) = (await run(engine, "updates.status"))["jobs"]
    assert job["dsm"]["state"] == "failed"
    assert job["dsm"]["error"] == "DSM's pre-check refuses the update: Not enough space"
    assert not nas.started


async def test_an_interrupted_dsm_update_is_concluded_after_the_restart(audit, settings, tmp_path):
    path = tmp_path / "updates.json"
    nas = Dsm()
    engine = engine_for(nas.responses(), audit, settings, path=path)
    await run(engine, "dsm.update_run")
    await engine.updates.wait()
    # Comme si l'agent s'était arrêté pendant l'installation : l'état gardé dit « restart ».
    data = json.loads(path.read_text())
    data["jobs"][0].update(ended_at=None)
    data["jobs"][0]["dsm"].update(step="restart", state="running", ended_at=None)
    path.write_text(json.dumps(data))
    nas.down = 0
    again = UpdateService(engine.updates._dsm, audit, path=path, poll_s=0.001, reboot_timeout_s=5)
    assert again.busy
    await again.resume()
    await again.wait()
    (job,) = again.jobs()
    assert (job.state, job.dsm.to_version) == ("done", NEW)


class Clock:
    def __init__(self):
        self.now = datetime(2026, 11, 26, 20, tzinfo=UTC)

    def __call__(self):
        return self.now


async def test_a_scheduled_package_update_runs_at_its_time(audit, settings, tmp_path):
    clock = Clock()
    engine = engine_for(package_responses(), audit, settings, clock=clock, path=tmp_path / "u.json")
    at = (clock.now + timedelta(hours=3)).isoformat()
    item = await run(
        engine, "updates.schedule", {"target": "packages", "packages": "TextEditor", "at": at}
    )
    assert (item["state"], item["packages"]) == ("waiting", ["TextEditor"])
    service = engine.updates
    await service.run_due(prepare)
    assert service.jobs() == []
    clock.now += timedelta(hours=3, minutes=1)
    await service.run_due(prepare)
    await service.wait()
    status = await run(engine, "updates.status")
    assert status["schedules"][0]["state"] == "started"
    assert status["jobs"][0]["schedule_id"] == item["id"]
    assert status["jobs"][0]["state"] == "done"


async def test_scheduling_rules(audit, settings):
    clock = Clock()
    engine = engine_for(package_responses(), audit, settings, clock=clock)
    soon = (clock.now + timedelta(minutes=1)).isoformat()
    with pytest.raises(OpError) as err:
        await run(
            engine, "updates.schedule", {"target": "packages", "packages": "TextEditor", "at": soon}
        )
    assert err.value.code == "invalid_time"
    with pytest.raises(OpError) as err:
        await run(engine, "updates.schedule", {"target": "dsm", "at": "2026-11-27T03:00:00"})
    assert err.value.code == "invalid_params"
    later = (clock.now + timedelta(days=1)).isoformat()
    with pytest.raises(OpError) as err:
        await run(engine, "updates.schedule", {"target": "dsm", "at": later}, "packages:update")
    assert err.value.code == "forbidden"
    item = await run(engine, "updates.schedule", {"target": "dsm", "at": later})
    cancelled = await run(engine, "updates.unschedule", {"id": item["id"]})
    assert cancelled == {"id": item["id"], "cancelled": True}
    again = await run(engine, "updates.unschedule", {"id": item["id"]})
    assert again["cancelled"] is False


async def test_a_scheduled_update_that_dsm_warns_about_is_skipped(audit, settings):
    clock = Clock()
    soft = {"check_type": "soft", "poweroff": {"check_msg": ["A restore is running"]}}
    engine = engine_for(Dsm(status=soft).responses(), audit, settings, clock=clock)
    at = (clock.now + timedelta(hours=1)).isoformat()
    await run(engine, "updates.schedule", {"target": "dsm", "at": at})
    clock.now += timedelta(hours=2)
    await engine.updates.run_due(prepare)
    (item,) = (await run(engine, "updates.status"))["schedules"]
    assert item["state"] == "skipped"
    assert item["reason"] == "DSM warns before updating. DSM: A restore is running"
    assert engine.updates.jobs() == []


async def test_a_schedule_whose_token_lost_its_rights_does_not_start(audit, settings):
    clock = Clock()
    engine = engine_for(package_responses(), audit, settings, clock=clock)
    engine.updates._authorize = lambda token_id, target: False
    at = (clock.now + timedelta(hours=1)).isoformat()
    await run(
        engine, "updates.schedule", {"target": "packages", "packages": "TextEditor", "at": at}
    )
    clock.now += timedelta(hours=2)
    await engine.updates.run_due(prepare)
    (item,) = (await run(engine, "updates.status"))["schedules"]
    assert item["state"] == "skipped"
    assert item["reason"] == "the token that scheduled it was revoked, expired or lost its rights"
    assert engine.updates.jobs() == []


async def test_cancelling_a_dsm_schedule_needs_the_dsm_scope(audit, settings):
    clock = Clock()
    engine = engine_for(Dsm().responses(), audit, settings, clock=clock)
    at = (clock.now + timedelta(hours=1)).isoformat()
    item = await run(engine, "updates.schedule", {"target": "dsm", "at": at})
    with pytest.raises(OpError) as err:
        await run(engine, "updates.unschedule", {"id": item["id"]}, "packages:update")
    assert err.value.code == "forbidden"


def test_token_allows_checks_revocation_expiry_and_scopes(conn):
    from nas_agent.tokens import TokenStore
    from nas_agent.updates import token_allows

    tokens = TokenStore(conn)
    now = datetime.now(UTC)
    info, _secret = tokens.create("console", ["packages:update"], ttl_days=30)
    assert token_allows(tokens, info.id, "packages", now)
    assert not token_allows(tokens, info.id, "dsm", now)
    assert not token_allows(tokens, info.id, "packages", now + timedelta(days=31))
    tokens.revoke(info.id)
    assert not token_allows(tokens, info.id, "packages", now)
    assert not token_allows(tokens, None, "packages", now)
