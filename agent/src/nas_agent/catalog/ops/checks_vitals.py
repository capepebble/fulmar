"""Contrôles des constantes et de la disponibilité : processeur, mémoire, températures, DSM
joignable, conteneurs (conception 2026-11-26-meilleur-produit, sections 3.1 et 3.2).

Les seuils deviennent des contrôles : ils sonnent, reviennent à la normale et se coupent dans
la console comme les autres. Processeur et mémoire se lisent en moyenne sur 15 minutes dans
l'historique de l'agent ; sans historique, la valeur du moment.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta

from nas_agent.catalog.ops.checks_base import Reads, Spec, Verdict, minutes_text, pair, plural
from nas_agent.i18n import Lang, Text, say

WINDOW = timedelta(minutes=15)
# Moins d'échantillons que cela sur 15 minutes : l'historique ne suffit pas, valeur du moment.
_MIN_SAMPLES = 5
# Codes du relevé qui disent que DSM ne répond plus, ou ne doit plus être écouté.
_SILENT = {"dsm_unreachable", "dsm_certificate"}
_CORE_READS = ("system.utilization", "system.info", "storage.overview")
# Codes de sortie d'un arrêt voulu : 0 (propre), 137 (SIGKILL de docker stop), 143 (SIGTERM).
_CLEAN_EXITS = {0, 137, 143}


def _mean(r: Reads, metric: str) -> float | None:
    if r.history is None or r.now is None:
        return None
    points = r.history.read("1m", r.now - WINDOW).get((metric, ""), [])
    samples = sum(p.n for p in points)
    if samples < _MIN_SAMPLES:
        return None
    return sum(p.avg * p.n for p in points) / samples


def _load_check(metric: str, limit_name: str, what: Text):
    def evaluate(u, r: Reads) -> Verdict:
        limit = getattr(r.limits, limit_name)
        mean = _mean(r, metric)
        now_value = u.cpu.total_pct if metric == "cpu_pct" else u.memory.real_usage_pct
        value = mean if mean is not None else now_value
        if value is None:
            return Verdict("unknown", r.say(fr="Valeur illisible.", en="Value unreadable."))
        label = what(r.lang)
        how = (
            r.say(fr="en moyenne sur 15 min", en="on average over 15 min")
            if mean is not None
            else r.say(fr="en ce moment", en="right now")
        )
        observed = r.say(
            fr=f"{label} à {round(value)} % {how}.", en=f"{label} at {round(value)} % {how}."
        )
        return Verdict("warning" if value >= limit else "ok", observed)

    return evaluate


def _temperature(info, r: Reads) -> Verdict:
    limits = r.limits
    storage = r.get("storage.overview")
    hot: list[str] = []
    status = "ok"
    for disk in getattr(storage, "disks", None) or []:
        temp = disk.temperature_c
        if not temp or temp <= 0:
            continue
        if temp >= limits.disk_temperature_failure_c:
            status = "failed"
        elif temp >= limits.disk_temperature_warning_c and status != "failed":
            status = "warning"
        else:
            continue
        hot.append(pair(r, disk.name or disk.id or "?", f"{temp} °C"))
    system = info.temperature_c if info is not None else None
    if system and system >= limits.system_temperature_warning_c:
        hot.insert(0, pair(r, r.say(fr="Système", en="System"), f"{system} °C"))
        if status == "ok":
            status = "warning"
    if hot:
        n = len(hot)
        return Verdict(
            status,
            r.say(
                fr=f"{plural(n, 'température', 'températures')} trop haute{'s' if n > 1 else ''}.",
                en=f"{n} temperature{'s' if n > 1 else ''} too high.",
            ),
            tuple(hot),
        )
    temps = [d.temperature_c for d in getattr(storage, "disks", None) or [] if d.temperature_c]
    hottest = max(temps, default=None)
    parts = []
    if system:
        parts.append(r.say(fr=f"système à {system} °C", en=f"system at {system} °C"))
    if hottest:
        parts.append(
            r.say(fr=f"disque le plus chaud à {hottest} °C", en=f"hottest disk at {hottest} °C")
        )
    text = ", ".join(parts) if parts else r.say(fr="aucune lue", en="none read")
    return Verdict("ok", r.say(fr=f"Températures normales : {text}.", en=f"Normal: {text}."))


def silence(
    failing: Iterable[tuple[str, str, datetime]], now: datetime, minutes: int, lang: Lang
) -> Verdict:
    """DSM joignable, d'après le relevé : (lecture, code, depuis) des lectures en échec.

    Sert au rapport d'audit et à l'état des alertes quand DSM ne répond plus du tout.
    """
    silent = [(code, since) for op, code, since in failing if op in _CORE_READS and code in _SILENT]
    if not silent:
        return Verdict("ok", say(lang, fr="DSM répond.", en="DSM answers."))
    since = min(s for _, s in silent)
    elapsed = (now - since).total_seconds() / 60
    if elapsed < minutes:
        # Trop tôt pour sonner : une seconde lecture le dira.
        return Verdict("ok", say(lang, fr="DSM répond.", en="DSM answers."))
    duration = minutes_text(elapsed, lang)
    if any(code == "dsm_certificate" for code, _ in silent):
        return Verdict(
            "failed",
            say(
                lang,
                fr=f"Le certificat de DSM a changé il y a {duration} : l'agent refuse de lui "
                "parler.",
                en=f"DSM’s certificate changed {duration} ago: the agent refuses to talk to it.",
            ),
            advice=say(
                lang,
                fr="Si le certificat de DSM vient d'être changé, confirmer la nouvelle empreinte "
                "en reliant de nouveau l'agent ; sinon, chercher ce qui s'est glissé entre "
                "l'agent et le NAS.",
                en="If DSM’s certificate was just changed, confirm the new fingerprint by "
                "linking the agent again; otherwise, look for what got between the agent and "
                "the NAS.",
            ),
        )
    return Verdict(
        "failed",
        say(
            lang,
            fr=f"DSM ne répond plus depuis {duration}.",
            en=f"DSM has not answered for {duration}.",
        ),
    )


def _reachable(_info, r: Reads) -> Verdict:
    if r.history is None or r.now is None:
        return Verdict("ok", r.say(fr="DSM répond.", en="DSM answers."))
    failing = ((op, f.code, f.since) for op, f in r.history.status.failing.items())
    return silence(failing, r.now, r.limits.unreachable_minutes, r.lang)


def _containers(c, r: Reads) -> Verdict:
    if not c.containers:
        return Verdict("ok", r.say(fr="Aucun conteneur.", en="No container."))
    failed: list[str] = []
    warned: list[str] = []
    for x in c.containers:
        if x.state == "restarting":
            failed.append(pair(r, x.name, r.say(fr="redémarre en boucle", en="restart loop")))
        elif x.health == "unhealthy":
            failed.append(pair(r, x.name, r.say(fr="en mauvaise santé", en="unhealthy")))
        elif x.oom_killed:
            warned.append(
                pair(r, x.name, r.say(fr="tué, mémoire épuisée", en="killed, out of memory"))
            )
        elif x.state in ("exited", "dead") and x.exit_code not in _CLEAN_EXITS:
            code = x.exit_code if x.exit_code is not None else "?"
            warned.append(
                pair(r, x.name, r.say(fr=f"arrêté seul (code {code})", en=f"stopped (code {code})"))
            )
    if failed or warned:
        n = len(failed) + len(warned)
        return Verdict(
            "failed" if failed else "warning",
            r.say(
                fr=f"{plural(n, 'conteneur', 'conteneurs')} en difficulté.",
                en=f"{plural(n, 'container', 'containers')} in trouble.",
            ),
            tuple(failed + warned),
        )
    total, running = c.summary.total, c.summary.running
    return Verdict(
        "ok",
        r.say(
            fr=f"{plural(total, 'conteneur', 'conteneurs')}, {running} en marche, aucun en "
            "difficulté.",
            en=f"{plural(total, 'container', 'containers')}, {running} running, none in trouble.",
        ),
    )


def _no_container_manager(lang: Lang) -> Verdict:
    return Verdict(
        "ok",
        say(
            lang, fr="Container Manager n'est pas installé.", en="Container Manager not installed."
        ),
    )


SPECS = (
    Spec(
        "system.reachable",
        Text(fr="DSM joignable", en="DSM reachable"),
        "high",
        ("system.info",),
        lambda t, lang: say(
            lang,
            fr=f"DSM répond à l'agent ; une alerte au bout de {t.unreachable_minutes} min de "
            "silence.",
            en=f"DSM answers the agent; an alert after {t.unreachable_minutes} min of silence.",
        ),
        Text(
            fr="Vérifier que le NAS est allumé et sur le réseau (câble, box, coupure de courant), "
            "puis que DSM répond sur son adresse.",
            en="Check that the NAS is on and connected (cable, router, power cut), then that DSM "
            "answers on its address.",
        ),
        _reachable,
        always=True,
    ),
    Spec(
        "system.cpu",
        Text(fr="Processeur", en="Processor"),
        "medium",
        ("system.utilization",),
        lambda t, lang: say(
            lang,
            fr=f"Processeur sous {t.cpu_warning_pct} % en moyenne sur 15 min.",
            en=f"Processor below {t.cpu_warning_pct} % on average over 15 min.",
        ),
        Text(
            fr="Chercher ce qui occupe le processeur (Moniteur de ressources, conteneurs, "
            "indexation des photos) ; une charge durable ralentit tout le NAS.",
            en="Find what keeps the processor busy (Resource Monitor, containers, photo "
            "indexing); a lasting load slows the whole NAS.",
        ),
        _load_check("cpu_pct", "cpu_warning_pct", Text(fr="Processeur", en="Processor")),
    ),
    Spec(
        "system.memory",
        Text(fr="Mémoire", en="Memory"),
        "medium",
        ("system.utilization",),
        lambda t, lang: say(
            lang,
            fr=f"Mémoire sous {t.memory_warning_pct} % en moyenne sur 15 min.",
            en=f"Memory below {t.memory_warning_pct} % on average over 15 min.",
        ),
        Text(
            fr="Arrêter ce qui ne sert pas (paquets, conteneurs) ou ajouter de la mémoire : un "
            "NAS à court de mémoire écrit sur ses disques et ralentit.",
            en="Stop what is not needed (packages, containers) or add memory: a NAS short of "
            "memory swaps to its disks and slows down.",
        ),
        _load_check("memory_pct", "memory_warning_pct", Text(fr="Mémoire", en="Memory")),
    ),
    Spec(
        "system.temperature",
        Text(fr="Températures", en="Temperatures"),
        "high",
        ("system.info", "storage.overview"),
        lambda t, lang: say(
            lang,
            fr=f"Disques sous {t.disk_temperature_warning_c} °C (échec à "
            f"{t.disk_temperature_failure_c} °C), système sous "
            f"{t.system_temperature_warning_c} °C.",
            en=f"Disks below {t.disk_temperature_warning_c} °C (failure at "
            f"{t.disk_temperature_failure_c} °C), system below "
            f"{t.system_temperature_warning_c} °C.",
        ),
        Text(
            fr="Dégager les aérations, dépoussiérer, vérifier les ventilateurs et la pièce : "
            "la chaleur use les disques.",
            en="Clear the vents, dust the NAS, check the fans and the room: heat wears disks out.",
        ),
        _temperature,
    ),
    Spec(
        "containers.state",
        Text(fr="Conteneurs", en="Containers"),
        "medium",
        ("containers.list",),
        lambda _t, lang: say(
            lang,
            fr="Aucun conteneur en boucle, en mauvaise santé ou arrêté seul.",
            en="No container looping, unhealthy or stopped on its own.",
        ),
        Text(
            fr="Ouvrir le journal du conteneur dans Container Manager et corriger la cause "
            "(configuration, mémoire, image).",
            en="Open the container’s log in Container Manager and fix the cause "
            "(configuration, memory, image).",
        ),
        _containers,
        when_unsupported=_no_container_manager,
    ),
)
