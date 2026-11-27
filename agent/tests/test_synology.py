"""Lecture des pages de Synology et comparaison des versions (conception
2026-11-26-failles-fin-de-vie), sur des extraits réels lus le 2026-11-26."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from nas_agent.synology import (
    FEED_URL,
    STATUS_URL,
    FeedItem,
    FetchError,
    SynologyFeed,
    assess,
    dsm_version,
    parse_advisory,
    parse_feed,
    parse_models,
)

FIXTURES = Path(__file__).parent / "fixtures" / "synology"


def page(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def items():
    return {i.id: i for i in parse_feed(page("rssfeed_security.xml"))}


def advisory(slug: str):
    sa = "Synology-SA-" + slug.replace("_", ":")
    url = f"https://www.synology.com/en-global/security/advisory/Synology_SA_{slug}"
    item = items().get(sa) or FeedItem(sa, sa, url, None)
    return parse_advisory(page(f"Synology_SA_{slug}.html"), item)


def test_feed_keeps_only_numbered_advisories():
    found = parse_feed(page("rssfeed_security.xml"))
    assert [i.id for i in found[:3]] == [
        "Synology-SA-26:22",
        "Synology-SA-26:21",
        "Synology-SA-26:20",
    ]
    assert all(i.id.startswith("Synology-SA-") for i in found)
    first = found[0]
    assert first.url == "https://www.synology.com/en-global/security/advisory/Synology_SA_26_22"
    assert first.published_at == "2026-11-24T02:49:08+00:00"


def test_feed_with_entities_is_refused():
    bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel/></rss>'
    with pytest.raises(ValueError):
        parse_feed(bomb)


def test_advisory_header_and_products():
    a = advisory("26_19")
    assert (a.title, a.severity, a.status) == ("Synology-SA-26:19 DSM", "Critical", "Resolved")
    assert a.published_at == "2026-11-10T09:06:42+00:00"
    assert [r.product for r in a.products] == ["DSM 7.4", "DSM 7.3", "DSM 7.2"]
    dsm72 = a.products[2]
    assert [f.version for f in dsm72.fixes] == ["7.2.2-72806-10", "7.2.1-69057-13"]
    assert not a.needs_reread


def test_ongoing_scheduled_and_not_affected():
    a = advisory("26_21")
    rows = {r.product: r for r in a.products}
    assert a.status == "Ongoing" and a.needs_reread
    assert rows["DSM 7.4"].fixes[0].version == "7.4.1-90080-2"
    assert rows["DSM 7.4"].fixes[0].scheduled_by == "2026-11-20"
    assert rows["DSM 7.2.2"].kind == "ongoing"
    assert rows["DSM 7.1"].kind == "ongoing"
    assert rows["SRM 1.3"].kind == "not_affected"


def test_package_rows_with_conditions():
    rows = {r.product: r for r in advisory("26_22").products}
    assert rows["Hyper Backup"].kind == "not_affected"
    php = rows["PHP 8.2"].fixes
    assert [(f.version, f.condition) for f in php] == [
        ("8.2.36-0172", "DSM 7.2 or above"),
        ("8.2.36-0135", "DSM Enterprise 1.0 or above"),
    ]


@pytest.mark.parametrize(
    ("text", "parts"),
    [
        ("DSM 7.4.1-90080 Update 2", ((7, 4, 1), 90080, 2)),
        ("7.4.1-90080-1", ((7, 4, 1), 90080, 1)),
        ("7.4-90075", ((7, 4), 90075, 0)),
        ("DSM 7.1.1-42962 Update 9", ((7, 1, 1), 42962, 9)),
    ],
)
def test_dsm_versions(text, parts):
    v = dsm_version(text)
    assert (v.branch, v.build, v.update) == parts


def states(slug, version, packages=()):
    return [
        (f.product, f.state, f.fixed_in)
        for f in assess(advisory(slug), dsm_version(version), list(packages))
    ]


def test_the_test_nas_on_update_2_is_fixed():
    nas = "DSM 7.4.1-90080 Update 2"
    assert states("26_19", nas) == [("DSM 7.4", "fixed", "7.4.1-90080-1")]
    assert states("26_21", nas) == [("DSM 7.4", "fixed", "7.4.1-90080-2")]
    # « 7.4-90075 » : un build plus ancien que celui du NAS, déjà dépassé.
    assert states("26_13", nas) == [("DSM 7.4", "fixed", None)]


def test_update_1_is_affected_by_the_scheduled_fix():
    found = assess(advisory("26_21"), dsm_version("DSM 7.4.1-90080 Update 1"), [])
    assert [(f.state, f.fixed_in, f.scheduled_by, f.severity) for f in found] == [
        ("affected", "7.4.1-90080-2", "2026-11-20", "Critical")
    ]


def test_the_most_precise_branch_wins():
    assert states("26_19", "DSM 7.2.2-72806 Update 9") == [
        ("DSM 7.2", "affected", "7.2.2-72806-10")
    ]
    assert states("24_20", "DSM 7.2.1-69057 Update 5") == [
        ("DSM 7.2.1", "affected", "7.2.1-69057-6")
    ]
    assert states("24_20", "DSM 7.2-64570 Update 4") == [("DSM 7.2", "fixed", "7.2-64570-4")]


def test_a_71_nas_without_a_fix_and_an_unlisted_branch():
    assert states("26_21", "DSM 7.1.1-42962 Update 9") == [("DSM 7.1", "no_fix", None)]
    assert states("26_19", "DSM 7.1.1-42962 Update 9") == []


def test_a_build_between_two_branches_needs_the_next_fix():
    # 7.2.2 en 72803 : ni 72806 ni 69057 ; la correction de build supérieur s'applique.
    assert states("26_19", "DSM 7.2.2-72803") == [("DSM 7.2", "affected", "7.2.2-72806-10")]


def test_packages_installed_are_compared():
    nas = "DSM 7.4.1-90080 Update 2"
    assert states("26_22", nas, [("PHP 8.2", "8.2.30-0100"), ("Hyper Backup", "4.2.2-4262")]) == [
        ("PHP 8.2", "affected", "8.2.36-0172")
    ]
    assert states("26_22", nas, [("PHP 8.2", "8.2.36-0172")]) == [
        ("PHP 8.2", "fixed", "8.2.36-0172")
    ]
    assert states("26_22", nas, [("PHP 8.4", "8.4.28-0052")]) == [
        ("PHP 8.4", "fixed", "8.4.28-0052")
    ]


def test_package_rows_for_one_dsm_branch():
    assert states("25_10", "DSM 7.2.2-72806 Update 3", [("RADIUS Server", "3.0.27-0400")]) == [
        ("RADIUS Server for DSM 7.2.2", "affected", "3.0.27-0516")
    ]
    assert states("25_10", "DSM 7.4.1-90080 Update 2", [("RADIUS Server", "3.0.27-0400")]) == []


def test_models():
    models = parse_models(page("products_status.html"))
    assert models["DS215+"].updates == "end_of_life"
    assert models["DS420+"].updates == "full"
    assert models["DS420+"].warranty_years == 3
    assert models["DS420+"].availability == "discontinued"
    assert "RT1900ac" not in models and "PAS7700" not in models


class FakeSite:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls: list[str] = []

    async def __call__(self, url: str) -> str:
        self.calls.append(url)
        if self.fail:
            raise FetchError("unreachable")
        if url == FEED_URL:
            return page("rssfeed_security.xml")
        if url == STATUS_URL:
            return page("products_status.html")
        slug = url.rsplit("/", 1)[1]
        path = FIXTURES / f"{slug}.html"
        return path.read_text() if path.exists() else page("Synology_SA_26_19.html")


class Clock:
    def __init__(self):
        self.now = datetime(2026, 11, 26, 9, tzinfo=UTC)

    def __call__(self):
        return self.now


async def test_feed_reads_once_then_only_what_is_due(tmp_path):
    site, clock = FakeSite(), Clock()
    feed = SynologyFeed(tmp_path / "synology", fetch=site, clock=clock, pause_s=0)
    await feed.refresh()
    snap = feed.snapshot()
    # Le flux réduit compte treize avis numérotés, douze depuis 2021 ; plus le flux et le statut.
    assert len(snap.advisories) == 12 and "DS215+" in snap.models
    assert len(site.calls) == 14 and snap.error is None
    site.calls.clear()
    clock.now += timedelta(hours=1)
    await feed.refresh()
    assert site.calls == []
    clock.now += timedelta(hours=24)
    await feed.refresh()
    # Douze heures passées : le flux ; l'avis en cours (SA-26:21) est relu.
    assert site.calls == [
        FEED_URL,
        "https://www.synology.com/en-global/security/advisory/Synology_SA_26_21",
    ]
    # Un nouveau lecteur repart du cache disque, sans rien relire.
    again = SynologyFeed(tmp_path / "synology", fetch=FakeSite(fail=True), clock=clock, pause_s=0)
    assert len(again.snapshot().advisories) == 12


async def test_unreachable_site_is_said_and_retried_later(tmp_path):
    site, clock = FakeSite(fail=True), Clock()
    feed = SynologyFeed(tmp_path, fetch=site, clock=clock, pause_s=0)
    await feed.refresh()
    assert feed.snapshot().error == "FetchError: unreachable"
    clock.now += timedelta(minutes=30)
    await feed.refresh()
    assert len(site.calls) == 1


class Stream:
    """Comme le flux d'aiohttp : `read(n)` rend un morceau à la fois, puis b""."""

    def __init__(self, data: bytes, chunk: int):
        self.data, self.chunk = data, chunk

    async def read(self, n: int) -> bytes:
        part, self.data = self.data[: min(n, self.chunk)], self.data[min(n, self.chunk) :]
        return part


