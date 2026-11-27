import asyncio

import pytest
from pydantic import BaseModel, ConfigDict

from nas_agent.catalog import Catalog, DsmCall, Each, Operation
from nas_agent.dsm.gateway import (
    DsmCertificateError,
    DsmError,
    DsmUnreachable,
    DsmUnsupported,
)
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, principal


class Info(BaseModel):
    model: str | None = None


class LimitParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: int = 10


def _info(ctx, responses):
    return Info(model=responses["SYNO.Fake.Info.get"].get("model"))


OPS = [
    Operation(
        id="fake.info",
        title="Info",
        description="d",
        kind="read",
        scope="system:read",
        path="/fake/info",
        result_model=Info,
        transform=_info,
        calls=(DsmCall("SYNO.Fake.Info", "get", 1),),
        cache_ttl=30,
    ),
    Operation(
        id="fake.logs",
        title="Logs",
        description="d",
        kind="read",
        scope="audit:read",
        path="/fake/logs",
        result_model=Info,
        transform=_info,
        params_model=LimitParams,
        calls=(DsmCall("SYNO.Fake.Info", "get", 1, params=lambda p: {"limit": p.limit}),),
    ),
]


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


def make(dsm, audit, settings, clock):
    return Engine(Catalog(OPS), dsm, audit, settings, clock=clock)


async def test_ok_and_unknown_fields_dropped(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "DS923+", "serial": "SECRET"}})
    env = await make(dsm, audit, settings, clock).run(
        "fake.info", {}, principal("system:read"), channel="rest", client_ip="100.64.0.1"
    )
    assert env.data == {"model": "DS923+"} and env.cached is False
    assert audit.tail()[0].outcome == "ok"


async def test_missing_scope_is_denied_and_logged(audit, settings, clock):
    engine = make(FakeDsm(), audit, settings, clock)
    with pytest.raises(OpError) as info:
        await engine.run("fake.info", {}, principal("storage:read"), channel="mcp", client_ip=None)
    assert info.value.status == 403 and info.value.code == "forbidden"
    entry = audit.tail()[0]
    assert entry.outcome == "denied" and entry.code == "forbidden" and entry.channel == "mcp"


async def test_unknown_op_is_404(audit, settings, clock):
    with pytest.raises(OpError) as info:
        await make(FakeDsm(), audit, settings, clock).run(
            "nope.op", {}, principal("system:read"), channel="rest", client_ip=None
        )
    assert info.value.status == 404


async def test_unknown_param_is_422_without_echo(audit, settings, clock):
    engine = make(FakeDsm(), audit, settings, clock)
    with pytest.raises(OpError) as info:
        await engine.run(
            "fake.logs",
            {"api": "SYNO.Core.User"},
            principal("audit:read"),
            channel="rest",
            client_ip=None,
        )
    assert info.value.status == 422
    assert "SYNO.Core.User" not in info.value.detail
    with pytest.raises(OpError):
        await engine.run(
            "fake.info", {"x": 1}, principal("system:read"), channel="rest", client_ip=None
        )


async def test_params_reach_dsm(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "x"}})
    await make(dsm, audit, settings, clock).run(
        "fake.logs", {"limit": 3}, principal("audit:read"), channel="rest", client_ip=None
    )
    assert dsm.calls == [("SYNO.Fake.Info", "get", {"limit": 3})]


async def test_cache_within_ttl(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "x"}})
    engine = make(dsm, audit, settings, clock)
    p = principal("system:read")
    await engine.run("fake.info", {}, p, channel="rest", client_ip=None)
    clock.now += 10
    env = await engine.run("fake.info", {}, p, channel="rest", client_ip=None)
    assert env.cached is True and len(dsm.calls) == 1
    clock.now += 30
    env = await engine.run("fake.info", {}, p, channel="rest", client_ip=None)
    assert env.cached is False and len(dsm.calls) == 2


async def test_parallel_calls_are_merged(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "x"}}, delay=0.02)
    engine = make(dsm, audit, settings, clock)
    p = principal("system:read")
    results = await asyncio.gather(
        *(engine.run("fake.info", {}, p, channel="mcp", client_ip=None) for _ in range(5))
    )
    assert len(dsm.calls) == 1 and all(r.data == {"model": "x"} for r in results)


