"""Contrôles d'audit : verdicts calculés sur les lectures du catalogue, sans appel DSM propre."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict
from typing import Any

from nas_agent.catalog.model import OpContext, Operation, SubResult
from nas_agent.catalog.ops import (
    checks_abb,
    checks_access,
    checks_backup,
    checks_disks,
    checks_synology,
    checks_vitals,
)
from nas_agent.catalog.ops.checks_access import deadline_note
from nas_agent.catalog.ops.checks_base import (
    AuditReport,
    AuditSummary,
    Check,
    UnavailableRead,
)
from nas_agent.catalog.ops.checks_base import Reads as _Reads
from nas_agent.catalog.ops.checks_base import Spec as _Spec
from nas_agent.catalog.ops.checks_base import Verdict as _Verdict
from nas_agent.catalog.ops.checks_base import ago as _ago
from nas_agent.catalog.ops.checks_base import agree as _agree
from nas_agent.catalog.ops.checks_base import hours_between as _hours
from nas_agent.catalog.ops.checks_base import pair as _pair
from nas_agent.catalog.ops.checks_base import plural as _n
from nas_agent.catalog.ops.checks_base import worst as _worst
from nas_agent.i18n import Lang, Text, say

COMPOSES = (
    "system.info",
    "system.utilization",
    "system.time",
    "dsm.update",
    "packages.list",
    "users.list",
    "security.settings",
    "certificates.list",
    "backup.hyperbackup.tasks",
    "storage.overview",
    "ups.status",
    "security.advisor",
    "shares.list",
    # Ajouts du 2026-11-26 (conception 2026-11-26-meilleur-produit).
    "containers.list",
    "storage.smart",
    "services.list",
    "security.logins",
    "files.activity",
    # Active Backup for Business (section 3.8).
    "backup.activebackup",
    "backup.activebackup_cloud",
    # Failles et fin de vie (conception 2026-11-26-failles-fin-de-vie).
    "updates.synology",
    # Fermer un accès resté ouvert (conception 2026-11-26-fermer-acces).
    "access.watch",
)


# Mises à jour -------------------------------------------------------------------------------


def _dsm_update(u, r: _Reads) -> _Verdict:
    v = u.major_upgrade_version
    major = (
        r.say(
            fr=f" Nouvelle version majeure disponible : {v}.",
            en=f" New major version available: {v}.",
        )
        if u.major_upgrade_available
        else ""
    )
    if u.update_available is None:
        return _Verdict(
            "unknown",
            r.say(
                fr="DSM n'a pas pu interroger Synology sur ses mises à jour.",
                en="DSM could not ask Synology about its updates.",
            ),
        )
    cur, new = u.current_version, u.update_version
    if u.update_available:
        observed = r.say(
            fr=f"{cur} ; mise à jour disponible : {new}.{major}",
            en=f"{cur}; update available: {new}.{major}",
        )
        return _Verdict("warning", observed, (new or "?",))
    return _Verdict("ok", r.say(fr=f"{cur}, à jour.{major}", en=f"{cur}, up to date.{major}"))


def _packages(p, r: _Reads) -> _Verdict:
    if not p.catalog_available:
        return _Verdict(
            "unknown",
            r.say(
                fr="Catalogue de Synology illisible : mises à jour inconnues.",
                en="Synology's package catalog is unreadable: updates unknown.",
            ),
        )
    pending = [x for x in p.packages if x.update_available]
    items = tuple(f"{x.name or x.id} {x.version} -> {x.available_version}" for x in pending)
    security = sum(bool(x.security_update) for x in pending)
    if security:
        observed = r.say(
            fr=f"{_n(security, 'mise à jour', 'mises à jour')} de sécurité en attente.",
            en=f"{_n(security, 'security update', 'security updates')} pending.",
        )
        return _Verdict("failed", observed, items)
    if pending:
        n = len(pending)
        return _Verdict(
            "warning",
            r.say(
                fr=f"{_n(n, 'paquet', 'paquets')} à mettre à jour.",
                en=f"{_n(n, 'package', 'packages')} to update.",
            ),
            items,
        )
    total = p.summary.total
    return _Verdict(
        "ok",
        r.say(
            fr=f"{_n(total, 'paquet', 'paquets')}, à jour.",
            en=f"{_n(total, 'package', 'packages')}, up to date.",
        ),
    )


# Comptes ------------------------------------------------------------------------------------

_ENFORCED = {
    "none": Text(fr="à personne", en="nobody"),
    "admin": Text(fr="aux administrateurs", en="administrators"),
    "user": Text(fr="à tous", en="everyone"),
    "custom": Text(fr="à des comptes choisis", en="chosen accounts"),
}


def _admin_two_factor(a, r: _Reads) -> _Verdict:
    active_admins = [x for x in a.accounts if x.admin and x.disabled is False]
    missing = [x for x in active_admins if not x.agent_account and x.two_factor is not True]
    agent = any(x.agent_account for x in active_admins)
    settings = r.get("security.settings")
    enforced = settings.two_factor_enforced if settings else None
    to = _ENFORCED.get(enforced or "", Text(fr="inconnu", en="unknown"))(r.lang)
    n = len(missing)
    excluded = Text(fr=", compte de l'agent exclu", en=", the agent’s account excluded")
    observed = r.say(
        fr=f"{_n(n, 'administrateur actif', 'administrateurs actifs')} sans double "
        f"authentification{excluded.fr if agent else ''} ; double "
        f"authentification imposée : {to}.",
        en=f"{_n(n, 'active administrator', 'active administrators')} without two-factor "
        f"authentication{excluded.en if agent else ''}; two-factor "
        f"authentication enforced for: {to}.",
    )
    items = tuple(x.name for x in missing) if r.personal else ()
    if not missing:
        return _Verdict("ok", observed)
    return _Verdict("warning" if enforced in ("admin", "user") else "failed", observed, items)


def _builtin(name: str) -> Callable[[Any, _Reads], _Verdict]:
    def evaluate(a, r: _Reads) -> _Verdict:
        account = next((x for x in a.accounts if x.name == name), None)
        if account is None:
            return _Verdict(
                "ok", r.say(fr=f"Compte « {name} » absent.", en=f"No “{name}” account.")
            )
        if account.disabled is None:
            return _Verdict(
                "unknown",
                r.say(
                    fr=f"État du compte « {name} » illisible.",
                    en=f"State of the “{name}” account unreadable.",
                ),
            )
        if account.disabled:
            return _Verdict(
                "ok", r.say(fr=f"Compte « {name} » désactivé.", en=f"“{name}” account disabled.")
            )
        return _Verdict(
            "failed", r.say(fr=f"Compte « {name} » actif.", en=f"“{name}” account active."), (name,)
        )

    return evaluate


# Accès --------------------------------------------------------------------------------------


def _on_off(r: _Reads, value: bool | None, on: _Verdict, off: _Verdict, what: Text) -> _Verdict:
    if value is None:
        return _Verdict(
            "unknown", r.say(fr=f"État {what.fr} illisible.", en=f"{what.en} state unreadable.")
        )
    return on if value else off


def _ssh(s, r: _Reads) -> _Verdict:
    port = s.ssh.port
    note = deadline_note(r.get("access.watch"), "ssh", r)
    return _on_off(
        r,
        s.ssh.enabled,
        _Verdict(
            "warning", r.say(fr=f"SSH ouvert, port {port}.", en=f"SSH open, port {port}.") + note
        ),
        _Verdict("ok", r.say(fr="SSH coupé.", en="SSH off.")),
        Text(fr="de SSH", en="SSH"),
    )


def _telnet(s, r: _Reads) -> _Verdict:
    note = deadline_note(r.get("access.watch"), "telnet", r)
    return _on_off(
        r,
        s.telnet_enabled,
        _Verdict("failed", r.say(fr="Telnet ouvert.", en="Telnet open.") + note),
        _Verdict("ok", r.say(fr="Telnet coupé.", en="Telnet off.")),
        Text(fr="de Telnet", en="Telnet"),
    )


def _firewall(s, r: _Reads) -> _Verdict:
    profile = s.firewall.profile
    return _on_off(
        r,
        s.firewall.enabled,
        _Verdict(
            "ok",
            r.say(
                fr=f"Pare-feu actif, profil « {profile} ».", en=f"Firewall on, profile “{profile}”."
            ),
        ),
        _Verdict("failed", r.say(fr="Pare-feu coupé.", en="Firewall off.")),
        Text(fr="du pare-feu", en="Firewall"),
    )


def _auto_block(s, r: _Reads) -> _Verdict:
    b = s.auto_block
    return _on_off(
        r,
        b.enabled,
        _Verdict(
            "ok",
            r.say(
                fr=f"Blocage automatique actif : {b.attempts} échecs en {b.within_minutes} min.",
                en=f"Auto block on: {b.attempts} failures within {b.within_minutes} min.",
            ),
        ),
        _Verdict("failed", r.say(fr="Blocage automatique coupé.", en="Auto block off.")),
        Text(fr="du blocage automatique", en="Auto block"),
    )


def _quickconnect(s, r: _Reads) -> _Verdict:
    return _on_off(
        r,
        s.quickconnect.enabled,
        _Verdict(
            "warning",
            r.say(
                fr="QuickConnect actif : DSM est joignable par les relais de Synology.",
                en="QuickConnect on: DSM is reachable through Synology’s relays.",
            ),
        ),
        _Verdict("ok", r.say(fr="QuickConnect coupé.", en="QuickConnect off.")),
        Text(fr="de QuickConnect", en="QuickConnect"),
    )


# Certificats --------------------------------------------------------------------------------


def _certificates(c, r: _Reads) -> _Verdict:
    limit = r.limits.certificate_min_days
    in_use = [x for x in c.certificates if x.is_default or x.services]
    items, statuses = [], []
    for cert in in_use:
        name = cert.common_name or cert.description or cert.id or "?"
        days = cert.expires_in_days
        if cert.expired:
            statuses.append("failed")
            items.append(
                r.say(
                    fr=f"{name} : expiré" + (f" depuis {-days} jours" if days else ""),
                    en=f"{name}: expired" + (f" {-days} days ago" if days else ""),
                )
            )
        elif days is not None and days < limit:
            statuses.append("warning")
            items.append(
                r.say(fr=f"{name} : expire dans {days} jours", en=f"{name}: expires in {days} days")
            )
    if not items:
        count = len(in_use)
        observed = r.say(
            fr=f"{_n(count, 'certificat utilisé', 'certificats utilisés')}, "
            f"{_agree(count, 'valide')}.",
            en=f"{_n(count, 'certificate in use', 'certificates in use')}, valid.",
        )
        return _Verdict("ok", observed)
    n = len(items)
    observed = r.say(
        fr=f"{_n(n, 'certificat utilisé', 'certificats utilisés')} à renouveler.",
        en=f"{_n(n, 'certificate in use', 'certificates in use')} to renew.",
    )
    return _Verdict(_worst(statuses), observed, tuple(items))


# Hyper Backup -------------------------------------------------------------------------------

_NO_TASK_TEXT = Text(fr="Aucune tâche Hyper Backup.", en="No Hyper Backup task.")
_OFFSET_UNKNOWN = Text(
    fr="âge inconnu, heure du NAS illisible", en="age unknown, NAS clock unreadable"
)


def _no_task(lang: Lang) -> _Verdict:
    return _Verdict(
        "warning",
        _NO_TASK_TEXT(lang),
        advice=say(
            lang,
            fr="Vérifier que le NAS est sauvegardé autrement, ou créer une tâche Hyper Backup.",
            en="Check that the NAS is backed up another way, or create a Hyper Backup task.",
        ),
    )


def _no_task_unknown(lang: Lang) -> _Verdict:
    return _Verdict("unknown", _NO_TASK_TEXT(lang))


def _task_name(task, lang: Lang = "fr") -> str:
    return task.name or say(lang, fr=f"tâche {task.id}", en=f"task {task.id}")


def _at_fault(r: _Reads, n: int, total: int) -> str:
    return r.say(
        fr=f"{_n(n, 'tâche', 'tâches')} en cause sur {total}.",
        en=f"{_n(n, 'task', 'tasks')} at fault out of {total}.",
    )


def _recent_success(b, r: _Reads) -> _Verdict:
    if not b.tasks:
        return _no_task(r.lang)
    now = r.read_at("backup.hyperbackup.tasks")
    items, statuses = [], []
    for task in b.tasks:
        name = _task_name(task, r.lang)
        age = _hours(now, r.utc(task.last_success_at))
        schedule = task.schedule
        if task.last_success_at is None:
            status = "failed"
            text = r.say(fr=f"{name} : jamais réussie", en=f"{name}: never succeeded")
        elif schedule is None or schedule.enabled is not True:
            ago = _ago(age, r.lang) if age is not None else None
            status = "warning"
            text = r.say(
                fr=f"{name} : sans planning" + (f", dernière réussite il y a {ago}" if ago else ""),
                en=f"{name}: not scheduled" + (f", last success {ago} ago" if ago else ""),
            )
        elif age is None:
            status = "unknown"
            text = r.say(fr=f"{name} : {_OFFSET_UNKNOWN.fr}", en=f"{name}: {_OFFSET_UNKNOWN.en}")
        else:
            allowed = max(r.limits.backup_max_age_hours, (schedule.max_gap_hours or 0) + 2)
            status = "failed" if age > allowed else "ok"
            ago = _ago(age, r.lang)
            text = r.say(
                fr=f"{name} : dernière réussite il y a {ago}, au plus {allowed} h attendues",
                en=f"{name}: last success {ago} ago, at most {allowed} h expected",
            )
        statuses.append(status)
        if status != "ok":
            items.append(text)
    total = len(b.tasks)
    if not items:
        return _Verdict(
            "ok",
            r.say(
                fr=f"{_n(total, 'tâche', 'tâches')}, {_agree(total, 'réussie')} dans les délais.",
                en=f"{_n(total, 'task', 'tasks')}, succeeded on time.",
            ),
        )
    return _Verdict(_worst(statuses), _at_fault(r, len(items), total), tuple(items))


def _last_result(b, r: _Reads) -> _Verdict:
    if not b.tasks:
        return _no_task_unknown(r.lang)
    failed = [t for t in b.tasks if t.failed]
    items = tuple(
        r.say(fr=f"{name} : {t.last_result}", en=f"{name}: {t.last_result}")
        for t in failed
        for name in (_task_name(t, r.lang),)
    )
    total = len(b.tasks)
    if failed:
        n = len(failed)
        observed = r.say(
            fr=f"{_n(n, 'tâche', 'tâches')} en erreur sur {total}.",
            en=f"{_n(n, 'task', 'tasks')} in error out of {total}.",
        )
        return _Verdict("failed", observed, items)
    return _Verdict(
        "ok",
        r.say(fr=f"Aucune tâche en erreur sur {total}.", en=f"No task in error out of {total}."),
    )


def _integrity(b, r: _Reads) -> _Verdict:
    if not b.tasks:
        return _no_task_unknown(r.lang)
    limit = r.limits.integrity_max_age_days
    now = r.read_at("backup.hyperbackup.tasks")
    # Seules les sauvegardes multiversion (« image ») ont un contrôle d'intégrité.
    tasks = [t for t in b.tasks if (t.kind or "").startswith("image")]
    items, statuses = [], []
    for task in tasks:
        check, name = task.integrity_check, _task_name(task, r.lang)
        age = _hours(now, r.utc(check.last_at))
        if check.never_checked:
            status = "warning"
            text = r.say(fr=f"{name} : jamais contrôlée", en=f"{name}: never checked")
        elif check.never_checked is None:
            status = "unknown"
            text = r.say(fr=f"{name} : destination illisible", en=f"{name}: destination unreadable")
        elif age is None:
            status = "unknown"
            text = r.say(fr=f"{name} : {_OFFSET_UNKNOWN.fr}", en=f"{name}: {_OFFSET_UNKNOWN.en}")
        else:
            days = round(age / 24)
            status = "warning" if age / 24 > limit else "ok"
            text = r.say(
                fr=f"{name} : dernier contrôle il y a {days} jours, au plus {limit} attendus",
                en=f"{name}: last check {days} days ago, at most {limit} expected",
            )
        statuses.append(status)
        if status != "ok":
            items.append(text)
    if not tasks:
        return _Verdict(
            "ok",
            r.say(
                fr="Aucune tâche multiversion à contrôler.", en="No multi-version task to check."
            ),
        )
    if not items:
        n = len(tasks)
        return _Verdict(
            "ok",
            r.say(
                fr=f"{_n(n, 'tâche contrôlée', 'tâches contrôlées')} à temps.",
                en=f"{_n(n, 'task', 'tasks')} checked on time.",
            ),
        )
    return _Verdict(_worst(statuses), _at_fault(r, len(items), len(tasks)), tuple(items))


# Stockage -----------------------------------------------------------------------------------


def _volume_usage(s, r: _Reads) -> _Verdict:
    warn, fail = r.limits.volume_warning_pct, r.limits.volume_failure_pct
    items, statuses = [], []
    for volume in s.volumes:
        used = volume.used_pct
        if used is None or used < warn:
            continue
        statuses.append("failed" if used >= fail else "warning")
        items.append(_pair(r, volume.path or volume.id, f"{used:g} %"))
    if not items:
        n = len(s.volumes)
        return _Verdict(
            "ok",
            r.say(
                fr=f"{_n(n, 'volume', 'volumes')}, sous {warn} %.",
                en=f"{_n(n, 'volume', 'volumes')}, below {warn} %.",
            ),
        )
    n = len(items)
    observed = r.say(
        fr=f"{_n(n, 'volume', 'volumes')} au-dessus de {warn} %.",
        en=f"{_n(n, 'volume', 'volumes')} above {warn} %.",
    )
    return _Verdict(_worst(statuses), observed, tuple(items))


def _disks(s, r: _Reads) -> _Verdict:
    if not s.disks:
        return _Verdict("unknown", r.say(fr="Aucun disque lu.", en="No disk read."))
    bad = [d for d in s.disks if not d.healthy]
    items = tuple(_pair(r, d.name or d.id, f"{d.status}, SMART {d.smart_status}") for d in bad)
    if bad:
        n = len(bad)
        return _Verdict(
            "failed",
            r.say(
                fr=f"{_n(n, 'disque', 'disques')} en mauvais état.",
                en=f"{_n(n, 'disk', 'disks')} in bad health.",
            ),
            items,
        )
    count = len(s.disks)
    return _Verdict(
        "ok",
        r.say(
            fr=f"{_n(count, 'disque', 'disques')}, {'sain' if count <= 1 else 'sains'}.",
            en=f"{_n(count, 'disk', 'disks')}, healthy.",
        ),
    )


def _pools(s, r: _Reads) -> _Verdict:
    bad = [_pair(r, p.id, p.status) for p in s.pools if p.status != "normal"]
    bad += [_pair(r, v.path or v.id, v.status) for v in s.volumes if v.status != "normal"]
    if bad:
        n = len(bad)
        return _Verdict(
            "failed",
            r.say(
                fr=f"{_n(n, 'élément', 'éléments')} hors état normal.",
                en=f"{_n(n, 'item', 'items')} not in normal state.",
            ),
            tuple(bad),
        )
    p, v = len(s.pools), len(s.volumes)
    return _Verdict(
        "ok",
        r.say(
            fr=f"{_n(p, 'groupe de stockage', 'groupes de stockage')} et "
            f"{_n(v, 'volume', 'volumes')} en état normal.",
            en=f"{_n(p, 'storage pool', 'storage pools')} and {_n(v, 'volume', 'volumes')} "
            "in normal state.",
        ),
    )


# Onduleur -----------------------------------------------------------------------------------


def _ups(u, r: _Reads) -> _Verdict:
    if u.enabled is None:
        return _Verdict(
            "unknown", r.say(fr="Réglage de l'onduleur illisible.", en="UPS setting unreadable.")
        )
    if not u.enabled:
        return _Verdict("warning", r.say(fr="Aucun onduleur configuré.", en="No UPS configured."))
    if u.on_battery:
        c = u.charge_percent
        return _Verdict(
            "warning",
            r.say(
                fr="Onduleur sur batterie" + (f", charge {c} %" if c is not None else "") + ".",
                en="UPS on battery" + (f", {c} % charge" if c is not None else "") + ".",
            ),
        )
    if u.status == "online":
        return _Verdict(
            "ok",
            r.say(fr=f"Onduleur ({u.mode}) sur secteur.", en=f"UPS ({u.mode}) on mains power."),
        )
    return _Verdict(
        "warning",
        r.say(
            fr=f"Onduleur ({u.mode}) : état « {u.status} ».",
            en=f"UPS ({u.mode}): state “{u.status}”.",
        ),
    )


# Security Advisor ---------------------------------------------------------------------------

_CRITICAL = ("danger", "risk")  # en rouge dans Security Advisor
_WARNING = ("warning", "out_of_date")  # en orange


def _advisor(a, r: _Reads) -> _Verdict:
    if a.last_scan_at is None:
        return _Verdict(
            "unknown",
            r.say(fr="Aucune analyse de Security Advisor.", en="No Security Advisor scan."),
            advice=r.say(
                fr="Lancer une analyse dans Security Advisor et la planifier.",
                en="Run a scan in Security Advisor and schedule it.",
            ),
        )
    hours = _hours(r.read_at("security.advisor"), a.last_scan_at) or 0.0
    days = round(hours / 24)
    critical = [x for x in a.failed_rules if x.severity in _CRITICAL]
    warnings = [x for x in a.failed_rules if x.severity in _WARNING]
    c, w = len(critical), len(warnings)
    since_fr = f"il y a {days} jours" if days >= 1 else "il y a moins d'un jour"
    observed = r.say(
        fr=f"{_n(c, 'point critique', 'points critiques')}, "
        f"{_n(w, 'avertissement', 'avertissements')} ; dernière analyse {since_fr}, "
        f"groupe de règles « {a.group} ».",
        en=f"{_n(c, 'critical issue', 'critical issues')}, {_n(w, 'warning', 'warnings')}; "
        f"last scan {f'{days} days ago' if days >= 1 else 'less than a day ago'}, "
        f"rule set “{a.group}”.",
    )
    items = tuple(f"{x.id} ({x.severity})" for x in critical + warnings)
    if critical:
        return _Verdict("failed", observed, items)
    if warnings or hours / 24 > r.limits.advisor_max_age_days:
        return _Verdict("warning", observed, items)
    return _Verdict("ok", observed)


# Partages -----------------------------------------------------------------------------------


def _recycle_bin(s, r: _Reads) -> _Verdict:
    # Une corbeille ne sert à rien sur un dossier qui reçoit des sauvegardes (destination de
    # Hyper Backup, dossier d'Active Backup) : le paquet y gère lui-même ses versions.
    skip = checks_backup.receiving(r)
    shares = [x for x in s.shares if not x.usb and x.name not in skip]
    without = tuple(x.name or "?" for x in shares if x.recycle_bin is False)
    if without:
        n = len(without)
        observed = r.say(
            fr=f"{_n(n, 'dossier partagé', 'dossiers partagés')} sans corbeille.",
            en=f"{_n(n, 'shared folder', 'shared folders')} without a recycle bin.",
        )
        return _Verdict("warning", observed, without)
    return _Verdict(
        "ok",
        r.say(
            fr="Corbeille active sur les dossiers partagés.",
            en="Recycle bin on for shared folders.",
        ),
    )


def _snapshots(s, r: _Reads) -> _Verdict:
    shares = [x for x in s.shares if not x.usb and x.snapshots and x.snapshots.supported]
    without = tuple(x.name or "?" for x in shares if not x.snapshots.scheduled)
    if not shares:
        return _Verdict(
            "ok",
            r.say(
                fr="Aucun dossier partagé sur un volume à instantanés.",
                en="No shared folder on a snapshot-capable volume.",
            ),
        )
    if without:
        n = len(without)
        observed = r.say(
            fr=f"{_n(n, 'dossier partagé', 'dossiers partagés')} sans instantanés planifiés.",
            en=f"{_n(n, 'shared folder', 'shared folders')} without scheduled snapshots.",
        )
        return _Verdict("warning", observed, without)
    return _Verdict(
        "ok",
        r.say(
            fr="Instantanés planifiés sur les dossiers partagés.",
            en="Snapshots scheduled for shared folders.",
        ),
    )


# Jeu de contrôles ---------------------------------------------------------------------------

_BASE_SPECS = (
    _Spec(
        "updates.dsm",
        Text(fr="DSM à jour", en="DSM up to date"),
        "high",
        ("dsm.update",),
        lambda _t, lang: say(
            lang,
            fr="DSM à jour dans sa version majeure.",
            en="DSM up to date within its major version.",
        ),
        Text(
            fr="Installer la mise à jour de DSM après une sauvegarde (Panneau de configuration, "
            "Mise à jour et restauration).",
            en="Install the DSM update after a backup (Control Panel, Update & Restore).",
        ),
        _dsm_update,
    ),
    _Spec(
        "updates.packages",
        Text(fr="Paquets à jour", en="Packages up to date"),
        "medium",
        ("packages.list",),
        lambda _t, lang: say(lang, fr="Paquets à jour.", en="Packages up to date."),
        Text(
            fr="Mettre à jour les paquets dans le Centre de paquets, ou activer leur mise à jour "
            "automatique.",
            en="Update the packages in Package Center, or turn on their automatic updates.",
        ),
        _packages,
    ),
    _Spec(
        "accounts.admin_two_factor",
        Text(
            fr="Double authentification des administrateurs",
            en="Two-factor authentication for administrators",
        ),
        "high",
        ("users.list", "security.settings"),
        lambda _t, lang: say(
            lang,
            fr="Tous les administrateurs actifs ont la double authentification.",
            en="Every active administrator has two-factor authentication.",
        ),
        Text(
            fr="Activer la double authentification sur chaque compte administrateur. L'imposer "
            "aux administrateurs bloquerait aussi le compte de l'agent, tant qu'il n'a pas de "
            "jeton d'appareil.",
            en="Turn on two-factor authentication for each administrator account. Enforcing it "
            "for administrators would also lock out the agent’s account, until it has a device "
            "token.",
        ),
        _admin_two_factor,
    ),
    _Spec(
        "accounts.builtin_admin",
        Text(fr="Compte « admin » d'origine", en="Built-in “admin” account"),
        "high",
        ("users.list",),
        lambda _t, lang: say(
            lang,
            fr="Compte « admin » d'origine désactivé.",
            en="Built-in “admin” account disabled.",
        ),
        Text(
            fr="Désactiver le compte « admin » d'origine, après avoir vérifié qu'un autre "
            "administrateur existe (Panneau de configuration, Utilisateur et groupe).",
            en="Disable the built-in “admin” account, after checking that another administrator "
            "exists (Control Panel, User & Group).",
        ),
        _builtin("admin"),
    ),
    _Spec(
        "accounts.guest",
        Text(fr="Compte « guest »", en="“guest” account"),
        "medium",
        ("users.list",),
        lambda _t, lang: say(
            lang, fr="Compte « guest » désactivé.", en="“guest” account disabled."
        ),
        Text(
            fr="Désactiver le compte « guest » (Panneau de configuration, Utilisateur et groupe).",
            en="Disable the “guest” account (Control Panel, User & Group).",
        ),
        _builtin("guest"),
    ),
    _Spec(
        "access.ssh",
        Text(fr="SSH", en="SSH"),
        "medium",
        ("security.settings",),
        lambda _t, lang: say(
            lang, fr="SSH coupé quand il ne sert pas.", en="SSH off when not in use."
        ),
        Text(
            fr="Couper SSH s'il ne sert pas (Panneau de configuration, Terminal et SNMP) ; sinon "
            "le réserver aux clés, changer le port 22 et le filtrer par le pare-feu.",
            en="Turn SSH off if you don’t use it (Control Panel, Terminal & SNMP); otherwise "
            "allow keys only, change port 22 and filter it with the firewall.",
        ),
        _ssh,
    ),
    _Spec(
        "access.telnet",
        Text(fr="Telnet", en="Telnet"),
        "high",
        ("security.settings",),
        lambda _t, lang: say(lang, fr="Telnet coupé.", en="Telnet off."),
        Text(
            fr="Couper Telnet, qui transmet les mots de passe en clair (Panneau de configuration, "
            "Terminal et SNMP).",
            en="Turn Telnet off: it sends passwords in clear text (Control Panel, Terminal & "
            "SNMP).",
        ),
        _telnet,
    ),
    _Spec(
        "access.firewall",
        Text(fr="Pare-feu", en="Firewall"),
        "medium",
        ("security.settings",),
        lambda _t, lang: say(lang, fr="Pare-feu actif.", en="Firewall on."),
        Text(
            fr="Activer le pare-feu de DSM avec un profil qui n'ouvre que les services utilisés "
            "(Panneau de configuration, Sécurité, Pare-feu).",
            en="Turn on the DSM firewall with a profile that only opens the services you use "
            "(Control Panel, Security, Firewall).",
        ),
        _firewall,
    ),
    _Spec(
        "access.auto_block",
        Text(fr="Blocage automatique", en="Auto block"),
        "medium",
        ("security.settings",),
        lambda _t, lang: say(
            lang,
            fr="Blocage automatique des adresses actif.",
            en="Automatic blocking of addresses on.",
        ),
        Text(
            fr="Activer le blocage automatique (Panneau de configuration, Sécurité, Protection).",
            en="Turn on auto block (Control Panel, Security, Protection).",
        ),
        _auto_block,
    ),
    _Spec(
        "access.quickconnect",
        Text(fr="QuickConnect", en="QuickConnect"),
        "info",
        ("security.settings",),
        lambda _t, lang: say(
            lang,
            fr="QuickConnect coupé s'il ne sert pas.",
            en="QuickConnect off when not in use.",
        ),
        Text(
            fr="Couper QuickConnect s'il ne sert pas, ou restreindre les services qu'il expose.",
            en="Turn QuickConnect off if you don’t use it, or restrict the services it exposes.",
        ),
        _quickconnect,
    ),
    _Spec(
        "certificates.validity",
        Text(fr="Certificats", en="Certificates"),
        "high",
        ("certificates.list",),
        lambda t, lang: say(
            lang,
            fr=f"Certificats utilisés valides plus de {t.certificate_min_days} jours.",
            en=f"Certificates in use valid for more than {t.certificate_min_days} days.",
        ),
        Text(
            fr="Renouveler le certificat, ou laisser DSM le renouveler (Let's Encrypt), et "
            "vérifier les services qui l'emploient (Panneau de configuration, Sécurité, "
            "Certificat).",
            en="Renew the certificate, or let DSM renew it (Let’s Encrypt), and check the "
            "services that use it (Control Panel, Security, Certificate).",
        ),
        _certificates,
    ),
    _Spec(
        "backup.recent_success",
        Text(fr="Hyper Backup : dernière réussite", en="Hyper Backup: last success"),
        "high",
        ("backup.hyperbackup.tasks", "system.time"),
        lambda t, lang: say(
            lang,
            fr=f"Chaque tâche planifiée a réussi depuis moins de {t.backup_max_age_hours} h, "
            "ou selon son planning.",
            en=f"Each scheduled task succeeded less than {t.backup_max_age_hours} h ago, or as "
            "its schedule requires.",
        ),
        Text(
            fr="Vérifier la tâche et sa destination dans Hyper Backup ; planifier les tâches "
            "lancées à la main.",
            en="Check the task and its destination in Hyper Backup; schedule the tasks run by "
            "hand.",
        ),
        _recent_success,
        when_unsupported=_no_task,
    ),
    _Spec(
        "backup.last_result",
        Text(fr="Hyper Backup : tâches en erreur", en="Hyper Backup: tasks in error"),
        "high",
        ("backup.hyperbackup.tasks",),
        lambda _t, lang: say(lang, fr="Aucune tâche en erreur.", en="No task in error."),
        Text(
            fr="Ouvrir le journal de la tâche dans Hyper Backup, corriger la cause (destination "
            "pleine, déconnectée ou protégée en écriture), puis relancer la sauvegarde.",
            en="Open the task’s log in Hyper Backup, fix the cause (destination full, "
            "disconnected or write-protected), then run the backup again.",
        ),
        _last_result,
    ),
    _Spec(
        "backup.integrity",
        Text(fr="Hyper Backup : contrôle d'intégrité", en="Hyper Backup: integrity check"),
        "medium",
        ("backup.hyperbackup.tasks", "system.time"),
        lambda t, lang: say(
            lang,
            fr=f"Un contrôle d'intégrité de moins de {t.integrity_max_age_days} jours sur "
            "chaque tâche multiversion.",
            en=f"An integrity check less than {t.integrity_max_age_days} days old on every "
            "multi-version task.",
        ),
        Text(
            fr="Planifier un contrôle d'intégrité régulier dans les réglages de la tâche (Hyper "
            "Backup), et en lancer un maintenant.",
            en="Schedule a regular integrity check in the task settings (Hyper Backup), and run "
            "one now.",
        ),
        _integrity,
    ),
    _Spec(
        "storage.volume_usage",
        Text(fr="Remplissage des volumes", en="Volume usage"),
        "high",
        ("storage.overview",),
        lambda t, lang: say(
            lang,
            fr=f"Volumes remplis à moins de {t.volume_warning_pct} % (échec à "
            f"{t.volume_failure_pct} %).",
            en=f"Volumes less than {t.volume_warning_pct} % full (failure at "
            f"{t.volume_failure_pct} %).",
        ),
        Text(
            fr="Libérer de la place (corbeilles, instantanés, anciennes versions de Hyper Backup) "
            "ou agrandir le volume.",
            en="Free up space (recycle bins, snapshots, old Hyper Backup versions) or expand the "
            "volume.",
        ),
        _volume_usage,
    ),
    _Spec(
        "storage.disks",
        Text(fr="Santé des disques", en="Disk health"),
        "high",
        ("storage.overview",),
        lambda _t, lang: say(
            lang,
            fr="Disques sains (état et SMART normaux).",
            en="Healthy disks (normal state and SMART).",
        ),
        Text(
            fr="Sauvegarder sans attendre, puis remplacer le disque en cause (Gestionnaire de "
            "stockage).",
            en="Back up right away, then replace the faulty disk (Storage Manager).",
        ),
        _disks,
    ),
    _Spec(
        "storage.pools",
        Text(fr="Groupes de stockage et volumes", en="Storage pools and volumes"),
        "high",
        ("storage.overview",),
        lambda _t, lang: say(
            lang,
            fr="Groupes de stockage et volumes en état normal, aucun dégradé.",
            en="Storage pools and volumes in normal state, none degraded.",
        ),
        Text(
            fr="Ouvrir le Gestionnaire de stockage et réparer l'élément dégradé, après une "
            "sauvegarde.",
            en="Open Storage Manager and repair the degraded item, after a backup.",
        ),
        _pools,
    ),
    _Spec(
        "ups.configured",
        Text(fr="Onduleur", en="UPS"),
        "medium",
        ("ups.status",),
        lambda _t, lang: say(
            lang,
            fr="Onduleur configuré, NAS sur secteur.",
            en="UPS configured, NAS on mains power.",
        ),
        Text(
            fr="Brancher un onduleur et activer sa prise en charge (Panneau de configuration, "
            "Matériel et alimentation, Onduleur), pour un arrêt propre en cas de coupure.",
            en="Connect a UPS and turn on its support (Control Panel, Hardware & Power, UPS), for "
            "a clean shutdown during a power cut.",
        ),
        _ups,
    ),
    _Spec(
        "security_advisor.critical",
        Text(fr="Security Advisor", en="Security Advisor"),
        "high",
        ("security.advisor",),
        lambda t, lang: say(
            lang,
            fr=f"Aucun point critique, analyse de moins de {t.advisor_max_age_days} jours.",
            en=f"No critical issue, scan less than {t.advisor_max_age_days} days old.",
        ),
        Text(
            fr="Ouvrir Security Advisor, corriger les points en rouge, puis relancer l'analyse.",
            en="Open Security Advisor, fix the items in red, then run the scan again.",
        ),
        _advisor,
    ),
    _Spec(
        "shares.recycle_bin",
        Text(fr="Corbeille des dossiers partagés", en="Recycle bin for shared folders"),
        "info",
        ("shares.list",),
        lambda _t, lang: say(
            lang,
            fr="Corbeille active sur les dossiers partagés.",
            en="Recycle bin on for shared folders.",
        ),
        Text(
            fr="Activer la corbeille des dossiers partagés et planifier son vidage (Panneau de "
            "configuration, Dossier partagé).",
            en="Turn on the recycle bin for shared folders and schedule its emptying (Control "
            "Panel, Shared Folder).",
        ),
        _recycle_bin,
    ),
    _Spec(
        "shares.snapshots",
        Text(fr="Instantanés des dossiers partagés", en="Snapshots of shared folders"),
        "info",
        ("shares.list",),
        lambda _t, lang: say(
            lang,
            fr="Instantanés planifiés sur les dossiers partagés.",
            en="Snapshots scheduled for shared folders.",
        ),
        Text(
            fr="Planifier des instantanés avec Snapshot Replication : ils protègent des "
            "suppressions et des rançongiciels.",
            en="Schedule snapshots with Snapshot Replication: they protect against deletions and "
            "ransomware.",
        ),
        _snapshots,
    ),
)


def _ordered() -> tuple[_Spec, ...]:
    """Les contrôles d'origine et ceux du 2026-11-26, rangés par catégorie."""

    def of(prefix: str) -> tuple[_Spec, ...]:
        return tuple(s for s in _BASE_SPECS if s.id.startswith(prefix + "."))

    vitals = {s.id: s for s in checks_vitals.SPECS}
    return (
        vitals["system.reachable"],
        vitals["system.cpu"],
        vitals["system.memory"],
        vitals["system.temperature"],
        *checks_access.SPECS_SYSTEM,
        *of("updates"),
        *checks_access.SPECS_UPDATES,
        *checks_synology.SPECS,
        *of("accounts"),
        *checks_access.SPECS_ACCOUNTS,
        *of("access"),
        *checks_access.SPECS_ACCESS,
        *checks_access.SPECS_LOGINS,
        *of("certificates"),
        *of("backup"),
        *checks_backup.SPECS,
        *checks_abb.SPECS,
        *of("storage"),
        *checks_disks.SPECS,
        vitals["containers.state"],
        *of("ups"),
        *of("security_advisor"),
        *of("shares"),
        *checks_access.SPECS_FILES,
    )


