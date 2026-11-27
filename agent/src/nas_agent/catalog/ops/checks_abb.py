"""Active Backup for Business (conception 2026-11-26-meilleur-produit, section 3.8) : chaque
appareil sauvegardé à temps, et les sauvegardes des appareils copiées hors du NAS.

Un poste (PC ou Mac) s'éteint, part en voyage : son retard est un avertissement, au-delà de
`pc_backup_max_age_days`. Un serveur, une machine virtuelle ou un serveur de fichiers doit
suivre son planning : son retard ou son échec est un échec.
"""

from __future__ import annotations

from datetime import datetime

from nas_agent.catalog.ops.checks_backup import is_local
from nas_agent.catalog.ops.checks_base import (
    Reads,
    Spec,
    Verdict,
    ago,
    hours_between,
    pair,
    plural,
    worst,
)
from nas_agent.i18n import Lang, Text, say

_SOURCE = "backup.activebackup"
# Hyper Backup exige le dossier des données dédupliquées d'Active Backup en entier :
# « /<dossier>/@ActiveBackup » (son code, `isABBDataFolder`), ou le dossier partagé lui-même.
_ABB_DATA = "@ActiveBackup"


def _not_installed(lang: Lang) -> Verdict:
    return Verdict(
        "ok",
        say(
            lang,
            fr="Sans objet : Active Backup for Business n'est pas installé.",
            en="Not applicable: Active Backup for Business is not installed.",
        ),
    )


def _no_task(r: Reads) -> Verdict:
    return Verdict(
        "ok",
        r.say(
            fr="Sans objet : aucune tâche Active Backup.",
            en="Not applicable: no Active Backup task.",
        ),
    )


def _utc(iso: str | None) -> datetime | None:
    return datetime.fromisoformat(iso) if iso else None


def _label(task, device, lang: Lang) -> str:
    if device is not None and device.name:
        return device.name
    return task.name or say(lang, fr=f"tâche {task.id}", en=f"task {task.id}")


def _unit(task, device, r: Reads) -> tuple[str, str] | None:
    """(état, texte) d'un appareil en retard ou en échec ; None quand il va bien.

    Le résultat de l'appareil passe avant celui de la tâche (une machine virtuelle peut échouer
    seule) ; une tentative annulée n'est pas une faute, seul le retard compte alors.
    """
    name = _label(task, device, r.lang)
    pc = task.type == "pc"
    bad = "warning" if pc else "failed"
    result = (device.last_result if device is not None else None) or task.last_result
    last = device.last_success_at if device is not None else task.last_success_at
    age = hours_between(r.read_at(_SOURCE), _utc(last))
    if result == "failed" and not task.running:
        return bad, pair(r, name, r.say(fr="dernière sauvegarde en échec", en="last backup failed"))
    if result == "partial":
        return "warning", pair(
            r, name, r.say(fr="dernière sauvegarde partielle", en="last backup partial")
        )
    if age is None:
        if task.running:
            return None
        return bad, pair(r, name, r.say(fr="jamais sauvegardé", en="never backed up"))
    # Le délai admis tient aussi au planning : une tâche du lundi au vendredi attend 72 h.
    gap = (task.max_gap_hours or 0) + 2
    base = r.limits.pc_backup_max_age_days * 24 if pc else r.limits.backup_max_age_hours
    allowed = max(base, gap)
    if age <= allowed:
        return None
    if not pc and task.next_run_at is None:
        return "warning", pair(
            r,
            name,
            r.say(
                fr=f"sans planning, dernière réussite il y a {ago(age, 'fr')}",
                en=f"not scheduled, last success {ago(age, 'en')} ago",
            ),
        )
    return bad, pair(
        r,
        name,
        r.say(
            fr=f"dernière réussite il y a {ago(age, 'fr')}",
            en=f"last success {ago(age, 'en')} ago",
        ),
    )