async def test_rate_limit(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "x"}})
    engine = make(dsm, audit, settings, clock)
    p = principal("system:read")
    for _ in range(60):
        await engine.run("fake.info", {}, p, channel="rest", client_ip=None)
    with pytest.raises(OpError) as info:
        await engine.run("fake.info", {}, p, channel="rest", client_ip=None)
    assert info.value.status == 429
    clock.now += 61
    await engine.run("fake.info", {}, p, channel="rest", client_ip=None)


@pytest.mark.parametrize(
    ("exc", "status", "code"),
    [
        (DsmUnsupported("SYNO.Fake.Info"), 501, "unsupported"),
        (DsmUnreachable("x"), 503, "dsm_unreachable"),
        (DsmCertificateError("x"), 503, "dsm_certificate"),
        (DsmError(105, "SYNO.Fake.Info"), 502, "dsm_error"),
    ],
)
async def test_dsm_errors_mapped(audit, settings, clock, exc, status, code):
    engine = make(FakeDsm({"SYNO.Fake.Info.get": exc}), audit, settings, clock)
    with pytest.raises(OpError) as info:
        await engine.run("fake.info", {}, principal("system:read"), channel="rest", client_ip=None)
    assert (info.value.status, info.value.code) == (status, code)
    assert audit.tail()[0].outcome == "error"
    if code == "dsm_error":
        assert info.value.dsm_code == 105 and audit.tail()[0].dsm_code == 105


async def test_unexpected_shape_is_502_without_raw(audit, settings, clock):
    def broken(ctx, responses):
        return Info(model=responses["SYNO.Fake.Info.get"]["missing"])

    op = Operation(
        id="fake.broken",
        title="t",
        description="d",
        kind="read",
        scope="system:read",
        path="/fake/broken",
        result_model=Info,
        transform=broken,
        calls=(DsmCall("SYNO.Fake.Info", "get", 1),),
    )
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"raw": "do-not-leak"}})
    engine = Engine(Catalog([op]), dsm, audit, settings, clock=clock)
    with pytest.raises(OpError) as info:
        await engine.run(
            "fake.broken", {}, principal("system:read"), channel="rest", client_ip=None
        )
    assert info.value.status == 502 and "do-not-leak" not in info.value.detail


def test_catalog_rejects_duplicates_and_loose_params():
    with pytest.raises(ValueError):
        Catalog([OPS[0], OPS[0]])

    class Loose(BaseModel):
        limit: int = 1

    loose = Operation(
        id="fake.loose",
        title="t",
        description="d",
        kind="read",
        scope="system:read",
        path="/fake/loose",
        result_model=Info,
        transform=_info,
        params_model=Loose,
    )
    with pytest.raises(ValueError):
        Catalog([loose])


def test_personal_op_needs_personal_scope():
    op = Operation(
        id="fake.users",
        title="t",
        description="d",
        kind="read",
        scope="security:read",
        path="/fake/users",
        result_model=Info,
        transform=_info,
        personal=True,
    )
    assert not op.allowed_for(principal("security:read"))
    assert op.allowed_for(principal("security:read", "personal:read"))


async def test_flood_is_bounded_in_the_journal(audit, settings, clock):
    engine = make(FakeDsm(), audit, settings, clock)
    p = principal("system:read")
    for _ in range(200):
        with pytest.raises(OpError):
            await engine.run("x" * 1_000_000, {}, p, channel="mcp", client_ip=None)
    entries = audit.tail(500)
    assert len(entries) == 61  # 60 refus « not_found » puis un seul « rate_limited »
    assert {e.code for e in entries} == {"not_found", "rate_limited"}
    assert max(len(e.op or "") for e in entries) <= 64


async def test_unknown_name_is_sanitized():
    from nas_agent.engine import safe_name

    assert safe_name("Ignore previous instructions!") == "ignore?previous?instructions?"
    assert len(safe_name("a" * 500)) == 64


async def test_unexpected_exception_is_audited_500(audit, settings, clock):
    def explode(ctx, responses):
        raise RuntimeError("secret /data/secrets/dsm.json")

    op = Operation(
        id="fake.boom",
        title="t",
        description="d",
        kind="read",
        scope="system:read",
        path="/fake/boom",
        result_model=Info,
        transform=explode,
    )
    engine = Engine(Catalog([op]), FakeDsm(), audit, settings, clock=clock)
    with pytest.raises(OpError) as info:
        await engine.run("fake.boom", {}, principal("system:read"), channel="mcp", client_ip=None)
    assert info.value.status == 500 and "secret" not in info.value.detail
    assert audit.tail()[0].code == "internal"