_SPECS = _ordered()

_UNKNOWN_ADVICE = Text(
    fr="Relancer le contrôle ; si la lecture échoue encore, vérifier le paquet concerné et les "
    "droits du compte de l'agent.",
    en="Run the check again; if the read still fails, check the package concerned and the "
    "rights of the agent’s account.",
)


def _unreadable(op_id: str, sub: SubResult | None, lang: Lang) -> str:
    if sub is not None and sub.error == "unsupported":
        return say(
            lang,
            fr=f"Lecture impossible : {op_id} n'est pas pris en charge par ce NAS.",
            en=f"Could not read: {op_id} is not supported by this NAS.",
        )
    if sub is not None and sub.error == "dsm_error":
        return say(
            lang,
            fr=f"Lecture impossible : DSM a refusé {op_id} (code {sub.dsm_code}).",
            en=f"Could not read: DSM refused {op_id} (code {sub.dsm_code}).",
        )
    return say(
        lang,
        fr=f"Lecture impossible : réponse inattendue de DSM pour {op_id}.",
        en=f"Could not read: unexpected answer from DSM for {op_id}.",
    )


def _check(spec: _Spec, reads: _Reads) -> Check:
    source = spec.sources[0]
    sub = reads.subs.get(source)
    lang = reads.lang
    if sub is not None and sub.result is not None:
        verdict = spec.evaluate(sub.result, reads)
    elif spec.always:
        verdict = spec.evaluate(None, reads)
    elif spec.when_unsupported is not None and sub is not None and sub.error == "unsupported":
        verdict = spec.when_unsupported(lang)
    else:
        verdict = _Verdict("unknown", _unreadable(source, sub, lang), advice=_UNKNOWN_ADVICE(lang))
    return Check(
        id=spec.id,
        category=spec.id.split(".")[0],
        title=spec.title(lang),
        severity=spec.severity,
        status=verdict.status,
        observed=verdict.observed,
        expected=spec.expected(reads.limits, lang),
        advice=None if verdict.status == "ok" else verdict.advice or spec.advice(lang),
        items=list(verdict.items),
        sources=list(spec.sources),
    )


