"""Lectures défensives des réponses DSM : une forme inattendue donne None, pas une exception."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

# Formats d'heure locale vus dans DSM : Hyper Backup note la minute, parfois avec des tirets.
_DSM_TIMES = ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M")


def as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ("true", "false", "1", "0", "yes", "no"):
        return value.lower() in ("true", "1", "yes")
    if isinstance(value, int):
        return bool(value)
    return None


def local_time(value: Any) -> str | None:
    """« 2026/11/06 16:08:41 », heure locale du NAS sans fuseau -> ISO 8601 sans fuseau."""
    text = as_str(value) if isinstance(value, str) else None
    for fmt in _DSM_TIMES if text else ():
        try:
            return datetime.strptime(text, fmt).isoformat()
        except ValueError:
            continue
    return None


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_map(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def pct(used: int | None, total: int | None) -> float | None:
    if used is None or not total:
        return None
    return round(100.0 * used / total, 1)


# Vérifiée sur une réponse réelle de ce NAS (voir tests/fixtures/dsm/ds420p_dsm741_*).
VERIFIED_DS420P_DSM741 = "DS420+, DSM 7.4.1-90080 Update 1 (NAS d'essai, 2026-11-06)"
