"""Failles publiées par Synology et suivi du modèle (conception 2026-11-26-failles-fin-de-vie).

Lu dans updates.synology : aucun appel propre.
"""

from __future__ import annotations

from nas_agent.catalog.ops.checks_base import Reads, Spec, Verdict, plural, worst
from nas_agent.i18n import Lang, Text, say

_SOURCE = "updates.synology"
# Gravités de Synology ; « Critical » et « Important » demandent la mise à jour sans attendre.
_URGENT = {"critical", "important"}
_SEVERITY_FR = {
    "critical": "critique",
    "important": "importante",
    "moderate": "modérée",
    "low": "faible",
}


def _severity(value: str | None, lang: Lang) -> str:
    key = (value or "").lower()
    if lang == "fr":
        return _SEVERITY_FR.get(key, key or "gravité inconnue")
    return key or "unknown severity"


def _not_read(s, r: Reads) -> Verdict | None:
    if s.read:
        return None
    why = f" ({s.error})" if s.error else ""
    return Verdict(
        "unknown",
        r.say(
            fr=f"Avis de sécurité de Synology pas encore lus{why}.",
            en=f"Synology's security advisories not read yet{why}.",
        ),
        advice=r.say(
            fr="Vérifier que l'agent joint www.synology.com en HTTPS ; la lecture reprend "
            "toute seule.",
            en="Check that the agent reaches www.synology.com over HTTPS; reading resumes on "
            "its own.",
        ),
    )


def _no_offer(r: Reads) -> bool:
    """DSM a interrogé Synology et ne propose aucune mise à jour à ce NAS."""
    u = r.get("dsm.update")
    return u is not None and u.check_ok is True and u.update_available is False


def _item(f, r: Reads) -> str:
    sev = _severity(f.severity, r.lang)
    if f.state == "no_fix":
        return r.say(
            fr=f"{f.id}, {sev} : pas encore de correctif pour {f.product}",
            en=f"{f.id}, {sev}: no fix yet for {f.product}",
        )
    if f.state == "wont_fix":
        return r.say(
            fr=f"{f.id}, {sev} : Synology ne la corrigera pas sur {f.product}",
            en=f"{f.id}, {sev}: Synology will not fix it on {f.product}",
        )
    when = (
        r.say(fr=f", annoncée pour le {f.scheduled_by}", en=f", announced for {f.scheduled_by}")
        if f.scheduled_by
        else ""
    )
    name = "DSM" if f.product.startswith("DSM ") else f.product.split(" for DSM ")[0]
    what = f"{name} {f.fixed_in}"
    if f.other_branch:
        return r.say(
            fr=f"{f.id}, {sev} : corrigée seulement en passant à {what}",
            en=f"{f.id}, {sev}: fixed only by moving to {what}",
        )
    # Un correctif publié pour la branche n'est pas forcément proposé au modèle (fin de vie) :
    # DSM dit lui-même s'il propose une mise à jour à ce NAS.
    if name == "DSM" and not f.scheduled_by and _no_offer(r):
        when += r.say(
            fr=", que DSM ne propose pas à ce NAS",
            en=", which DSM does not offer to this NAS",
        )
    return r.say(
        fr=f"{f.id}, {sev} : {what} la corrige{when}",
        en=f"{f.id}, {sev}: {what} fixes it{when}",
    )