def _report(ctx: OpContext, subs: Mapping[str, SubResult]) -> AuditReport:
    reads = _Reads(
        subs,
        ctx.settings.audit,
        "personal:read" in ctx.principal.scopes,
        lang=ctx.lang,
        history=ctx.history,
        now=ctx.fetched_at,
    )
    checks = [_check(spec, reads) for spec in _SPECS]
    counted = [c.status for c in checks]
    return AuditReport(
        summary=AuditSummary(
            status=_worst(c.status for c in checks if c.severity != "info"),
            total=len(checks),
            ok=counted.count("ok"),
            warning=counted.count("warning"),
            failed=counted.count("failed"),
            unknown=counted.count("unknown"),
        ),
        thresholds=asdict(ctx.settings.audit),
        checks=checks,
        unavailable=[
            UnavailableRead(op=op_id, reason=sub.error or "unexpected", dsm_code=sub.dsm_code)
            for op_id, sub in subs.items()
            if sub.result is None
        ],
    )


OPERATIONS = [
    Operation(
        id="audit.checks",
        title="Audit checks",
        description='"ok", "warning", "failed" or "unknown" verdicts on updates, '
        "accounts, access, certificates, Hyper Backup, storage, the UPS, Security "
        "Advisor and shares, with the value read, the value expected and advice. "
        "Reads the other operations without requiring their scopes; returns only "
        "verdicts and counts, and account names only with personal:read.",
        kind="read",
        scope="audit:checks",
        path="/audit/checks",
        result_model=AuditReport,
        transform=_report,
        composes=COMPOSES,
    ),
]


def check_titles(lang) -> dict[str, str]:
    """Le titre de chaque contrôle dans la langue demandée (bilan du mois)."""
    return {spec.id: spec.title(lang) for spec in _SPECS}