async def test_the_whole_body_is_read_in_chunks_with_a_limit(monkeypatch):
    import nas_agent.synology as synology

    assert await synology._read_all(Stream(b"x" * 100_000, 1000)) == b"x" * 100_000
    monkeypatch.setattr(synology, "MAX_BYTES", 50_000)
    with pytest.raises(FetchError):
        await synology._read_all(Stream(b"x" * 100_000, 1000))


def test_will_not_fix_and_a_fix_only_on_another_branch():
    rows = {r.product: r for r in advisory("23_07").products}
    assert rows["DSM 7.1"].kind == "wont_fix" and rows["DSM 7.2"].kind == "fix"
    assert states("23_07", "DSM 7.1.1-42962 Update 9") == [("DSM 7.1", "wont_fix", None)]
    php73 = {r.product: r for r in advisory("26_14").products}["PHP 7.3"]
    assert php73.kind == "wont_fix"


def test_conditions_by_dsm_range_or_exact_branch():
    found = {
        dsm: states(
            "26_14", dsm, [("PHP 7.4", "7.4.33-0100"), ("Synology Calendar", "2.4.8-10948")]
        )
        for dsm in (
            "DSM 7.4.1-90080 Update 2",
            "DSM 7.1.1-42962 Update 9",
            "DSM 6.2.4-25556 Update 7",
        )
    }
    assert found["DSM 7.4.1-90080 Update 2"] == [
        ("Synology Calendar", "affected", "3.0.4-21435"),
        ("PHP 7.4", "affected", "7.4.33-0131"),
    ]
    assert found["DSM 7.1.1-42962 Update 9"] == [
        ("Synology Calendar", "fixed", "2.4.8-10948"),
        ("PHP 7.4", "affected", "7.4.33-0122"),
    ]
    # 0100 vient après 0010 : sur DSM 6.2, ce PHP 7.4 est déjà corrigé.
    assert found["DSM 6.2.4-25556 Update 7"] == [
        ("Synology Calendar", "fixed", "2.4.8-0948"),
        ("PHP 7.4", "fixed", "7.4.33-0010"),
    ]


