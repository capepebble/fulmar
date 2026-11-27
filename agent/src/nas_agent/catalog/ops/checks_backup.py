"""La règle 3-2-1 des sauvegardes (conception 2026-11-26-meilleur-produit, section 3.4) : une
copie hors du NAS, chaque dossier partagé sauvegardé, les copies distantes chiffrées.

Lu dans le détail des tâches Hyper Backup (destination, sources, chiffrement), la liste des
dossiers partagés et les destinations d'Active Backup ; aucun appel propre.
"""

from __future__ import annotations

from nas_agent.catalog.ops.checks_base import Reads, Spec, Verdict, plural
from nas_agent.i18n import Lang, Text, say

# Dossiers qui reçoivent eux-mêmes des sauvegardes, ou des enregistrements qui se gardent
# rarement : jamais exigés dans une tâche.
_RECEIVING = frozenset({"netbackup", "activebackupforbusiness", "surveillance"})


def is_local(task) -> bool:
    """« image:image_local » : dossier du NAS ou disque USB branché dessus."""
    return (task.kind or "").endswith("image_local") or (task.destination_share or "").startswith(
        "usbshare"
    )


def receiving(r: Reads) -> set[str]:
    """Dossiers qui reçoivent des sauvegardes : destinations locales de Hyper Backup, dossiers
    d'Active Backup, et ceux qui en reçoivent par nature (`_RECEIVING`, casse ignorée)."""
    hyper_backup = r.get("backup.hyperbackup.tasks")
    names = {t.destination_share for t in hyper_backup.tasks} if hyper_backup else set()
    abb = r.get("backup.activebackup")
    names |= set(abb.storages) if abb is not None else set()
    shares = r.get("shares.list")
    names |= {
        x.name for x in (shares.shares if shares else []) if (x.name or "").lower() in _RECEIVING
    }
    return {n for n in names if n}


def _name(task, lang: Lang) -> str:
    return task.name or say(lang, fr=f"tâche {task.id}", en=f"task {task.id}")


def _offsite(b, r: Reads) -> Verdict:
    if not b.tasks:
        return Verdict(
            "warning",
            r.say(fr="Aucune tâche Hyper Backup.", en="No Hyper Backup task."),
            advice=r.say(
                fr="Créer une tâche Hyper Backup vers un autre NAS, Synology C2 ou un stockage en "
                "ligne, ou vérifier que le NAS est sauvegardé autrement.",
                en="Create a Hyper Backup task to another NAS, Synology C2 or cloud storage, or "
                "check that the NAS is backed up another way.",
            ),
        )
    away = [t for t in b.tasks if not is_local(t)]
    if not away:
        n = len(b.tasks)
        return Verdict(
            "warning",
            r.say(
                fr=f"{plural(n, 'tâche', 'tâches')}, toutes vers le NAS lui-même ou un disque "
                "branché dessus : un vol, un incendie ou un rançongiciel les emporterait avec "
                "lui.",
                en=f"{plural(n, 'task', 'tasks')}, all to the NAS itself or a disk plugged into "
                "it: a theft, a fire or ransomware would take them along.",
            ),
            tuple(_name(t, r.lang) for t in b.tasks),
        )
    return Verdict(
        "ok",
        r.say(
            fr=f"{plural(len(away), 'tâche sauvegarde', 'tâches sauvegardent')} hors du NAS.",
            en=f"{plural(len(away), 'task backs', 'tasks back')} up off the NAS.",
        ),
    )


def _coverage(b, r: Reads) -> Verdict:
    shares = r.get("shares.list")
    if shares is None:
        return Verdict(
            "unknown", r.say(fr="Dossiers partagés illisibles.", en="Shared folders unreadable.")
        )
    covered = {
        (s.path or "").strip("/").split("/")[0] for t in b.tasks for s in t.sources if s.path
    }
    # Les dossiers qui reçoivent des sauvegardes (dont ceux d'Active Backup, dont la copie a
    # son contrôle) ne sont pas exigés dans une tâche.
    skip = receiving(r)
    missing = [
        s.name
        for s in shares.shares
        if s.name and not s.usb and s.name not in covered and s.name not in skip
    ]
    if missing:
        n = len(missing)
        return Verdict(
            "warning",
            r.say(
                fr=f"{plural(n, 'dossier partagé', 'dossiers partagés')} dans aucune sauvegarde.",
                en=f"{plural(n, 'shared folder', 'shared folders')} in no backup.",
            ),
            tuple(sorted(missing)),
        )
    return Verdict(
        "ok",
        r.say(
            fr="Chaque dossier partagé est dans une sauvegarde.",
            en="Every shared folder is in a backup.",
        ),
    )


