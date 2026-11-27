"""Contrôles des portes d'entrée et des réglages qui les gardent (conception
2026-11-26-meilleur-produit, section 3.5) : SMB1, services sans chiffrement, DSM en HTTPS,
mots de passe, protection des comptes, heure du NAS, redémarrage en attente.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from nas_agent.catalog.ops.checks_base import (
    Reads,
    Spec,
    Verdict,
    minutes_text,
    plural,
    plural_en,
)
from nas_agent.i18n import Text, say

# Fermer un accès resté ouvert (conception 2026-11-26-fermer-acces) -----------------------------

_NAMES = {"ssh": "SSH", "telnet": "Telnet"}
# Le rappel de la règle « Fermer » sonne dans les dix dernières minutes.
CLOSING_NOTICE = timedelta(minutes=10)


def local_clock(iso: str, r: Reads) -> str:
    """Une heure UTC dite à l'heure du NAS (« 15:30 »), sinon en UTC."""
    at = datetime.fromisoformat(iso)
    clock = r.get("system.time")
    offset = clock.utc_offset_minutes if clock else None
    if offset is None:
        return at.astimezone(UTC).strftime("%H:%M UTC")
    return (at.astimezone(UTC) + timedelta(minutes=offset)).strftime("%H:%M")


def deadline_note(w, service: str, r: Reads) -> str:
    """Ce que la règle fera d'un accès ouvert : « Fulmar le ferme à 15:30. » ; vide sans règle."""
    s = next((x for x in w.services if x.service == service), None) if w else None
    if s is None or not s.open or not s.deadline or s.policy.mode == "off":
        return ""
    hh = local_clock(s.deadline, r)
    if s.policy.mode == "close":
        return r.say(fr=f" Fulmar le ferme à {hh}.", en=f" Fulmar closes it at {hh}.")
    return r.say(fr=f" Rappel à {hh}.", en=f" Reminder at {hh}.")


def _closing(w, r: Reads) -> Verdict:
    now = r.now or datetime.now(UTC)
    due: list[str] = []
    later: list[str] = []
    names: list[str] = []
    for s in w.services:
        if not s.open or not s.deadline or s.policy.mode == "off":
            continue
        name = _NAMES[s.service]
        deadline = datetime.fromisoformat(s.deadline)
        hh = local_clock(s.deadline, r)
        if s.policy.mode == "close":
            if deadline - now <= CLOSING_NOTICE:
                due.append(r.say(fr=f"{name} se ferme à {hh}", en=f"{name} closes at {hh}"))
                names.append(name)
            else:
                later.append(r.say(fr=f"{name} se ferme à {hh}", en=f"{name} closes at {hh}"))
        elif deadline <= now:
            since = s.open_since or s.deadline
            open_for = minutes_text(
                (now - datetime.fromisoformat(since)).total_seconds() / 60, r.lang
            )
            due.append(
                r.say(
                    fr=f"{name} ouvert depuis {open_for}, à fermer s'il ne sert plus",
                    en=f"{name} open for {open_for}, to close if no longer in use",
                )
            )
            names.append(name)
        else:
            later.append(r.say(fr=f"rappel pour {name} à {hh}", en=f"reminder for {name} at {hh}"))
    if due:
        return Verdict("warning", "; ".join(due) + ".", items=tuple(names))
    if later:
        text = "; ".join(later)
        return Verdict("ok", text[0].upper() + text[1:] + ".")
    return Verdict(
        "ok",
        r.say(
            fr="Aucun accès ouvert sous une règle de fermeture.",
            en="No open access under a closing rule.",
        ),
    )