def _devices(b, r: Reads) -> Verdict:
    if not b.tasks:
        return _no_task(r)
    if b.activated is False:
        return Verdict(
            "failed",
            r.say(
                fr="Active Backup n'est pas activé : aucune sauvegarde ne part.",
                en="Active Backup is not activated: no backup runs.",
            ),
            advice=r.say(
                fr="Ouvrir Active Backup for Business et l'activer avec un compte Synology.",
                en="Open Active Backup for Business and activate it with a Synology account.",
            ),
        )
    found = [_unit(task, device, r) for task in b.tasks for device in (task.devices or [None])]
    total = len(found)
    late = [f for f in found if f is not None]
    if not late:
        return Verdict(
            "ok",
            r.say(
                fr=f"{plural(total, 'appareil sauvegardé', 'appareils sauvegardés')} à temps.",
                en=f"{plural(total, 'device', 'devices')} backed up on time.",
            ),
        )
    return Verdict(
        worst(s for s, _ in late),
        r.say(
            fr=f"{plural(len(late), 'appareil', 'appareils')} en retard ou en échec sur {total}.",
            en=f"{plural(len(late), 'device', 'devices')} late or failed out of {total}.",
        ),
        tuple(text for _, text in late),
    )


def _copied(hyper_backup, storages: list[str]) -> set[str]:
    """Dossiers d'Active Backup qu'une tâche Hyper Backup copie hors du NAS."""
    copied = set()
    for task in hyper_backup.tasks:
        if is_local(task):
            continue
        for source in task.sources:
            parts = (source.path or "").strip("/").split("/")
            if parts[0] in storages and (len(parts) == 1 or parts[1:] == [_ABB_DATA]):
                copied.add(parts[0])
    return copied


def _offsite(b, r: Reads) -> Verdict:
    if not b.tasks:
        return _no_task(r)
    storages = b.storages or sorted({t.destination_share for t in b.tasks if t.destination_share})
    hyper_backup = r.get("backup.hyperbackup.tasks")
    if hyper_backup is None:
        return Verdict(
            "unknown",
            r.say(fr="Tâches Hyper Backup illisibles.", en="Hyper Backup tasks unreadable."),
        )
    missing = [s for s in storages if s not in _copied(hyper_backup, storages)]
    if missing:
        return Verdict(
            "warning",
            r.say(
                fr=f"Sauvegardes des appareils dans {plural(len(missing), 'dossier', 'dossiers')} "
                "sans copie hors du NAS : un vol, un incendie ou un rançongiciel les emporterait "
                "avec lui.",
                en=f"Device backups in {plural(len(missing), 'folder', 'folders')} with no copy "
                "off the NAS: a theft, a fire or ransomware would take them along.",
            ),
            tuple(missing),
        )
    return Verdict(
        "ok",
        r.say(
            fr="Sauvegardes des appareils copiées hors du NAS par Hyper Backup.",
            en="Device backups copied off the NAS by Hyper Backup.",
        ),
    )


_SUITES = (("microsoft365", "Microsoft 365"), ("google_workspace", "Google Workspace"))


def _cloud(c, r: Reads) -> Verdict:
    suites = [(label, getattr(c, key)) for key, label in _SUITES if getattr(c, key) is not None]
    if not suites:
        return Verdict(
            "ok",
            r.say(
                fr="Sans objet : ni Active Backup for Microsoft 365 ni for Google Workspace.",
                en="Not applicable: neither Active Backup for Microsoft 365 nor for Google "
                "Workspace.",
            ),
        )
    found: list[tuple[str, str]] = []
    total = 0
    for label, suite in suites:
        if suite.tasks and suite.activated is False:
            found.append(
                (
                    "failed",
                    r.say(
                        fr=f"{label} : paquet pas activé, aucune sauvegarde ne part",
                        en=f"{label}: package not activated, no backup runs",
                    ),
                )
            )
            continue
        for task in suite.tasks:
            total += 1
            name = task.name or label
            age = hours_between(r.read_at("backup.activebackup_cloud"), _utc(task.last_run_at))
            allowed = max(r.limits.backup_max_age_hours, (task.max_gap_hours or 0) + 2)
            if task.state in ("error", "inactive"):
                found.append(
                    (
                        "failed",
                        r.say(
                            fr=f"{name} : tâche inactive (état {task.state_code})",
                            en=f"{name}: task inactive (state {task.state_code})",
                        ),
                    )
                )
            elif task.last_result == "error":
                found.append(
                    (
                        "failed",
                        r.say(
                            fr=f"{name} : dernière sauvegarde en erreur, "
                            f"{plural(task.errors, 'élément', 'éléments')} en cause",
                            en=f"{name}: last backup in error, {task.errors} "
                            f"{'item' if task.errors == 1 else 'items'} at fault",
                        ),
                    )
                )
            elif task.state == "active" and (age is None or age > allowed):
                when = (
                    r.say(fr="jamais exécutée", en="never run")
                    if age is None
                    else r.say(
                        fr=f"dernière exécution il y a {ago(age, 'fr')}",
                        en=f"last run {ago(age, 'en')} ago",
                    )
                )
                found.append(("failed", pair(r, name, when)))
            elif task.last_result == "warning":
                found.append(
                    (
                        "warning",
                        r.say(
                            fr=f"{name} : dernière sauvegarde avec des avertissements",
                            en=f"{name}: last backup with warnings",
                        ),
                    )
                )
    if not found:
        if not total:
            return Verdict(
                "ok",
                r.say(
                    fr="Sans objet : aucune tâche Microsoft 365 ni Google Workspace.",
                    en="Not applicable: no Microsoft 365 or Google Workspace task.",
                ),
            )
        return Verdict(
            "ok",
            r.say(
                fr=f"{plural(total, 'tâche sauvegardée', 'tâches sauvegardées')} à temps.",
                en=f"{total} {'task' if total == 1 else 'tasks'} backed up on time.",
            ),
        )
    return Verdict(
        worst(s for s, _ in found),
        r.say(
            fr=f"{plural(len(found), 'souci', 'soucis')} sur les sauvegardes Microsoft 365 et "
            "Google Workspace.",
            en=f"{len(found)} {'issue' if len(found) == 1 else 'issues'} with the Microsoft 365 "
            "and Google Workspace backups.",
        ),
        tuple(text for _, text in found),
    )


