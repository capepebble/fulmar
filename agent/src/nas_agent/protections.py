"""Les protections d'un NAS : ce que Fulmar n'y met jamais à jour (conception
2026-11-26-groupes-protections-parc, section 2).

Un NAS gelé, DSM verrouillé (pas de redémarrage par Fulmar), des paquets protégés, et une note
qui dit pourquoi. Un paquet dont dépend un paquet protégé l'est aussi : DSM arrête les paquets
qui dépendent de celui qu'il met à jour (`additional.dependent_packages` de la liste des
paquets, vérifié sur le NAS d'essai). Gardé dans `data/protections.json` ; c'est l'agent qui
l'applique, quel que soit l'appelant, rendez-vous et mises à jour du parc compris.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_ID = re.compile(r"^[A-Za-z0-9._+-]{1,64}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
NOTE_MAX = 200
MAX_LOCKED = 100


def _as_map(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


@dataclass
class Protections:
    frozen: bool = False
    dsm_locked: bool = False
    packages: list[str] = field(default_factory=list)
    note: str | None = None

    def model(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def dsm_blocked(self) -> bool:
        return self.frozen or self.dsm_locked

    def reasons(self, listing: Any) -> dict[str, str]:
        """Chaque paquet que Fulmar ne met pas à jour, avec sa raison : « frozen »,
        « protected », ou « needed by <paquet protégé> »."""
        installed = [
            _as_map(p) for p in _as_map(listing).get("packages", []) if isinstance(p, dict)
        ]
        out: dict[str, str] = {}
        if self.frozen:
            for p in installed:
                if isinstance(p.get("id"), str):
                    out[p["id"]] = "frozen"
        for pid in self.packages:
            out[pid] = "protected"
        for p in installed:
            if p.get("id") not in self.packages:
                continue
            needs = _as_map(_as_map(p.get("additional")).get("dependent_packages"))
            for dep in needs:
                if isinstance(dep, str) and _ID.match(dep):
                    out.setdefault(dep, f"needed by {p['id']}")
        return out


def clean_note(value: str) -> str | None:
    text = " ".join(_CONTROL.sub(" ", value).split())
    if len(text) > NOTE_MAX:
        raise ValueError(f"note: {NOTE_MAX} characters at most.")
    return text or None


class ProtectionStore:
    def __init__(self, path: Path | None = None):
        self._path = path
        self._value = Protections()
        self._load()

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text())
            packages = [p for p in data.get("packages", []) if isinstance(p, str) and _ID.match(p)]
            note = data.get("note")
            self._value = Protections(
                frozen=data.get("frozen") is True,
                dsm_locked=data.get("dsm_locked") is True,
                packages=packages[:MAX_LOCKED],
                note=clean_note(note) if isinstance(note, str) else None,
            )
        except (OSError, ValueError, TypeError):
            # Illisible : on garde le plus prudent, tout gelé, et on le dit.
            log.exception("Protections unreadable: the NAS is treated as frozen")
            self._value = Protections(frozen=True, note="protections file unreadable")

    def _save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(f".{self._path.name}.tmp")
        tmp.write_text(json.dumps(self._value.model(), indent=1))
        os.replace(tmp, self._path)

    def get(self) -> Protections:
        v = self._value
        return Protections(v.frozen, v.dsm_locked, list(v.packages), v.note)

    def update(
        self,
        *,
        frozen: bool | None = None,
        dsm_locked: bool | None = None,
        lock: list[str] | tuple[str, ...] = (),
        unlock: list[str] | tuple[str, ...] = (),
        note: str | None = None,
    ) -> Protections:
        for pid in (*lock, *unlock):
            if not _ID.match(pid):
                raise ValueError(f"Invalid package identifier: {pid[:64]!r}")
        v = self.get()
        if frozen is not None:
            v.frozen = frozen
        if dsm_locked is not None:
            v.dsm_locked = dsm_locked
        packages = [p for p in v.packages if p not in unlock]
        packages += [p for p in dict.fromkeys(lock) if p not in packages]
        if len(packages) > MAX_LOCKED:
            raise ValueError(f"At most {MAX_LOCKED} protected packages.")
        v.packages = packages
        if note is not None:
            v.note = clean_note(note)
        self._value = v
        self._save()
        return self.get()