def _smb1(s, r: Reads) -> Verdict:
    smb = s.smb
    if smb is None:
        return Verdict(
            "unknown", r.say(fr="Réglages SMB illisibles.", en="SMB settings unreadable.")
        )
    if smb.enabled is False:
        return Verdict("ok", r.say(fr="SMB coupé.", en="SMB off."))
    if smb.min_protocol == "SMB1":
        return Verdict(
            "failed",
            r.say(
                fr="SMB1 accepté : la porte qu'utilisent WannaCry et ses cousins.",
                en="SMB1 accepted: the door WannaCry and its kin use.",
            ),
        )
    if smb.ntlmv1:
        return Verdict(
            "warning",
            r.say(
                fr="Authentification NTLMv1 acceptée : elle se casse en quelques heures.",
                en="NTLMv1 authentication accepted: it can be cracked in hours.",
            ),
            advice=r.say(
                fr="Désactiver NTLMv1 (Panneau de configuration, Services de fichiers, SMB, "
                "Paramètres avancés).",
                en="Turn NTLMv1 off (Control Panel, File Services, SMB, Advanced Settings).",
            ),
        )
    level = smb.min_protocol or "?"
    return Verdict(
        "ok",
        r.say(fr=f"SMB1 refusé, protocole minimal {level}.", en=f"SMB1 refused, minimum {level}."),
    )


def _cleartext(s, r: Reads) -> Verdict:
    found: list[str] = []
    if s.ftp and s.ftp.enabled:
        found.append(r.say(fr="FTP sans chiffrement", en="FTP without encryption"))
    if s.rsync and s.rsync.enabled and s.rsync.rsync_accounts:
        found.append(r.say(fr="rsync en mode démon", en="rsync in daemon mode"))
    if s.snmp and s.snmp.enabled and s.snmp.v1v2c:
        found.append(r.say(fr="SNMP v1 ou v2c", en="SNMP v1 or v2c"))
    if s.afp_enabled:
        found.append(r.say(fr="AFP, abandonné par Apple", en="AFP, dropped by Apple"))
    if found:
        return Verdict(
            "warning",
            r.say(
                fr=f"{plural(len(found), 'service transmet', 'services transmettent')} en clair.",
                en=f"{plural(len(found), 'service sends', 'services send')} in clear text.",
            ),
            tuple(found),
        )
    return Verdict(
        "ok",
        r.say(fr="Aucun service ne transmet en clair.", en="No service sends in clear text."),
    )


def _https(s, r: Reads) -> Verdict:
    web = s.web
    if web is None or web.https_redirect is None:
        return Verdict(
            "unknown",
            r.say(fr="Réglages web de DSM illisibles.", en="DSM web settings unreadable."),
        )
    if not web.https_redirect:
        port = web.http_port or 5000
        return Verdict(
            "warning",
            r.say(
                fr=f"DSM répond encore en HTTP (port {port}) sans redirection vers HTTPS.",
                en=f"DSM still answers over HTTP (port {port}) without redirecting to HTTPS.",
            ),
        )
    return Verdict(
        "ok", r.say(fr="DSM redirige HTTP vers HTTPS.", en="DSM redirects HTTP to HTTPS.")
    )


def _password_policy(s, r: Reads) -> Verdict:
    p = s.password_policy
    if p is None:
        return Verdict(
            "unknown",
            r.say(fr="Politique des mots de passe illisible.", en="Password policy unreadable."),
        )
    limit = r.limits.password_min_length
    gaps: list[str] = []
    if (p.min_length or 0) < limit:
        gaps.append(
            r.say(
                fr=f"longueur minimale {p.min_length or 0} (au moins {limit} attendus)",
                en=f"minimum length {p.min_length or 0} (at least {limit} expected)",
            )
        )
    if not p.exclude_common:
        gaps.append(r.say(fr="mots de passe courants acceptés", en="common passwords accepted"))
    if gaps:
        return Verdict(
            "warning",
            r.say(fr="Mots de passe trop faciles.", en="Passwords too easy."),
            tuple(gaps),
        )
    return Verdict(
        "ok",
        r.say(
            fr=f"Au moins {p.min_length} caractères, mots de passe courants refusés.",
            en=f"At least {p.min_length} characters, common passwords refused.",
        ),
    )


