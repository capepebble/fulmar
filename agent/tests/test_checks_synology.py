"""Failles connues et fin de vie (conception 2026-11-26-failles-fin-de-vie) : le NAS d'essai
retouché (modèle, version, paquets) face aux vraies pages de Synology du 2026-11-26."""

import copy
from dataclasses import replace

from nas_agent.catalog.ops import build_catalog
from nas_agent.engine import Engine
from nas_agent.synology import ModelStatus
from tests.conftest import FakeDsm, principal
from tests.real_nas import SynologyPages, nas_responses, real
from tests.test_audit_checks import READ_AT

INFO = "SYNO.DSM.Info.getinfo"
PACKAGES = "SYNO.Core.Package.list"


def nas(model="DS420+", version="DSM 7.4.1-90080 Update 2", packages=()):
    responses = nas_responses()
    info = copy.deepcopy(real("dsm_info"))
    info.update(model=model, version_string=version)
    responses[INFO] = info
    if packages:
        listing = copy.deepcopy(real("package_list"))
        listing["packages"] += [
            {"id": n.replace(" ", ""), "name": n, "version": v} for n, v in packages
        ]
        responses[PACKAGES] = listing
    return responses


class Pages(SynologyPages):
    def __init__(self, **changes):
        self.changes = changes

    def snapshot(self):
        return replace(super().snapshot(), **self.changes)


async def checks_of(audit, settings, responses, pages=None, lang=None):
    engine = Engine(
        build_catalog(), FakeDsm(responses), audit, settings, wall_clock=lambda: READ_AT
    )
    engine.synology = SynologyPages() if pages is None else pages
    env = await engine.run(
        "audit.checks", {}, principal("audit:checks"), channel="rest", client_ip=None, lang=lang
    )
    return {c["id"]: c for c in env.data["checks"]}


async def test_an_up_to_date_nas_has_no_known_flaw(audit, settings):
    checks = await checks_of(audit, settings, nas())
    assert checks["updates.advisories"]["status"] == "ok"
    assert checks["updates.advisories"]["observed"] == (
        "Aucune faille publiée par Synology ne touche ce NAS (9 avis lus)."
    )


async def test_a_ds215_plus_is_at_end_of_life_and_waits_for_a_fix(audit, settings):
    checks = await checks_of(audit, settings, nas("DS215+", "DSM 7.1.1-42962 Update 9"))
    life = checks["updates.lifecycle"]
    assert life["status"] == "failed"
    assert life["observed"] == (
        "Fin de vie : Synology ne publie plus aucune mise à jour pour le DS215+, même de sécurité."
    )
    assert life["advice"].startswith("Remplacer ce NAS ; d'ici là, le couper d'Internet")
    flaws = checks["updates.advisories"]
    # SA-26:21 vise DSM 7.1 sans correctif encore (page lue avant sa mise à jour du jour) ;
    # SA-23:07, modérée, ne sera jamais corrigée en 7.1 : un avertissement, pas un échec.
    assert flaws["status"] == "warning"
    assert flaws["items"] == [
        "Synology-SA-26:21, critique : pas encore de correctif pour DSM 7.1",
        "Synology-SA-23:07, modérée : Synology ne la corrigera pas sur DSM 7.1",
    ]
    assert flaws["advice"].startswith("Passer à une version de DSM que Synology corrige")


async def test_an_old_build_fails_on_critical_flaws(audit, settings):
    checks = await checks_of(audit, settings, nas(version="DSM 7.2.2-72806 Update 3"), lang="en")
    flaws = checks["updates.advisories"]
    assert flaws["status"] == "failed"
    assert flaws["items"][:2] == [
        "Synology-SA-26:21, critical: no fix yet for DSM 7.2.2",
        # Les réponses du NAS d'essai disent que DSM ne propose aucune mise à jour.
        "Synology-SA-26:19, critical: DSM 7.2.2-72806-10 fixes it, which DSM does not offer to "
        "this NAS",
    ]
    assert flaws["observed"] == "4 flaws published by Synology affect this NAS, 3 with a fix."


