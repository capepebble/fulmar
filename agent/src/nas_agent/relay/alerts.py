"""Ce qui fait une alerte (protocole, section 8.2), et la règle des 30 minutes.

Chaque tour compare l'état neuf à la mémoire : passage d'un contrôle entre « ok »,
« warning » et « failed » (« unknown » ne change rien : DSM injoignable ne fait pas sonner),
exécution nouvelle d'une sauvegarde en échec, sauvegarde rétablie. Au premier tour, ou pour
un contrôle ou une tâche jamais vus, l'état lu sert de point de départ, sans alerte.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from nas_agent.i18n import Lang, say
from nas_agent.relay.state import BuiltState, iso

FLAP_WINDOW = timedelta(minutes=30)
RANK = {"recovered": 0, "notice": 1, "warning": 2, "critical": 3}
COUNTED = ("ok", "warning", "failed")


@dataclass
class Memory:
    """Mémoire de la surveillance, gardée dans agent.db (relay_kv « alerts »)."""

    checks: dict[str, str] = field(default_factory=dict)
    backups: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Dernière sonnerie par clé : alarme (critical, warning) et retour (recovered) à part.
    alarms: dict[str, dict[str, str]] = field(default_factory=dict)
    recoveries: dict[str, str] = field(default_factory=dict)
    started: bool = False

    @classmethod
    def load(cls, raw: Any) -> Memory:
        if not isinstance(raw, dict):
            return cls()
        return cls(
            checks=dict(raw.get("checks") or {}),
            backups=dict(raw.get("backups") or {}),
            alarms=dict(raw.get("alarms") or {}),
            recoveries=dict(raw.get("recoveries") or {}),
            started=bool(raw.get("started")),
        )

    def dump(self) -> dict[str, Any]:
        return {
            "checks": self.checks,
            "backups": self.backups,
            "alarms": self.alarms,
            "recoveries": self.recoveries,
            "started": self.started,
        }


def _level(before: str, after: str) -> str:
    if after == "failed":
        return "critical"
    if after == "warning" and before == "ok":
        return "warning"
    return "recovered"


def _rings(memory: Memory, key: str, level: str, now: datetime) -> bool:
    """Une même clé ne sonne qu'une fois par 30 minutes, sauf si son niveau monte."""
    if level == "recovered":
        last = memory.recoveries.get(key)
        if last is not None and now - datetime.fromisoformat(last) < FLAP_WINDOW:
            return False
        memory.recoveries[key] = now.isoformat()
        return True
    alarm = memory.alarms.get(key)
    if alarm is not None:
        recent = now - datetime.fromisoformat(alarm["at"]) < FLAP_WINDOW
        if recent and RANK[level] <= RANK.get(alarm["level"], 0):
            return False
    memory.alarms[key] = {"at": now.isoformat(), "level": level}
    return True


def detect(
    built: BuiltState, memory: Memory, now: datetime, lang: Lang = "en"
) -> list[dict[str, Any]]:
    """Les événements de ce tour ; met la mémoire à jour (statuts et sonneries)."""
    events: list[dict[str, Any]] = []
    first = not memory.started
    advice = {c["id"]: c.get("advice") for c in built.content.get("checks", [])}
    for check_id, (status, title, observed) in sorted(built.checks.items()):
        if status not in COUNTED:
            continue
        before = memory.checks.get(check_id)
        memory.checks[check_id] = status
        if first or before is None or before == status:
            continue
        level = _level(before, status)
        key = f"check:{check_id}"
        events.append(
            {
                "key": key,
                "kind": "check",
                "id": check_id,
                "title": title,
                "from": before,
                "to": status,
                "level": level,
                "ring": _rings(memory, key, level, now),
                "observed": observed,
                "advice": advice.get(check_id),
            }
        )
    for task_id, task in sorted(built.backups.items()):
        before = memory.backups.get(task_id)
        memory.backups[task_id] = {"failed": bool(task["failed"]), "run": task["run"]}
        if first or before is None:
            continue
        name = task.get("name") or say(lang, fr=f"tâche {task_id}", en=f"task {task_id}")
        key = f"backup:{task_id}"
        if task["failed"] and (not before.get("failed") or task["run"] != before.get("run")):
            title = say(lang, fr=f"Sauvegarde en échec : {name}", en=f"Backup failed: {name}")
            level, to, frm = "critical", "failed", "ok"
            if before.get("failed"):
                frm = "failed"
        elif not task["failed"] and before.get("failed"):
            title = say(lang, fr=f"Sauvegarde rétablie : {name}", en=f"Backup recovered: {name}")
            level, to, frm = "recovered", "ok", "failed"
        else:
            continue
        event = {
            "key": key,
            "kind": "backup",
            "id": task_id,
            "title": title,
            "from": frm,
            "to": to,
            "level": level,
            "ring": _rings(memory, key, level, now),
        }
        if level == "critical":
            event["error"] = task.get("error")
        events.append(event)
    memory.started = True
    return events


def header_level(events: list[dict[str, Any]]) -> tuple[str, bool]:
    """Niveau de l'en-tête signé : le plus haut de ceux qui sonnent, sinon de tous."""
    ringing = [e["level"] for e in events if e["ring"]]
    pool = ringing or [e["level"] for e in events]
    return max(pool, key=RANK.__getitem__), bool(ringing)


# Contenu en clair d'une alerte : le relais refuse une alerte de plus de 6 Kio (plus 256 octets
# par téléphone) ; chiffrée puis encodée deux fois en base64url, elle grossit de 80 % environ.
ALERT_PLAINTEXT_MAX = 2800
TEXT_MAX = 280
_TEXT_FIELDS = ("title", "observed", "advice", "error")


def alert_content(events: list[dict[str, Any]], nas_name: str | None, now: datetime) -> dict:
    """Le contenu `alert/1`, tenu sous ALERT_PLAINTEXT_MAX : textes coupés, puis les derniers
    événements retirés au besoin (`omitted` dit combien)."""
    trimmed = [
        {k: (v[:TEXT_MAX] if k in _TEXT_FIELDS and isinstance(v, str) else v) for k, v in e.items()}
        for e in events
    ]
    content: dict[str, Any] = {
        "schema": "alert/1",
        "at": iso(now),
        "nas_name": (nas_name or "")[:64] or None,
        "events": trimmed,
    }
    omitted = 0
    while len(json.dumps(content, ensure_ascii=False).encode()) > ALERT_PLAINTEXT_MAX:
        if len(content["events"]) <= 1:
            break
        content["events"] = content["events"][:-1]
        omitted += 1
        content["omitted"] = omitted
    return content


def notification_text(events: list[dict[str, Any]], nas_name: str | None) -> str | None:
    """Texte en clair (réglage clear_notifications) : « <titre> (<NAS>) », 140 caractères."""
    first = next((e for e in events if e["ring"]), None)
    if first is None:
        return None
    text = f"{first['title']} ({nas_name})" if nas_name else first["title"]
    return text[:140]