def _encryption(b, r: Reads) -> Verdict:
    away = [t for t in b.tasks if not is_local(t)]
    if not away:
        return Verdict(
            "ok",
            r.say(
                fr="Sans objet : aucune copie hors du NAS.",
                en="Not applicable: no copy off the NAS.",
            ),
        )
    clear = [t for t in away if t.encrypted is False]
    if clear:
        return Verdict(
            "warning",
            r.say(
                fr=f"{plural(len(clear), 'copie', 'copies')} hors du NAS sans chiffrement côté "
                "client.",
                en=f"{plural(len(clear), 'copy', 'copies')} off the NAS without client-side "
                "encryption.",
            ),
            tuple(_name(t, r.lang) for t in clear),
        )
    return Verdict(
        "ok",
        r.say(fr="Copies hors du NAS chiffrées.", en="Copies off the NAS encrypted."),
    )


def _no_copy(lang: Lang) -> Verdict:
    return Verdict(
        "ok",
        say(
            lang,
            fr="Sans objet : aucune copie hors du NAS.",
            en="Not applicable: no copy off the NAS.",
        ),
    )


def _no_hyper_backup(lang: Lang) -> Verdict:
    return Verdict(
        "warning",
        say(lang, fr="Hyper Backup n'est pas installé.", en="Hyper Backup not installed."),
    )


SPECS = (
    Spec(
        "backup.offsite",
        Text(fr="Une copie hors du NAS", en="A copy off the NAS"),
        "high",
        ("backup.hyperbackup.tasks",),
        lambda _t, lang: say(
            lang,
            fr="Au moins une tâche sauvegarde hors du NAS (autre NAS, Synology C2, nuage).",
            en="At least one task backs up off the NAS (another NAS, Synology C2, cloud).",
        ),
        Text(
            fr="Ajouter une tâche Hyper Backup vers un autre NAS, Synology C2 ou un stockage en "
            "ligne : la règle 3-2-1 veut une copie ailleurs.",
            en="Add a Hyper Backup task to another NAS, Synology C2 or cloud storage: the 3-2-1 "
            "rule wants one copy elsewhere.",
        ),
        _offsite,
        when_unsupported=_no_hyper_backup,
    ),
    Spec(
        "backup.coverage",
        Text(fr="Dossiers sauvegardés", en="Backed-up folders"),
        "medium",
        ("backup.hyperbackup.tasks", "shares.list"),
        lambda _t, lang: say(
            lang,
            fr="Chaque dossier partagé est dans une sauvegarde.",
            en="Every shared folder is in a backup.",
        ),
        Text(
            fr="Ajouter ces dossiers à une tâche Hyper Backup, ou les sauvegarder autrement.",
            en="Add these folders to a Hyper Backup task, or back them up another way.",
        ),
        _coverage,
        when_unsupported=_no_hyper_backup,
    ),
    Spec(
        "backup.encryption",
        Text(fr="Copies chiffrées", en="Encrypted copies"),
        "medium",
        ("backup.hyperbackup.tasks",),
        lambda _t, lang: say(
            lang,
            fr="Chaque copie hors du NAS est chiffrée côté client.",
            en="Every copy off the NAS is encrypted client-side.",
        ),
        Text(
            fr="Recréer la tâche avec le chiffrement côté client : ailleurs, seul ce chiffrement "
            "protège les données de qui détient le stockage.",
            en="Recreate the task with client-side encryption: elsewhere, only this encryption "
            "protects the data from whoever holds the storage.",
        ),
        _encryption,
        when_unsupported=_no_copy,
    ),
)
