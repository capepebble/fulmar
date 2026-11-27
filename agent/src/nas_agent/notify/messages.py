"""Le message d'une alerte, le même pour tous les canaux : titre, corps en texte, charge JSON.

Les événements viennent de `relay/alerts.detect` ; seuls ceux qui sonnent partent.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from nas_agent.i18n import Lang, say
from nas_agent.relay.alerts import RANK
from nas_agent.relay.state import iso

TEXT_MAX = 280
_TEXT_FIELDS = ("title", "observed", "advice", "error")
# Le mot d'un événement suit l'état atteint : un contrôle qui passe de « failed » à « warning »
# n'est pas « rétabli », il est encore à surveiller.
WORD = {
    "fr": {"failed": "En échec", "warning": "À surveiller", "ok": "Rétabli"},
    "en": {"failed": "Failed", "warning": "Warning", "ok": "Recovered"},
}
DEFAULT_NAS = "NAS"


@dataclass(frozen=True)
class Message:
    nas: str
    at: datetime
    level: str
    summary: str
    body: str
    payload: dict[str, Any]
    lang: Lang = "en"

    @property
    def title(self) -> str:
        return say(self.lang, fr=f"{self.nas} : {self.summary}", en=f"{self.nas}: {self.summary}")

    def dump(self) -> dict[str, Any]:
        return {
            "nas": self.nas,
            "at": self.at.isoformat(),
            "level": self.level,
            "summary": self.summary,
            "body": self.body,
            "payload": self.payload,
            "lang": self.lang,
        }

    @classmethod
    def load(cls, raw: dict[str, Any]) -> Message:
        return cls(
            nas=raw["nas"],
            at=datetime.fromisoformat(raw["at"]),
            level=raw["level"],
            summary=raw["summary"],
            body=raw["body"],
            payload=raw["payload"],
            # Les messages en file d'avant les langues étaient en français.
            lang=raw.get("lang", "fr"),
        )


def _cut(e: dict[str, Any]) -> dict[str, Any]:
    return {
        k: (v[:TEXT_MAX] if k in _TEXT_FIELDS and isinstance(v, str) else v)
        for k, v in e.items()
        if k != "ring"
    }


def _lines(e: dict[str, Any], lang: Lang) -> str:
    word = WORD[lang].get(e.get("to", ""), say(lang, fr="Avis", en="Notice"))
    lines = [say(lang, fr=f"{word} : {e['title']}", en=f"{word}: {e['title']}")]
    for key in ("observed", "error"):
        if e.get(key):
            lines.append(str(e[key]))
    if e.get("advice") and e.get("to") != "ok":
        lines.append(say(lang, fr=f"À faire : {e['advice']}", en=f"To do: {e['advice']}"))
    return "\n".join(lines)


def compose(
    events: list[dict[str, Any]], nas_name: str | None, now: datetime, lang: Lang = "en"
) -> Message | None:
    """Un message pour les événements qui sonnent ; None s'il n'y en a aucun."""
    ringing = [_cut(e) for e in events if e.get("ring")]
    if not ringing:
        return None
    nas = (nas_name or "").strip()[:64] or DEFAULT_NAS
    level = max((e["level"] for e in ringing), key=RANK.__getitem__)
    if len(ringing) == 1:
        summary = ringing[0]["title"]
    else:
        graves = sum(1 for e in ringing if e["level"] == "critical")
        n = len(ringing)
        summary = say(
            lang,
            fr=f"{n} alertes"
            + (f", dont {graves} grave{'s' if graves > 1 else ''}" if graves else ""),
            en=f"{n} alerts" + (f", {graves} critical" if graves else ""),
        )
    body = "\n\n".join(_lines(e, lang) for e in ringing)
    payload = {
        "schema": "notify/1",
        "nas_name": nas_name or None,
        "at": iso(now),
        "level": level,
        "events": ringing,
    }
    return Message(
        nas=nas, at=now, level=level, summary=summary, body=body, payload=payload, lang=lang
    )


def trial_message(nas_name: str | None, now: datetime, lang: Lang = "en") -> Message:
    """Le message d'essai (`nas-agent notify test`)."""
    nas = (nas_name or "").strip()[:64] or DEFAULT_NAS
    body = say(
        lang,
        fr="Message d'essai de l'agent : ce canal reçoit bien les alertes de ce NAS.",
        en="Test message from the agent: this channel does receive this NAS’s alerts.",
    )
    payload = {
        "schema": "notify/1",
        "nas_name": nas_name or None,
        "at": iso(now),
        "level": "notice",
        "test": True,
        "events": [],
    }
    return Message(
        nas=nas,
        at=now,
        level="notice",
        summary=say(lang, fr="message d'essai", en="test message"),
        body=body,
        payload=payload,
        lang=lang,
    )