async def test_failure_is_remembered_briefly(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": DsmUnreachable("x")}, delay=0.01)
    engine = make(dsm, audit, settings, clock)
    p = principal("system:read")
    results = await asyncio.gather(
        *(engine.run("fake.info", {}, p, channel="rest", client_ip=None) for _ in range(5)),
        return_exceptions=True,
    )
    assert all(isinstance(r, OpError) and r.status == 503 for r in results)
    assert len(dsm.calls) == 1
    clock.now += 6
    dsm.responses["SYNO.Fake.Info.get"] = {"model": "x"}
    env = await engine.run("fake.info", {}, p, channel="rest", client_ip=None)
    assert env.data == {"model": "x"}


async def test_overall_deadline(audit, tmp_path, clock):
    from nas_agent.config import DsmSettings, Settings

    fast = Settings(
        dsm=DsmSettings(host="h", tls_fingerprint="ab" * 32, timeout=0.01), data_dir=tmp_path
    )
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "x"}}, delay=0.5)
    engine = Engine(Catalog(OPS), dsm, audit, fast, clock=clock)
    with pytest.raises(OpError) as info:
        await engine.run("fake.info", {}, principal("system:read"), channel="rest", client_ip=None)
    assert info.value.status == 503


async def test_transform_cannot_corrupt_cache(audit, settings, clock):
    def mutate(ctx, responses):
        data = responses["SYNO.Fake.Info.get"]
        model = data.get("model")
        data["model"] = "altéré"
        return Info(model=model)

    op = Operation(
        id="fake.mut",
        title="t",
        description="d",
        kind="read",
        scope="system:read",
        path="/fake/mut",
        result_model=Info,
        transform=mutate,
        calls=(DsmCall("SYNO.Fake.Info", "get", 1),),
        cache_ttl=30,
    )
    engine = Engine(
        Catalog([op]),
        FakeDsm({"SYNO.Fake.Info.get": {"model": "DS918+"}}),
        audit,
        settings,
        clock=clock,
    )
    p = principal("system:read")
    await engine.run("fake.mut", {}, p, channel="rest", client_ip=None)
    env = await engine.run("fake.mut", {}, p, channel="rest", client_ip=None)
    assert env.cached and env.data == {"model": "DS918+"}


class Ids(BaseModel):
    ids: dict[str, str]


LIST = DsmCall("SYNO.Fake.Task", "list", 1)
STATUS = DsmCall(
    "SYNO.Fake.Task",
    "status",
    1,
    params={"detail": "true"},
    each=Each(source=LIST.key, items="task_list", key="task_id", limit=3),
)


def _ids(ctx, responses):
    return Ids(ids={k: v["state"] for k, v in responses[STATUS.key].items()})


def tasks_op(*calls):
    return Operation(
        id="fake.tasks",
        title="t",
        description="d",
        kind="read",
        scope="backup:read",
        path="/fake/tasks",
        result_model=Ids,
        transform=_ids,
        calls=calls or (LIST, STATUS),
    )


def tasks_dsm(task_list):
    return FakeDsm(
        {
            "SYNO.Fake.Task.list": {"task_list": task_list},
            "SYNO.Fake.Task.status": lambda p: {"state": f"ok-{p['task_id']}"},
        }
    )


async def test_each_call_runs_once_per_item(audit, settings, clock):
    dsm = tasks_dsm([{"task_id": 1}, {"task_id": 2}])
    engine = Engine(Catalog([tasks_op()]), dsm, audit, settings, clock=clock)
    env = await engine.run(
        "fake.tasks", {}, principal("backup:read"), channel="rest", client_ip=None
    )
    assert env.data == {"ids": {"1": "ok-1", "2": "ok-2"}}
    statuses = [c for c in dsm.calls if c[1] == "status"]
    assert sorted(c[2]["task_id"] for c in statuses) == [1, 2]
    assert all(c[2]["detail"] == "true" for c in statuses)


async def test_each_skips_odd_values_and_stops_at_limit(audit, settings, clock):
    odd = [{"task_id": "../x"}, {"task_id": True}, {"task_id": {"a": 1}}, {"name": "sans id"}, 7]
    dsm = tasks_dsm([*odd, {"task_id": 1}, {"task_id": "b-2"}, {"task_id": 3}, {"task_id": 4}])
    engine = Engine(Catalog([tasks_op()]), dsm, audit, settings, clock=clock)
    env = await engine.run(
        "fake.tasks", {}, principal("backup:read"), channel="rest", client_ip=None
    )
    assert env.data == {"ids": {"1": "ok-1", "b-2": "ok-b-2", "3": "ok-3"}}