async def test_installed_packages_are_compared(audit, settings):
    responses = nas(packages=[("PHP 8.2", "8.2.30-0100")])
    checks = await checks_of(audit, settings, responses)
    assert checks["updates.advisories"]["status"] == "failed"
    assert checks["updates.advisories"]["items"] == [
        "Synology-SA-26:22, importante : PHP 8.2 8.2.36-0172 la corrige",
        "Synology-SA-26:14, critique : PHP 8.2 8.2.35-0171 la corrige",
    ]


async def test_limited_unlisted_and_unread(audit, settings):
    limited = Pages(
        models={"DS420+": ModelStatus("DS420+", "limited", "limited", "discontinued", 3)}
    )
    checks = await checks_of(audit, settings, nas(), limited)
    assert checks["updates.lifecycle"]["status"] == "warning"
    assert checks["updates.lifecycle"]["advice"] == "Prévoir son remplacement : la fin de vie suit."
    checks = await checks_of(audit, settings, nas("DS9999+"))
    assert checks["updates.lifecycle"]["status"] == "unknown"
    assert checks["updates.lifecycle"]["observed"] == "DS9999+ absent de la liste de Synology."
    unread = Pages(advisories=[], models={}, feed_read_at=None, models_read_at=None, error="X")
    checks = await checks_of(audit, settings, nas(), unread)
    assert checks["updates.advisories"]["status"] == "unknown"
    assert checks["updates.advisories"]["observed"] == (
        "Avis de sécurité de Synology pas encore lus (X)."
    )


async def test_reading_turned_off_says_how(audit, settings):
    engine = Engine(build_catalog(), FakeDsm(nas()), audit, settings, wall_clock=lambda: READ_AT)
    env = await engine.run(
        "updates.synology", {}, principal("system:read"), channel="rest", client_ip=None
    )
    assert env.data["read"] is False
    assert env.data["error"].endswith("([synology] enabled = false).")


async def test_the_operation_lists_what_affects_the_nas(audit, settings):
    engine = Engine(
        build_catalog(),
        FakeDsm(nas(version="DSM 7.4.1-90080 Update 1")),
        audit,
        settings,
        wall_clock=lambda: READ_AT,
    )
    engine.synology = SynologyPages()
    env = await engine.run(
        "updates.synology", {}, principal("system:read"), channel="rest", client_ip=None
    )
    data = env.data
    assert data["dsm_version"] == "DSM 7.4.1-90080 Update 1"
    assert data["lifecycle"]["updates"] == "full"
    assert [(f["id"], f["state"], f["fixed_in"]) for f in data["findings"]] == [
        ("Synology-SA-26:21", "affected", "7.4.1-90080-2")
    ]
    assert data["findings"][0]["url"].startswith("https://www.synology.com/")
    assert data["fixed"] == 2


async def test_a_fix_that_dsm_does_not_offer_is_said(audit, settings):
    # DS215+ en fin de vie : la 7.1 reçoit encore des correctifs, que DSM ne lui propose pas.
    responses = nas("DS215+", "DSM 7.1.1-42962 Update 9")
    from nas_agent.synology import Advisory, Fix, ProductRow

    row = ProductRow("DSM 7.1", "Critical", "fix", (Fix("7.1.1-42962-10"),))
    extra = Advisory(
        "Synology-SA-26:99", "t", "https://www.synology.com/x", None, None, None, None, (row,)
    )
    pages = Pages(advisories=[*SynologyPages().snapshot().advisories, extra])
    checks = await checks_of(audit, settings, responses, pages)
    assert (
        "Synology-SA-26:99, critique : DSM 7.1.1-42962-10 la corrige, que DSM ne propose pas à ce NAS"
        in (checks["updates.advisories"]["items"])
    )
    assert checks["updates.advisories"]["sources"] == ["updates.synology", "dsm.update"]
