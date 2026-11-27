"""Contrôles des disques : voir la panne venir (conception 2026-11-26-meilleur-produit,
section 3.3). Usure lue dans SMART et son évolution sur 30 jours, tests SMART, nettoyage des
données, redondance des groupes.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from nas_agent.catalog.ops.checks_base import Reads, Spec, Verdict, pair, plural
from nas_agent.i18n import Text, say

TREND = timedelta(days=30)
SSD_LIFE_WARNING = 10
SSD_LIFE_FAILURE = 5


def _rise(r: Reads, disk_id: str | None) -> int:
    """Hausse des secteurs réalloués sur 30 jours, d'après l'historique (0 sans historique)."""
    if r.history is None or r.now is None or not disk_id:
        return 0
    points = r.history.read("120m", r.now - TREND).get(("disk_reallocated", disk_id), [])
    if len(points) < 2:
        return 0
    return max(0, round(points[-1].max - points[0].avg))


def _wear(s, r: Reads) -> Verdict:
    if not s.disks:
        return Verdict("unknown", r.say(fr="Aucun disque lu.", en="No disk read."))
    failed: list[str] = []
    warned: list[str] = []
    for d in s.disks:
        name = d.name or d.id or "?"
        bad: list[str] = []
        soft: list[str] = []
        rise = _rise(r, d.id)
        if d.pending_sectors:
            bad.append(
                r.say(
                    fr=f"{d.pending_sectors} secteurs en attente",
                    en=f"{d.pending_sectors} pending sectors",
                )
            )
        if d.uncorrectable_sectors:
            bad.append(
                r.say(
                    fr=f"{d.uncorrectable_sectors} secteurs illisibles",
                    en=f"{d.uncorrectable_sectors} uncorrectable sectors",
                )
            )
        if d.reallocated_sectors:
            text = r.say(
                fr=f"{d.reallocated_sectors} secteurs réalloués",
                en=f"{d.reallocated_sectors} reallocated sectors",
            )
            if rise:
                text += r.say(fr=f" (+{rise} en 30 jours)", en=f" (+{rise} in 30 days)")
            (bad if rise else soft).append(text)
        if d.failing_attributes:
            bad.append(", ".join(d.failing_attributes))
        if d.ssd_life_pct is not None and d.ssd_life_pct < SSD_LIFE_WARNING:
            life = r.say(
                fr=f"{d.ssd_life_pct} % de vie restante", en=f"{d.ssd_life_pct} % life left"
            )
            (bad if d.ssd_life_pct < SSD_LIFE_FAILURE else soft).append(life)
        if d.reported_uncorrect:
            soft.append(
                r.say(
                    fr=f"{d.reported_uncorrect} erreurs signalées",
                    en=f"{d.reported_uncorrect} reported errors",
                )
            )
        if d.crc_errors:
            soft.append(
                r.say(
                    fr=f"{d.crc_errors} erreurs de câble",
                    en=f"{d.crc_errors} cable errors",
                )
            )
        if bad:
            failed.append(pair(r, name, ", ".join(bad + soft)))
        elif soft:
            warned.append(pair(r, name, ", ".join(soft)))
    if failed or warned:
        n = len(failed) + len(warned)
        return Verdict(
            "failed" if failed else "warning",
            r.say(
                fr=f"{plural(n, 'disque montre', 'disques montrent')} des signes d'usure.",
                en=f"{plural(n, 'disk shows', 'disks show')} signs of wear.",
            ),
            tuple(failed + warned),
            advice=None
            if not failed
            else r.say(
                fr="Sauvegarder tout de suite, puis remplacer le disque qui faiblit avant "
                "qu'il ne lâche (Gestionnaire de stockage).",
                en="Back up right away, then replace the weakening disk before it fails "
                "(Storage Manager).",
            ),
        )
    hours = [d.power_on_hours for d in s.disks if d.power_on_hours]
    oldest = max(hours, default=None)
    years = f"{oldest / 24 / 365:.1f}" if oldest else ""
    tail = (
        r.say(
            fr=f", le plus ancien en marche depuis {years.replace('.', ',')} ans",
            en=f", the oldest running for {years} years",
        )
        if oldest
        else ""
    )
    n = len(s.disks)
    return Verdict(
        "ok",
        r.say(
            fr=f"{plural(n, 'disque', 'disques')} sans signe d'usure{tail}.",
            en=f"{plural(n, 'disk', 'disks')} without signs of wear{tail}.",
        ),
    )


def _smart_tests(s, r: Reads) -> Verdict:
    damaged = [d for d in s.disks if d.last_test_result == "damage"]
    if damaged:
        return Verdict(
            "failed",
            r.say(
                fr=f"Dernier test SMART en échec sur {plural(len(damaged), 'disque', 'disques')}.",
                en=f"Last SMART test failed on {plural(len(damaged), 'disk', 'disks')}.",
            ),
            tuple(d.name or d.id or "?" for d in damaged),
            advice=r.say(
                fr="Sauvegarder tout de suite, lancer un test étendu, et remplacer le disque si "
                "le test échoue encore.",
                en="Back up right away, run an extended test, and replace the disk if the test "
                "fails again.",
            ),
        )
    suggested = [d for d in s.disks if d.last_test_result == "extended_test_suggested"]
    if s.scheduled_tests is None:
        return Verdict(
            "unknown",
            r.say(fr="Planification des tests illisible.", en="Test schedule unreadable."),
        )
    enabled = [t for t in s.scheduled_tests if t.enabled]
    if not enabled:
        return Verdict(
            "warning",
            r.say(fr="Aucun test SMART planifié.", en="No SMART test scheduled."),
            tuple(d.name or d.id or "?" for d in suggested),
        )
    if suggested:
        return Verdict(
            "warning",
            r.say(
                fr="DSM conseille un test étendu sur "
                f"{plural(len(suggested), 'disque', 'disques')}.",
                en=f"DSM advises an extended test on {plural(len(suggested), 'disk', 'disks')}.",
            ),
            tuple(d.name or d.id or "?" for d in suggested),
        )
    return Verdict(
        "ok",
        r.say(
            fr=f"{plural(len(enabled), 'test SMART planifié', 'tests SMART planifiés')}.",
            en=f"{plural(len(enabled), 'SMART test', 'SMART tests')} scheduled.",
        ),
    )


def _age_days(iso: str | None, now: datetime | None) -> float | None:
    if iso is None or now is None:
        return None
    at = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (now - at.astimezone(UTC)).total_seconds() / 86400


def _scrubbing(s, r: Reads) -> Verdict:
    redundant = [p for p in s.pools if p.redundant]
    if not redundant:
        return Verdict(
            "ok",
            r.say(
                fr="Sans objet : aucun groupe de stockage redondant à nettoyer.",
                en="Not applicable: no redundant storage pool to scrub.",
            ),
        )
    scheduled = bool(s.scrubbing_schedule_enabled)
    late: list[str] = []
    for p in redundant:
        if scheduled or p.scrubbing_scheduled:
            continue
        age = _age_days(p.scrubbing_last_at, r.now)
        if age is None:
            late.append(pair(r, p.id or "?", r.say(fr="jamais nettoyé", en="never scrubbed")))
        elif age > r.limits.scrubbing_max_age_days:
            late.append(
                pair(
                    r,
                    p.id or "?",
                    r.say(
                        fr=f"dernier il y a {round(age)} jours", en=f"last {round(age)} days ago"
                    ),
                )
            )
    if late:
        return Verdict(
            "warning",
            r.say(
                fr="Nettoyage des données ni planifié ni récent.",
                en="Data scrubbing neither scheduled nor recent.",
            ),
            tuple(late),
        )
    return Verdict(
        "ok",
        r.say(
            fr="Nettoyage des données planifié ou récent.", en="Data scrubbing scheduled or recent."
        ),
    )


_RAID_NAMES = {
    "basic": Text(fr="Basic, un seul disque", en="Basic, a single disk"),
    "raid_0": Text(fr="RAID 0", en="RAID 0"),
    "raid_linear": Text(fr="JBOD", en="JBOD"),
    "shr_without_disk_protect": Text(fr="SHR sans protection", en="SHR without protection"),
}


def _redundancy(s, r: Reads) -> Verdict:
    alone = [p for p in s.pools if p.redundant is False]
    if not alone:
        return Verdict(
            "ok",
            r.say(
                fr="Chaque groupe de stockage survit à la perte d'un disque.",
                en="Every storage pool survives the loss of a disk.",
            ),
        )
    items = []
    for p in alone:
        volumes = ", ".join(v.path or v.id or "?" for v in s.volumes if v.pool_id == p.id)
        raid = _RAID_NAMES.get(p.raid or "")
        items.append(pair(r, volumes or p.id or "?", raid(r.lang) if raid else p.raid or "?"))
    return Verdict(
        "warning",
        r.say(
            fr=f"{plural(len(alone), 'groupe', 'groupes')} sans redondance : un disque qui lâche "
            "et le volume est perdu.",
            en=f"{plural(len(alone), 'pool', 'pools')} without redundancy: one failing disk and "
            "the volume is lost.",
        ),
        tuple(items),
    )


SPECS = (
    Spec(
        "storage.disk_wear",
        Text(fr="Disques qui faiblissent", en="Weakening disks"),
        "high",
        ("storage.smart",),
        lambda _t, lang: say(
            lang,
            fr="Aucun secteur en attente ni illisible, aucun secteur réalloué en hausse, SSD à "
            "plus de 10 % de vie.",
            en="No pending or uncorrectable sector, no rising reallocated sectors, SSDs above "
            "10 % life.",
        ),
        Text(
            fr="Surveiller le disque, vérifier son câble ou son tiroir, et prévoir son "
            "remplacement ; une sauvegarde à jour avant tout.",
            en="Watch the disk, check its cable or tray, and plan its replacement; an up-to-date "
            "backup first.",
        ),
        _wear,
    ),
    Spec(
        "storage.smart_tests",
        Text(fr="Tests SMART", en="SMART tests"),
        "medium",
        ("storage.smart",),
        lambda _t, lang: say(
            lang,
            fr="Un test SMART planifié, aucun test en échec.",
            en="A scheduled SMART test, no failed test.",
        ),
        Text(
            fr="Planifier un test rapide chaque semaine et un test étendu chaque trimestre "
            "(Gestionnaire de stockage, HDD/SSD, Planificateur de tests).",
            en="Schedule a quick test every week and an extended test every quarter (Storage "
            "Manager, HDD/SSD, Test Scheduler).",
        ),
        _smart_tests,
    ),
    Spec(
        "storage.scrubbing",
        Text(fr="Nettoyage des données", en="Data scrubbing"),
        "medium",
        ("storage.overview",),
        lambda t, lang: say(
            lang,
            fr=f"Sur un groupe redondant, nettoyage planifié ou fait depuis moins de "
            f"{t.scrubbing_max_age_days} jours.",
            en=f"On a redundant pool, scrubbing scheduled or done less than "
            f"{t.scrubbing_max_age_days} days ago.",
        ),
        Text(
            fr="Planifier le nettoyage des données (Gestionnaire de stockage, Stockage, "
            "Nettoyage des données) : il répare ce qui s'abîme en silence.",
            en="Schedule data scrubbing (Storage Manager, Storage, Data Scrubbing): it repairs "
            "what decays silently.",
        ),
        _scrubbing,
    ),
    Spec(
        "storage.redundancy",
        Text(fr="Redondance", en="Redundancy"),
        "medium",
        ("storage.overview",),
        lambda _t, lang: say(
            lang,
            fr="Chaque groupe de stockage survit à la perte d'un disque.",
            en="Every storage pool survives the loss of a disk.",
        ),
        Text(
            fr="Ajouter un disque pour passer en SHR protégé ou en RAID 1, et garder d'ici là "
            "une sauvegarde hors du NAS.",
            en="Add a disk to move to protected SHR or RAID 1, and keep a backup off the NAS "
            "until then.",
        ),
        _redundancy,
    ),
)