async def test_each_accepts_disk_devices_only_under_dev(audit, settings, clock):
    """Les disques s'appellent « /dev/sata1 » ; aucun autre chemin ne passe."""
    odd = [{"task_id": "/etc/passwd"}, {"task_id": "/dev/../etc"}, {"task_id": "/dev/sd a"}]
    dsm = tasks_dsm([*odd, {"task_id": "/dev/sata1"}, {"task_id": "/dev/nvme0n1"}])
    engine = Engine(Catalog([tasks_op()]), dsm, audit, settings, clock=clock)
    env = await engine.run(
        "fake.tasks", {}, principal("backup:read"), channel="rest", client_ip=None
    )
    assert env.data == {"ids": {"/dev/sata1": "ok-/dev/sata1", "/dev/nvme0n1": "ok-/dev/nvme0n1"}}


def test_each_needs_an_earlier_plain_call():
    with pytest.raises(ValueError):
        Catalog([tasks_op(STATUS, LIST)])
    with pytest.raises(ValueError):
        Catalog([tasks_op(STATUS)])


SHARES = DsmCall("SYNO.Fake.Share", "list", 1)
SNAPS = DsmCall(
    "SYNO.Fake.Share.Snapshot",
    "list",
    1,
    each=Each(source=SHARES.key, items="shares", key="name", as_json=True),
)


def _snaps(ctx, responses):
    return Ids(ids={k: str(v) for k, v in responses[SNAPS.key].items()})


def shares_op(*calls, transform=_snaps):
    return Operation(
        id="fake.shares",
        title="t",
        description="d",
        kind="read",
        scope="storage:read",
        path="/fake/shares",
        result_model=Ids,
        transform=transform,
        calls=calls or (SHARES, SNAPS),
    )


async def run_shares(op, dsm, audit, settings, clock, **kw):
    engine = Engine(Catalog([op]), dsm, audit, settings, clock=clock, **kw)
    env = await engine.run(
        "fake.shares", {}, principal("storage:read"), channel="rest", client_ip=None
    )
    return env.data


async def test_each_as_json_sends_encoded_names(audit, settings, clock):
    # DSM lit « true » ou « 2024 » comme un booléen ou un nombre : le nom part encodé en JSON.
    names = ["Compta été", "true", "2024", "a\nb", "x" * 256, 12, "Compta été"]
    dsm = FakeDsm(
        {
            "SYNO.Fake.Share.list": {"shares": [{"name": n} for n in names]},
            "SYNO.Fake.Share.Snapshot.list": lambda p: {"got": p["name"]},
        }
    )
    data = await run_shares(shares_op(), dsm, audit, settings, clock)
    assert data == {
        "ids": {
            "Compta été": str({"got": '"Compta été"'}),
            "true": str({"got": '"true"'}),
            "2024": str({"got": '"2024"'}),
        }
    }


async def test_optional_call_failure_gives_none(audit, settings, clock):
    # Un dossier sur un volume sans instantanés ne doit pas faire échouer toute la liste.
    snaps = DsmCall(
        "SYNO.Fake.Share.Snapshot",
        "list",
        1,
        each=Each(source=SHARES.key, items="shares", key="name", as_json=True),
        optional=True,
    )
    extra = DsmCall("SYNO.Fake.Extra", "get", 1, optional=True)

    def transform(ctx, responses):
        return Ids(
            ids={
                **{k: str(v) for k, v in responses[snaps.key].items()},
                "extra": str(responses[extra.key]),
            }
        )

    def snapshot(params):
        if params["name"] == '"ext4"':
            raise DsmError(402)
        return {"n": 1}

    dsm = FakeDsm(
        {
            "SYNO.Fake.Share.list": {"shares": [{"name": "btrfs"}, {"name": "ext4"}]},
            "SYNO.Fake.Share.Snapshot.list": snapshot,
            "SYNO.Fake.Extra.get": DsmUnsupported("SYNO.Fake.Extra"),
        }
    )
    op = shares_op(SHARES, snaps, extra, transform=transform)
    data = await run_shares(op, dsm, audit, settings, clock)
    assert data == {"ids": {"btrfs": "{'n': 1}", "ext4": "None", "extra": "None"}}