def _advisories(s, r: Reads) -> Verdict:
    unread = _not_read(s, r)
    if unread is not None:
        return unread
    if s.dsm_version is None:
        return Verdict(
            "unknown", r.say(fr="Version de DSM illisible.", en="DSM version unreadable.")
        )
    if not s.findings:
        return Verdict(
            "ok",
            r.say(
                fr=f"Aucune faille publiée par Synology ne touche ce NAS "
                f"({plural(s.advisories_known, 'avis lu', 'avis lus')}).",
                en=f"No flaw published by Synology affects this NAS ({s.advisories_known} "
                f"{'advisory' if s.advisories_known == 1 else 'advisories'} read).",
            ),
        )
    statuses = [
        "failed" if f.state == "affected" and (f.severity or "").lower() in _URGENT else "warning"
        for f in s.findings
    ]
    fixable = [f for f in s.findings if f.state == "affected"]
    n = len(s.findings)
    observed = r.say(
        fr=f"{plural(n, 'faille publiée', 'failles publiées')} par Synology "
        f"{'touche' if n == 1 else 'touchent'} ce NAS"
        + (f", {len(fixable)} avec un correctif." if fixable else ", sans correctif encore."),
        en=f"{n} {'flaw' if n == 1 else 'flaws'} published by Synology "
        f"{'affects' if n == 1 else 'affect'} this NAS"
        + (f", {len(fixable)} with a fix." if fixable else ", with no fix yet."),
    )
    advice = None
    if any(f.state == "wont_fix" or f.other_branch for f in s.findings):
        advice = r.say(
            fr="Passer à une version de DSM que Synology corrige si le modèle l'accepte ; sinon "
            "couper le service en cause ou l'accès depuis Internet, et prévoir le remplacement "
            "du NAS.",
            en="Move to a DSM version that Synology fixes if the model allows it; otherwise turn "
            "off the service concerned or access from the Internet, and plan to replace the NAS.",
        )
    elif not fixable:
        advice = r.say(
            fr="Lire l'avis de Synology : il dit souvent quoi couper en attendant (service, "
            "accès depuis Internet) ; le correctif viendra par la mise à jour de DSM.",
            en="Read Synology's advisory: it often says what to turn off meanwhile (a service, "
            "access from the Internet); the fix will come with a DSM update.",
        )
    return Verdict(worst(statuses), observed, tuple(_item(f, r) for f in s.findings), advice)


def _lifecycle(s, r: Reads) -> Verdict:
    unread = _not_read(s, r)
    if unread is not None:
        return unread
    life = s.lifecycle
    if life is None:
        return Verdict(
            "unknown",
            r.say(
                fr="Statut des modèles de Synology pas encore lu.",
                en="Synology's model status not read yet.",
            ),
        )
    if not life.listed:
        return Verdict(
            "unknown",
            r.say(
                fr=f"{life.model} absent de la liste de Synology.",
                en=f"{life.model} missing from Synology's list.",
            ),
        )
    if life.updates == "end_of_life":
        return Verdict(
            "failed",
            r.say(
                fr=f"Fin de vie : Synology ne publie plus aucune mise à jour pour le "
                f"{life.model}, même de sécurité.",
                en=f"End of life: Synology no longer publishes any update for the "
                f"{life.model}, not even security ones.",
            ),
        )
    if life.updates == "limited":
        return Verdict(
            "warning",
            r.say(
                fr=f"Synology ne publie plus que des correctifs de sécurité pour le {life.model}.",
                en=f"Synology only publishes security fixes for the {life.model} now.",
            ),
            advice=r.say(
                fr="Prévoir son remplacement : la fin de vie suit.",
                en="Plan its replacement: end of life comes next.",
            ),
        )
    if life.updates == "full":
        return Verdict(
            "ok",
            r.say(
                fr=f"Synology suit le {life.model} : mises à jour complètes.",
                en=f"Synology supports the {life.model}: full updates.",
            ),
        )
    return Verdict(
        "unknown",
        r.say(
            fr=f"Statut de mise à jour du {life.model} non reconnu.",
            en=f"Update status of the {life.model} not recognized.",
        ),
    )


SPECS = (
    Spec(
        "updates.advisories",
        Text(fr="Failles connues de Synology", en="Known Synology flaws"),
        "high",
        (_SOURCE, "dsm.update"),
        lambda _t, lang: say(
            lang,
            fr="Aucune faille publiée par Synology ne touche la version de DSM ni les paquets "
            "installés.",
            en="No flaw published by Synology affects the DSM version or the installed packages.",
        ),
        Text(
            fr="Installer la mise à jour qui corrige (Panneau de configuration, Mise à jour et "
            "restauration ; Centre de paquets pour un paquet), en commençant par les failles "
            "critiques.",
            en="Install the update that fixes it (Control Panel, Update & Restore; Package "
            "Center for a package), critical flaws first.",
        ),
        _advisories,
    ),
    Spec(
        "updates.lifecycle",
        Text(fr="Suivi du modèle par Synology", en="Model support by Synology"),
        "high",
        (_SOURCE,),
        lambda _t, lang: say(
            lang,
            fr="Synology publie encore des mises à jour pour ce modèle.",
            en="Synology still publishes updates for this model.",
        ),
        Text(
            fr="Remplacer ce NAS ; d'ici là, le couper d'Internet (QuickConnect, ports ouverts sur "
            "la box) et garder une sauvegarde hors de lui.",
            en="Replace this NAS; until then, cut it off from the Internet (QuickConnect, ports "
            "open on the router) and keep a backup off it.",
        ),
        _lifecycle,
    ),
)