def _protection(s, r: Reads) -> Verdict:
    if s.account_protection_enabled is None:
        return Verdict(
            "unknown",
            r.say(fr="Protection des comptes illisible.", en="Account protection unreadable."),
        )
    if not s.account_protection_enabled:
        return Verdict(
            "warning",
            r.say(
                fr="Protection des comptes coupée : rien ne freine les essais de mots de passe "
                "sur un compte.",
                en="Account protection off: nothing slows down password guessing on an account.",
            ),
        )
    return Verdict("ok", r.say(fr="Protection des comptes active.", en="Account protection on."))


def _ntp(t, r: Reads) -> Verdict:
    if t.ntp_enabled is False:
        return Verdict(
            "warning",
            r.say(
                fr="Heure réglée à la main : elle dérive, et avec elle les certificats, la "
                "double authentification et les journaux.",
                en="Clock set by hand: it drifts, and with it certificates, two-factor codes and "
                "logs.",
            ),
        )
    if t.ntp_synced is False:
        server = t.ntp_server or "NTP"
        return Verdict(
            "warning",
            r.say(
                fr=f"Synchronisation avec {server} en échec.",
                en=f"Synchronization with {server} failing.",
            ),
        )
    if t.ntp_enabled is None:
        return Verdict("unknown", r.say(fr="Réglage de l'heure illisible.", en="Clock unreadable."))
    return Verdict(
        "ok",
        r.say(
            fr=f"Heure synchronisée avec {t.ntp_server or 'un serveur NTP'}.",
            en=f"Clock synchronized with {t.ntp_server or 'an NTP server'}.",
        ),
    )


def _reboot(u, r: Reads) -> Verdict:
    if u.reboot_pending:
        return Verdict(
            "warning",
            r.say(
                fr="Une mise à jour attend un redémarrage pour s'appliquer.",
                en="An update waits for a restart to take effect.",
            ),
        )
    if u.reboot_pending is None:
        return Verdict("unknown", r.say(fr="Illisible.", en="Unreadable."))
    return Verdict("ok", r.say(fr="Aucun redémarrage en attente.", en="No restart pending."))


SPECS_UPDATES = (
    Spec(
        "updates.reboot",
        Text(fr="Redémarrage en attente", en="Restart pending"),
        "medium",
        ("dsm.update",),
        lambda _t, lang: say(
            lang,
            fr="Aucune mise à jour n'attend de redémarrage.",
            en="No update waiting for a restart.",
        ),
        Text(
            fr="Redémarrer le NAS à un moment calme, après une sauvegarde.",
            en="Restart the NAS at a quiet time, after a backup.",
        ),
        _reboot,
    ),
)

SPECS_ACCOUNTS = (
    Spec(
        "accounts.password_policy",
        Text(fr="Mots de passe", en="Passwords"),
        "medium",
        ("security.settings",),
        lambda t, lang: say(
            lang,
            fr=f"Au moins {t.password_min_length} caractères, mots de passe courants refusés.",
            en=f"At least {t.password_min_length} characters, common passwords refused.",
        ),
        Text(
            fr="Durcir la politique (Panneau de configuration, Utilisateur et groupe, Avancé) : "
            "au moins 12 caractères, et refuser les mots de passe courants.",
            en="Harden the policy (Control Panel, User & Group, Advanced): at least 12 "
            "characters, and refuse common passwords.",
        ),
        _password_policy,
    ),
    Spec(
        "accounts.protection",
        Text(fr="Protection des comptes", en="Account protection"),
        "medium",
        ("security.settings",),
        lambda _t, lang: say(
            lang,
            fr="Un compte se bloque après des échecs répétés.",
            en="An account is blocked after repeated failures.",
        ),
        Text(
            fr="Activer la protection des comptes (Panneau de configuration, Sécurité, Compte).",
            en="Turn account protection on (Control Panel, Security, Account).",
        ),
        _protection,
    ),
)