async def test_optional_call_does_not_hide_an_unreachable_dsm(audit, settings, clock):
    extra = DsmCall("SYNO.Fake.Extra", "get", 1, optional=True)
    dsm = FakeDsm(
        {"SYNO.Fake.Share.list": {"shares": []}, "SYNO.Fake.Extra.get": DsmUnreachable("x")}
    )
    op = shares_op(SHARES, extra, transform=lambda ctx, r: Ids(ids={}))
    with pytest.raises(OpError) as info:
        await run_shares(op, dsm, audit, settings, clock)
    assert info.value.status == 503


async def test_context_carries_fetch_time_from_wall_clock(audit, settings, clock):
    from datetime import UTC, datetime

    when = datetime(2026, 11, 9, 7, 0, tzinfo=UTC)
    op = shares_op(SHARES, transform=lambda ctx, r: Ids(ids={"at": ctx.fetched_at.isoformat()}))
    dsm = FakeDsm({"SYNO.Fake.Share.list": {"shares": []}})
    data = await run_shares(op, dsm, audit, settings, clock, wall_clock=lambda: when)
    assert data == {"ids": {"at": "2026-11-09T07:00:00+00:00"}}


async def test_optional_call_does_not_hide_a_login_refusal(audit, settings, clock):
    from nas_agent.dsm.gateway import DsmAuthError

    extra = DsmCall("SYNO.Fake.Extra", "get", 1, optional=True)
    dsm = FakeDsm(
        {"SYNO.Fake.Share.list": {"shares": []}, "SYNO.Fake.Extra.get": DsmAuthError(400)}
    )
    op = shares_op(SHARES, extra, transform=lambda ctx, r: Ids(ids={}))
    with pytest.raises(OpError) as info:
        await run_shares(op, dsm, audit, settings, clock)
    assert info.value.status == 502


# Opérations composées ------------------------------------------------------------------------


class Reads(BaseModel):
    reads: dict[str, str]
    personal: bool


def _reads(ctx, reads):
    def describe(sub):
        if sub.result is not None:
            return f"ok:{sub.result.model}"
        return f"{sub.error}:{sub.dsm_code}"

    return Reads(
        reads={k: describe(v) for k, v in reads.items()},
        personal="personal:read" in ctx.principal.scopes,
    )


def _info_of(api):
    return lambda ctx, r: Info(model=r[f"{api}.get"]["model"])


def composed_catalog(*extra):
    secret = Operation(
        id="fake.secret",
        title="Secret",
        description="d",
        kind="read",
        scope="personal:read",
        personal=True,
        path="/fake/secret",
        result_model=Info,
        transform=_info_of("SYNO.Fake.Secret"),
        calls=(DsmCall("SYNO.Fake.Secret", "get", 1),),
    )
    report = Operation(
        id="fake.report",
        title="Rapport",
        description="d",
        kind="read",
        scope="audit:read",
        path="/fake/report",
        result_model=Reads,
        transform=_reads,
        composes=("fake.info", "fake.secret"),
    )
    return Catalog([OPS[0], secret, report, *extra])


async def run_report(dsm, audit, settings, clock, *scopes):
    engine = Engine(composed_catalog(), dsm, audit, settings, clock=clock)
    env = await engine.run(
        "fake.report", {}, principal(*(scopes or ("audit:read",))), channel="rest", client_ip=None
    )
    return env, engine


async def test_composed_op_reads_without_inheriting_scopes(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "A"}, "SYNO.Fake.Secret.get": {"model": "B"}})
    env, engine = await run_report(dsm, audit, settings, clock)
    assert env.data == {"reads": {"fake.info": "ok:A", "fake.secret": "ok:B"}, "personal": False}
    # Une seule entrée au journal : l'opération composée, pas ses lectures.
    assert [e.op for e in audit.tail(10)] == ["fake.report"]
    # Les lectures passent par le cache commun, avec leur propre durée.
    again = await engine.run(
        "fake.info", {}, principal("system:read"), channel="rest", client_ip=None
    )
    assert again.cached is True and len(dsm.calls) == 2


@pytest.mark.parametrize(
    ("failure", "described"),
    [
        (DsmUnsupported("SYNO.Fake.Secret"), "unsupported:None"),
        (DsmError(105), "dsm_error:105"),
        ({"autre": 1}, "unexpected:None"),  # forme inattendue : la transformation échoue
    ],
)
async def test_composed_read_failure_is_reported_not_fatal(
    audit, settings, clock, failure, described
):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "A"}, "SYNO.Fake.Secret.get": failure})
    env, _ = await run_report(dsm, audit, settings, clock)
    assert env.data["reads"] == {"fake.info": "ok:A", "fake.secret": described}
    assert audit.tail(1)[0].outcome == "ok"