SPECS = (
    Spec(
        "backup.abb_devices",
        Text(fr="Active Backup : appareils sauvegardés", en="Active Backup: devices backed up"),
        "high",
        (_SOURCE,),
        lambda t, lang: say(
            lang,
            fr=f"Chaque appareil sauvegardé avec succès : serveurs et machines virtuelles depuis "
            f"moins de {t.backup_max_age_hours} h, postes depuis moins de "
            f"{t.pc_backup_max_age_days} jours.",
            en=f"Every device backed up successfully: servers and virtual machines less than "
            f"{t.backup_max_age_hours} h ago, computers less than {t.pc_backup_max_age_days} "
            "days ago.",
        ),
        Text(
            fr="Ouvrir la tâche dans Active Backup for Business : vérifier que l'appareil est "
            "allumé et relié au NAS, lire le journal de la dernière sauvegarde, puis la relancer.",
            en="Open the task in Active Backup for Business: check that the device is on and "
            "connected to the NAS, read the log of the last backup, then run it again.",
        ),
        _devices,
        when_unsupported=_not_installed,
    ),
    Spec(
        "backup.cloud_accounts",
        Text(
            fr="Microsoft 365 et Google Workspace",
            en="Microsoft 365 and Google Workspace",
        ),
        "high",
        ("backup.activebackup_cloud",),
        lambda t, lang: say(
            lang,
            fr=f"Chaque tâche Active Backup for Microsoft 365 ou Google Workspace active, sans "
            f"erreur, exécutée depuis moins de {t.backup_max_age_hours} h ou selon son planning.",
            en=f"Every Active Backup for Microsoft 365 or Google Workspace task active, without "
            f"errors, run less than {t.backup_max_age_hours} h ago or as its schedule requires.",
        ),
        Text(
            fr="Ouvrir le paquet : vérifier la connexion au compte Microsoft ou Google (droits de "
            "l'application, clé de service), le dossier de destination, et lire le journal de la "
            "tâche.",
            en="Open the package: check the connection to the Microsoft or Google account (app "
            "permissions, service key), the destination folder, and read the task's log.",
        ),
        _cloud,
    ),
    Spec(
        "backup.abb_offsite",
        Text(fr="Active Backup : copie hors du NAS", en="Active Backup: copy off the NAS"),
        "medium",
        (_SOURCE, "backup.hyperbackup.tasks"),
        lambda _t, lang: say(
            lang,
            fr="Les sauvegardes des appareils sont copiées hors du NAS.",
            en="Device backups are copied off the NAS.",
        ),
        Text(
            fr="Ajouter le dossier @ActiveBackup du dossier en cause à une tâche Hyper Backup vers "
            "un autre NAS ou Synology C2, ou répliquer ce dossier vers un autre NAS avec Snapshot "
            "Replication (l'agent ne lit pas encore la réplication).",
            en="Add the @ActiveBackup folder of the folder concerned to a Hyper Backup task to "
            "another NAS or Synology C2, or replicate this folder to another NAS with Snapshot "
            "Replication (the agent does not read replication yet).",
        ),
        _offsite,
        when_unsupported=_not_installed,
    ),
)