SPECS_ACCESS = (
    Spec(
        "access.smb1",
        Text(fr="SMB1", en="SMB1"),
        "high",
        ("services.list",),
        lambda _t, lang: say(lang, fr="SMB1 et NTLMv1 refusés.", en="SMB1 and NTLMv1 refused."),
        Text(
            fr="Passer le protocole SMB minimal à SMB2 (Panneau de configuration, Services de "
            "fichiers, SMB, Paramètres avancés).",
            en="Set the minimum SMB protocol to SMB2 (Control Panel, File Services, SMB, "
            "Advanced Settings).",
        ),
        _smb1,
    ),
    Spec(
        "access.cleartext",
        Text(fr="Services sans chiffrement", en="Unencrypted services"),
        "medium",
        ("services.list",),
        lambda _t, lang: say(
            lang,
            fr="Ni FTP sans TLS, ni rsync en mode démon, ni SNMP v1 ou v2c, ni AFP.",
            en="No FTP without TLS, rsync in daemon mode, SNMP v1 or v2c, or AFP.",
        ),
        Text(
            fr="Remplacer FTP par FTPS ou SFTP, rsync par rsync sur SSH, SNMP v1/v2c par SNMP v3, "
            "AFP par SMB (Panneau de configuration, Services de fichiers, Terminal et SNMP).",
            en="Replace FTP with FTPS or SFTP, rsync with rsync over SSH, SNMP v1/v2c with SNMP "
            "v3, AFP with SMB (Control Panel, File Services, Terminal & SNMP).",
        ),
        _cleartext,
    ),
    Spec(
        "access.https",
        Text(fr="DSM en HTTPS", en="DSM over HTTPS"),
        "medium",
        ("services.list",),
        lambda _t, lang: say(
            lang,
            fr="DSM redirige HTTP vers HTTPS.",
            en="DSM redirects HTTP to HTTPS.",
        ),
        Text(
            fr="Activer la redirection automatique vers HTTPS (Panneau de configuration, Portail "
            "de connexion, DSM).",
            en="Turn on automatic redirection to HTTPS (Control Panel, Login Portal, DSM).",
        ),
        _https,
    ),
    Spec(
        "access.closing",
        Text(fr="Accès à fermer", en="Access to close"),
        "medium",
        ("access.watch",),
        lambda _t, lang: say(
            lang,
            fr="Aucun accès oublié ouvert : SSH et Telnet fermés, ou fermés à l'heure dite.",
            en="No access left open: SSH and Telnet closed, or closed on time.",
        ),
        Text(
            fr="Prolonger depuis la console (onglet Sécurité) si l'accès sert encore ; sinon le "
            "fermer.",
            en="Push the deadline back from the console (Security tab) if the access is still in "
            "use; otherwise close it.",
        ),
        _closing,
    ),
)

SPECS_SYSTEM = (
    Spec(
        "system.ntp",
        Text(fr="Heure du NAS", en="NAS clock"),
        "medium",
        ("system.time",),
        lambda _t, lang: say(
            lang,
            fr="Heure synchronisée avec un serveur NTP.",
            en="Clock synchronized with an NTP server.",
        ),
        Text(
            fr="Activer la synchronisation avec un serveur NTP (Panneau de configuration, Options "
            "régionales, Heure).",
            en="Turn on synchronization with an NTP server (Control Panel, Regional Options, "
            "Time).",
        ),
        _ntp,
    ),
)


# Signes d'attaque (journaux des 24 dernières heures) ------------------------------------------


def _logins(a, r: Reads) -> Verdict:
    limits = r.limits
    items = (
        tuple(
            r.say(
                fr=f"{x.address} : {plural(x.failures, 'échec', 'échecs')}",
                en=f"{x.address}: {plural_en(x.failures, 'failure', 'failures')}",
            )
            for x in a.by_address
        )
        if r.personal
        else ()
    )
    count = r.say(
        fr=f"{plural(a.failures, 'échec', 'échecs')} de connexion en 24 h",
        en=f"{plural_en(a.failures, 'failed sign-in', 'failed sign-ins')} in 24 h",
    )
    if a.max_burst >= limits.login_burst:
        return Verdict(
            "failed",
            r.say(
                fr=f"{count}, dont {a.max_burst} en 10 minutes : quelqu'un essaie des mots de "
                "passe.",
                en=f"{count}, {a.max_burst} of them within 10 minutes: someone is guessing "
                "passwords.",
            ),
            items,
        )
    if a.failures >= limits.login_failures_warning:
        return Verdict("warning", r.say(fr=f"{count}.", en=f"{count}."), items)
    return Verdict("ok", r.say(fr=f"{count}.", en=f"{count}."))


