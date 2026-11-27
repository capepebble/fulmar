"""Sonde de découverte d'un DSM, en lecture seule : sert à figer les opérations sur le NAS d'essai.

Les réponses brutes sont écrites hors du dépôt (dossier ignoré par git, mode 600) ; `scrub`
les nettoie avant d'en faire des réponses enregistrées pour les tests.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tomllib
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import Any

from nas_agent.dsm.gateway import DsmCaller, DsmError, DsmGatewayError, DsmUnsupported

READ_METHODS = frozenset(
    {
        "list",
        "get",
        "getinfo",
        "info",
        "status",
        "load_info",
        "query",
        "load",
        "check",
        "system_get",
        "rule_get",
        "first_get",
    }
)
_PROBE_MAX_VERSION = 99


def is_read_only(method: str) -> bool:
    return method in READ_METHODS or method.startswith(("list_", "get_"))


@dataclass(frozen=True)
class Candidate:
    api: str
    method: str
    params: Mapping[str, Any] = field(default_factory=dict)
    max_version: int = _PROBE_MAX_VERSION
    each: Mapping[str, str] | None = None


def load_candidates(text: str | None = None) -> list[Candidate]:
    if text is None:
        text = resources.files("nas_agent").joinpath("probe_candidates.toml").read_text()
    items = tomllib.loads(text).get("call", [])
    out = [
        Candidate(
            c["api"],
            c["method"],
            c.get("params", {}),
            c.get("max_version", _PROBE_MAX_VERSION),
            c.get("each"),
        )
        for c in items
    ]
    for c in out:
        if not is_read_only(c.method):
            raise ValueError(f"Method refused by the probe (not a read): {c.api}.{c.method}")
    return out


@dataclass
class ProbeLine:
    api: str
    method: str
    suffix: str
    outcome: str  # ok | absent | error <code> | unreachable


async def run_probe(
    dsm: DsmCaller, out_dir: Path, candidates: list[Candidate] | None = None
) -> list[ProbeLine]:
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)  # noqa: ASYNC240 - outil de dev, ponctuel
    candidates = candidates or load_candidates()
    lines: list[ProbeLine] = []
    seen: dict[str, dict[str, Any]] = {}

    try:
        apis = await dsm.call("SYNO.API.Info", "query", max_version=1, params={"query": "all"})
        _write(out_dir / "SYNO.API.Info.query.json", apis)
    except DsmGatewayError:
        apis = {}

    for cand in candidates:
        if not is_read_only(cand.method):  # double garde : la liste a pu être modifiée
            continue
        variants: list[tuple[str, dict[str, Any]]] = [("", dict(cand.params))]
        if cand.each:
            source = seen.get(cand.each["from"], {})
            items = source.get(cand.each["items"], [])
            key = cand.each["key"]
            ids = [str(item.get(key)) for item in items if isinstance(item, dict) and key in item]
            # « /dev/sata1 » : le fichier prend un nom plat, l'appel garde la valeur.
            variants = [(f".{i.replace('/', '_')}", {**cand.params, key: i}) for i in ids]
        for suffix, params in variants:
            outcome = "absent" if apis and cand.api not in apis else ""
            if not outcome:
                try:
                    data = await dsm.call(
                        cand.api, cand.method, max_version=cand.max_version, params=params
                    )
                    seen[f"{cand.api}.{cand.method}"] = data
                    _write(out_dir / f"{cand.api}.{cand.method}{suffix}.json", data)
                    outcome = "ok"
                except DsmUnsupported:
                    outcome = "absent"
                except DsmError as exc:
                    outcome = f"error {exc.code}"
                except DsmGatewayError:
                    outcome = "unreachable"
            lines.append(ProbeLine(cand.api, cand.method, suffix, outcome))

    summary = "\n".join(f"{x.api}\t{x.method}{x.suffix}\t{x.outcome}" for x in lines)
    _write_text(out_dir / "summary.tsv", summary + "\n")
    _write_text(
        out_dir / "versions.json",
        json.dumps(
            {
                k: {kk: v.get(kk) for kk in ("minVersion", "maxVersion")}
                for k, v in apis.items()
                if isinstance(v, dict)
            },
            indent=1,
            sort_keys=True,
        ),
    )
    return lines


def _write(path: Path, data: Any) -> None:
    _write_text(path, json.dumps(data, indent=1, ensure_ascii=False, sort_keys=True))


def _write_text(path: Path, text: str) -> None:
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)


# Nettoyage avant versionnement --------------------------------------------------------------

_MAC = re.compile(r"\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b")
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_SENSITIVE_KEYS = (
    "serial",
    "mac",
    "uuid",
    "email",
    "mail",
    "hostname",
    "server_name",
    "host_name",
    "ddns",
    "quickconnect",
    "qc_id",
    "server_alias",
    "server_id",
    # Hyper Backup : identifiant d'une destination, préfixé de l'adresse MAC sans séparateurs.
    "uni_key",
    "sn",
    "wan_ip",
    "external_ip",
    "description",
    "desc_full",
    "username",
    "user",
    "account",
    "owner",
    # Secrets et noms propres à un client : SNMP, notifications, nom de domaine de DSM.
    "community",
    "rocommunity",
    "rouser",
    "password",
    "passwd",
    "token",
    "secret",
    "fqdn",
)


# Comptes intégrés de DSM : ils n'identifient personne, les effacer partout brouillerait les
# journaux. Sous leur propre clé sensible, ils restent masqués comme le reste.
_BUILTIN_ACCOUNTS = frozenset({"SYSTEM", "SYSTEM_ADMIN", "root", "admin", "guest"})

_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
# Une valeur plus courte (« 1 », « on ») remplacerait n'importe quoi.
_MIN_KNOWN = 4


def _key_name(key: str) -> str:
    """« machineSerial » -> « machine_serial » : DSM mêle les deux styles."""
    return _CAMEL.sub("_", key).lower()


def _is_sensitive(key: str) -> bool:
    name = _key_name(key)
    return bool(name) and any(
        name == s or name.endswith(f"_{s}") or name.startswith(f"{s}_") for s in _SENSITIVE_KEYS
    )


def sensitive_values(obj: Any, key: str = "") -> set[str]:
    """Valeurs rangées sous une clé sensible, pour les traquer ensuite partout ailleurs."""
    if isinstance(obj, dict):
        return {v for k, item in obj.items() for v in sensitive_values(item, k)}
    if isinstance(obj, list):
        return {v for item in obj for v in sensitive_values(item, key)}
    value = obj.strip() if isinstance(obj, str) else ""
    if _is_sensitive(key) and len(value) >= _MIN_KNOWN and value not in _BUILTIN_ACCOUNTS:
        return {value}
    return set()


def scrub(obj: Any, key: str = "", known: Collection[str] = ()) -> Any:
    """Remplace par des valeurs fixes ce qui identifie un NAS, un client ou une personne.

    `known` : valeurs sensibles relevées ailleurs (`sensitive_values` sur toutes les réponses
    d'une sonde), effacées où qu'elles apparaissent, même sous une clé inattendue.
    """
    if isinstance(obj, dict):
        return {k: scrub(v, k, known) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(v, key, known) for v in obj]
    if isinstance(obj, str):
        if _is_sensitive(key):
            return f"<{_key_name(key)}>" if obj else obj
        text = obj
        for value in sorted(known, key=len, reverse=True):
            text = re.sub(rf"(?<![A-Za-z0-9]){re.escape(value)}(?![A-Za-z0-9])", "<redacted>", text)
        text = _MAC.sub("00:11:22:33:44:55", text)
        text = _EMAIL.sub("someone@example.org", text)
        return _IPV4.sub(_address, text)
    return obj


def _is_netmask(text: str) -> bool:
    """« 255.255.255.0 » : des 1 puis des 0 sur 32 bits ; un masque n'identifie rien."""
    octets = [int(o) for o in text.split(".")]
    if any(o > 255 for o in octets):
        return False
    bits = "".join(f"{o:08b}" for o in octets)
    return bits.startswith("1") and "01" not in bits


def _address(match: re.Match[str]) -> str:
    text = match.group()
    return text if text.startswith("127.") or _is_netmask(text) else "192.0.2.1"


def probe_main(dsm: DsmCaller, out_root: Path) -> int:
    out_dir = out_root / datetime.now(UTC).strftime("%Y%m%d-%H%M%S")

    async def go() -> list[ProbeLine]:
        try:
            return await run_probe(dsm, out_dir)
        finally:
            close = getattr(dsm, "close", None)
            if close is not None:
                await close()

    lines = asyncio.run(go())
    width = max((len(f"{x.api}.{x.method}{x.suffix}") for x in lines), default=10)
    for x in lines:
        print(
            f"{x.api}.{x.method}{x.suffix:<{max(0, width - len(x.api) - len(x.method) - 1)}}"
            f"  {x.outcome}"
        )
    print(f"\nRaw answers (never commit them): {out_dir}")
    return 0