def test_a_fix_on_a_newer_branch_only_is_said():
    # Forme vue en direct sur SA-23:02 : la ligne « DSM 7.1 » renvoie à une version 7.2.
    from nas_agent.synology import Advisory, Fix, ProductRow

    row = ProductRow("DSM 7.1", "Important", "fix", (Fix("7.2.1-69057"),))
    a = Advisory(
        "Synology-SA-23:02", "t", "https://www.synology.com/x", None, None, None, None, (row,)
    )
    (found,) = assess(a, dsm_version("DSM 7.1.1-42962 Update 9"), [])
    assert (found.state, found.fixed_in, found.other_branch) == ("affected", "7.2.1-69057", True)
    (same,) = assess(advisory("26_19"), dsm_version("DSM 7.2.2-72806 Update 9"), [])
    assert same.other_branch is False


async def test_a_cache_from_another_parser_is_read_again(tmp_path):
    import json

    site, clock = FakeSite(), Clock()
    await SynologyFeed(tmp_path, fetch=site, clock=clock, pause_s=0).refresh()
    path = tmp_path / "advisories.json"
    data = json.loads(path.read_text())
    data["parser"] = 1
    path.write_text(json.dumps(data))
    site.calls.clear()
    again = SynologyFeed(tmp_path, fetch=site, clock=clock, pause_s=0)
    assert again.snapshot().advisories == []
    await again.refresh()
    # Le flux et le statut sont frais : seules les pages sont relues.
    assert len(site.calls) == 12 and len(again.snapshot().advisories) == 12