def _file_activity(f, r: Reads) -> Verdict:
    logging = f.logging
    if logging is None or not (logging.smb or logging.file_station):
        return Verdict(
            "unknown",
            r.say(
                fr="Journal des transferts coupé : une suppression en masse passerait inaperçue.",
                en="Transfer log off: a mass deletion would go unnoticed.",
            ),
            advice=r.say(
                fr="Activer le journal des transferts de SMB et de File Station (Panneau de "
                "configuration, Services de fichiers, SMB, Paramètres avancés ; Centre des "
                "journaux).",
                en="Turn on the transfer log of SMB and File Station (Control Panel, File "
                "Services, SMB, Advanced Settings; Log Center).",
            ),
        )
    count = r.say(
        fr=f"{plural(f.deletions, 'suppression', 'suppressions')} et "
        f"{plural(f.renames_moves, 'renommage', 'renommages')} en 24 h",
        en=f"{plural_en(f.deletions, 'deletion', 'deletions')} and "
        f"{plural_en(f.renames_moves, 'rename', 'renames')} in 24 h",
    )
    if f.max_burst >= r.limits.mass_change_count:
        items = (
            tuple(
                r.say(
                    fr=f"{x.account} : {x.max_burst} en 10 minutes",
                    en=f"{x.account}: {x.max_burst} within 10 minutes",
                )
                for x in f.by_account
                if x.max_burst >= r.limits.mass_change_count
            )
            if r.personal
            else ()
        )
        return Verdict(
            "failed",
            r.say(
                fr=f"{count}, dont {f.max_burst} en 10 minutes par un même compte.",
                en=f"{count}, {f.max_burst} of them within 10 minutes by one account.",
            ),
            items,
        )
    return Verdict("ok", r.say(fr=f"{count}, aucune rafale.", en=f"{count}, no burst."))


SPECS_LOGINS = (
    Spec(
        "access.logins",
        Text(fr="Échecs de connexion", en="Failed sign-ins"),
        "high",
        ("security.logins",),
        lambda t, lang: say(
            lang,
            fr=f"Moins de {t.login_failures_warning} échecs en 24 h, jamais "
            f"{t.login_burst} en 10 minutes.",
            en=f"Fewer than {t.login_failures_warning} failures in 24 h, never "
            f"{t.login_burst} within 10 minutes.",
        ),
        Text(
            fr="Voir d'où viennent les essais (Centre des journaux, Connexions) ; bloquer "
            "l'adresse, fermer l'accès depuis Internet qu'elle utilise, imposer la double "
            "authentification.",
            en="See where the attempts come from (Log Center, Connections); block the address, "
            "close the Internet access it uses, enforce two-factor authentication.",
        ),
        _logins,
    ),
)

SPECS_FILES = (
    Spec(
        "shares.file_activity",
        Text(fr="Suppressions en masse", en="Mass deletions"),
        "high",
        ("files.activity",),
        lambda t, lang: say(
            lang,
            fr=f"Jamais {t.mass_change_count} suppressions ou renommages en 10 minutes par un "
            "même compte.",
            en=f"Never {t.mass_change_count} deletions or renames within 10 minutes by one "
            "account.",
        ),
        Text(
            fr="Couper sans attendre l'accès du compte en cause et débrancher le poste qui "
            "l'utilise ; puis restaurer depuis un instantané ou une sauvegarde.",
            en="Cut off the account’s access right away and unplug the computer using it; then "
            "restore from a snapshot or a backup.",
        ),
        _file_activity,
    ),
)
