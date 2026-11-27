"""Langues des textes que l'agent compose lui-même (conception du moteur en anglais, 2026-11-25).

Les verdicts des contrôles, les alertes et les titres des notifications s'écrivent en anglais et
en français, côte à côte là où ils se composent (`say`). La langue d'une lecture vient de
l'en-tête `Accept-Language` de la requête REST ; sinon, du réglage `language` de l'agent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, get_args

Lang = Literal["en", "fr"]
LANGS: tuple[Lang, ...] = get_args(Lang)
DEFAULT_LANG: Lang = "en"


def say(lang: Lang, *, fr: str, en: str) -> str:
    """Le texte dans la langue demandée."""
    return fr if lang == "fr" else en


@dataclass(frozen=True)
class Text:
    """Un texte fixe dans les deux langues."""

    fr: str
    en: str

    def __call__(self, lang: Lang) -> str:
        return say(lang, fr=self.fr, en=self.en)


def requested_lang(accept_language: str | None) -> Lang | None:
    """La langue demandée par un en-tête `Accept-Language`, ou None : celle de l'agent vaudra."""
    lang = pick_lang(accept_language, default="xx")  # type: ignore[arg-type]
    return None if lang == "xx" else lang


def pick_lang(accept_language: str | None, default: Lang = DEFAULT_LANG) -> Lang:
    """La première langue connue d'un en-tête `Accept-Language`, poids compris ; sinon `default`."""
    ranked: list[tuple[float, int, str]] = []
    for i, part in enumerate((accept_language or "").split(",")):
        tag, _, rest = part.strip().partition(";")
        weight = 1.0
        if rest.strip().startswith("q="):
            try:
                weight = float(rest.strip()[2:])
            except ValueError:
                weight = 0.0
        if tag and weight > 0:
            ranked.append((-weight, i, tag.split("-")[0].lower()))
    for _w, _i, code in sorted(ranked):
        if code in LANGS:
            return code  # type: ignore[return-value]
    return default