@pytest.mark.parametrize(
    ("failure", "status"),
    [(DsmUnreachable("x"), 503), (DsmCertificateError("x"), 503), ("auth", 502)],
)
async def test_composed_op_fails_when_dsm_is_down_or_refuses_login(
    audit, settings, clock, failure, status
):
    from nas_agent.dsm.gateway import DsmAuthError

    failure = DsmAuthError(400) if failure == "auth" else failure
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "A"}, "SYNO.Fake.Secret.get": failure})
    with pytest.raises(OpError) as info:
        await run_report(dsm, audit, settings, clock)
    assert info.value.status == status


async def test_composed_op_still_needs_its_own_scope(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "A"}, "SYNO.Fake.Secret.get": {"model": "B"}})
    with pytest.raises(OpError) as info:
        await run_report(dsm, audit, settings, clock, "system:read", "personal:read")
    assert info.value.status == 403 and dsm.calls == []


async def test_composed_op_sees_caller_scopes(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "A"}, "SYNO.Fake.Secret.get": {"model": "B"}})
    env, _ = await run_report(dsm, audit, settings, clock, "audit:read", "personal:read")
    assert env.data["personal"] is True


def test_catalog_rejects_bad_compositions():
    def report(**kw):
        base = dict(
            id="fake.bad",
            title="t",
            description="d",
            kind="read",
            scope="audit:read",
            path="/fake/bad",
            result_model=Reads,
            transform=_reads,
            composes=("fake.info",),
        )
        return Operation(**{**base, **kw})

    cases = [
        report(composes=("fake.missing",)),  # absente ou placée après
        report(calls=(DsmCall("SYNO.Fake.Info", "get", 1),)),  # appels et lectures mêlés
        report(composes=("fake.logs",)),  # lecture à paramètres
        report(params_model=LimitParams),
    ]
    for op in cases:
        with pytest.raises(ValueError):
            Catalog([*OPS, op])
    nested = report(id="fake.nested", path="/fake/nested", composes=("fake.bad",))
    with pytest.raises(ValueError):
        Catalog([*OPS, report(), nested])


# Lectures internes (relevé des constantes) ---------------------------------------------------


async def test_internal_read_shares_the_cache_without_journal(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "DS923+", "serial": "SECRET"}})
    engine = make(dsm, audit, settings, clock)
    result, fetched_at = await engine.read_internal("fake.info")
    assert result == Info(model="DS923+") and fetched_at is not None
    assert audit.tail() == []
    # La lecture d'un client passe ensuite par le même cache.
    env = await engine.run(
        "fake.info", {}, principal("system:read"), channel="rest", client_ip=None
    )
    assert env.cached is True and len(dsm.calls) == 1


async def test_internal_read_ignores_the_rate_limit(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": {"model": "x"}})
    engine = make(dsm, audit, settings, clock)
    for _ in range(settings.limits.calls_per_minute + 5):
        await engine.read_internal("fake.info")
    env = await engine.run(
        "fake.info", {}, principal("system:read"), channel="rest", client_ip=None
    )
    assert env.data == {"model": "x"}


async def test_internal_read_raises_dsm_errors_without_journal(audit, settings, clock):
    engine = make(FakeDsm({"SYNO.Fake.Info.get": DsmUnreachable("x")}), audit, settings, clock)
    with pytest.raises(DsmUnreachable):
        await engine.read_internal("fake.info")
    assert audit.tail() == []


async def test_internal_read_only_for_known_reads_with_valid_params(audit, settings, clock):
    dsm = FakeDsm({"SYNO.Fake.Info.get": lambda p: {"model": f"l{p['limit']}"}})
    engine = make(dsm, audit, settings, clock)
    with pytest.raises(ValueError):
        await engine.read_internal("nope.op")
    with pytest.raises(ValueError):
        await engine.read_internal("fake.logs", {"limit": "beaucoup"})
    with pytest.raises(ValueError):
        await engine.read_internal("fake.info", {"limit": 3})
    result, _ = await engine.read_internal("fake.logs", {"limit": 3})
    assert result == Info(model="l3")
    assert audit.tail() == []
