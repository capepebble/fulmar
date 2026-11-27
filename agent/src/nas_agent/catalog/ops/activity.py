"""Signes d'attaque des 24 dernières heures, lus dans le Centre des journaux : échecs de
connexion et leurs rafales, suppressions et renommages en masse (premier signe d'un
rançongiciel). Conception 2026-11-26-meilleur-produit, section 3.5.

Les journaux sont lus depuis 24 heures, 1 000 lignes de connexion et 2 000 de transferts au
plus ; les comptes et les adresses sont des données personnelles (droit personal:read).
"""

from __future__ import annotations

import ipaddress
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from pydantic import BaseModel, Field

from nas_agent.catalog.model import DsmCall, OpContext, Operation
from nas_agent.catalog.ops._util import as_int, as_list, as_map, as_str, local_time
from nas_agent.catalog.ops.logs import TRANSFER_SETTINGS, TransferLogging

WINDOW_H = 24
BURST = timedelta(minutes=10)
MAX_CONNECTIONS = 1000
MAX_TRANSFERS = 2000
TOP = 10
VERIFIED = "DS420+, DSM 7.4.1-90080 Update 2 (NAS d'essai, 2026-11-26)"

# Textes du journal des connexions de DSM 7.4 (anglais), vus sur le NAS d'essai. Le compte est
# tapé par qui se connecte : on lit par la droite (adresse et service viennent de DSM, en fin
# de ligne), compte gourmand, fin ancrée.
_FAILED = re.compile(
    r"^User \[(?P<account>.*)\] from \[(?P<address>[^\]\[]+)\] failed to "
    r"(?:sign in to \[(?P<service>[^\]\[]+)\]|log in) via \[(?P<via>[^\]\[]+)\]"
    r" due to [^\[\]]*$"
)
_SUCCEEDED = re.compile(
    r"^User \[.*\] from \[[^\]\[]+\] (?:signed in to \[[^\]\[]+\] successfully|logged in "
    r"successfully) via \[[^\]\[]+\]\.?$"
)
# Une ligne d'échec que la forme connue ne lit pas reste un échec, sans adresse.
_LOOKS_FAILED = re.compile(r"\bfailed to (?:sign|log) in\b")
_DELETE = {"delete"}
_RENAME = {"rename", "move"}
_FILE_TYPES = "ftp,filestation,webdav,cifs,afp,tftp"


def _since() -> int:
    """Début de la fenêtre, à la minute : le cache tient le temps d'une minute."""
    now = int(time.time())
    return now - now % 60 - WINDOW_H * 3600


def _log_params(logtype: str, limit: int):
    def params(_p) -> dict:
        return {
            "target": "LOCAL",
            "logtype": logtype,
            "date_from": _since(),
            "date_to": 0,
            "keyword": "",
            "level": "",
            "start": 0,
            "limit": limit,
        }

    return params


CONNECTION_LOG = DsmCall(
    "SYNO.Core.SyslogClient.Log", "list", 1, params=_log_params("connection", MAX_CONNECTIONS)
)
TRANSFER_LOG = DsmCall(
    "SYNO.Core.SyslogClient.Log", "list", 1, params=_log_params(_FILE_TYPES, MAX_TRANSFERS)
)


def _burst(times: list[datetime]) -> int:
    """Le plus d'événements tenus dans une même fenêtre de 10 minutes."""
    ordered = sorted(times)
    best, start = 0, 0
    for end, at in enumerate(ordered):
        while at - ordered[start] > BURST:
            start += 1
        best = max(best, end - start + 1)
    return best


def _address(text: str) -> str | None:
    """Une vraie adresse IP, ou rien."""
    try:
        return str(ipaddress.ip_address(text.strip()))
    except ValueError:
        return None


def _at(value) -> datetime | None:
    iso = local_time(value)
    return datetime.fromisoformat(iso) if iso else None


class AddressFailures(BaseModel):
    address: str
    failures: int
    last_at: str | None = Field(description="NAS local time (ISO 8601, no time zone).")


class AccountFailures(BaseModel):
    account: str
    failures: int


class LoginFailure(BaseModel):
    time: str | None = Field(description="NAS local time (ISO 8601, no time zone).")
    account: str | None = Field(description="Account tried; missing when none was typed.")
    address: str | None
    service: str | None = Field(description='"DSM", "SSH" and the like.')


class LoginActivity(BaseModel):
    window_hours: int
    read: int = Field(description="Connection log lines read.")
    truncated: bool = Field(description="More lines than read in the window.")
    successes: int
    failures: int
    max_burst: int = Field(description="Most failures within any 10 minutes.")
    by_address: list[AddressFailures] = Field(description="Addresses with the most failures.")
    by_account: list[AccountFailures] = Field(description="Accounts with the most failures.")
    latest_failures: list[LoginFailure] = Field(description="From newest to oldest, 20 at most.")


def _logins(_ctx: OpContext, responses) -> LoginActivity:
    data = as_map(responses[CONNECTION_LOG.key])
    items = [i for i in as_list(data.get("items")) if isinstance(i, dict)]
    successes = 0
    failures: list[LoginFailure] = []
    times: list[datetime] = []
    by_address: Counter[str] = Counter()
    last_at: dict[str, str | None] = {}
    by_account: Counter[str] = Counter()
    for item in items:
        text = as_str(item.get("descr")) or ""
        match = _FAILED.match(text)
        if match is None and not _LOOKS_FAILED.search(text):
            successes += bool(_SUCCEEDED.match(text))
            continue
        at = local_time(item.get("time"))
        address = _address(match.group("address")) if match else None
        account = (match.group("account") or None) if match else None
        failures.append(
            LoginFailure(
                time=at,
                account=account,
                address=address,
                service=(match.group("service") or match.group("via")) if match else None,
            )
        )
        when = _at(item.get("time"))
        if when is not None:
            times.append(when)
        if address is not None:
            by_address[address] += 1
            last_at.setdefault(address, at)
        if account:
            by_account[account] += 1
    total = as_int(data.get("total"))
    return LoginActivity(
        window_hours=WINDOW_H,
        read=len(items),
        truncated=total is not None and total > len(items),
        successes=successes,
        failures=len(failures),
        max_burst=_burst(times),
        by_address=[
            AddressFailures(address=a, failures=n, last_at=last_at.get(a))
            for a, n in sorted(by_address.items(), key=lambda x: (-x[1], x[0]))[:TOP]
        ],
        by_account=[
            AccountFailures(account=a, failures=n)
            for a, n in sorted(by_account.items(), key=lambda x: (-x[1], x[0]))[:TOP]
        ],
        latest_failures=failures[:20],
    )


class AccountChanges(BaseModel):
    account: str
    deletions: int
    renames_moves: int
    max_burst: int = Field(description="Most deletions, renames and moves within 10 minutes.")


class FileActivity(BaseModel):
    window_hours: int
    read: int = Field(description="Transfer log lines read.")
    truncated: bool
    logging: TransferLogging | None = Field(description="Protocols whose transfers DSM logs.")
    deletions: int
    renames_moves: int
    max_burst: int = Field(
        description="Most deletions, renames and moves by one account within any 10 minutes."
    )
    by_account: list[AccountChanges] = Field(description="Accounts with the most changes.")


def _files(_ctx: OpContext, responses) -> FileActivity:
    data = as_map(responses[TRANSFER_LOG.key])
    items = [i for i in as_list(data.get("items")) if isinstance(i, dict)]
    deletions = renames = 0
    per: dict[str, dict[str, int]] = defaultdict(lambda: {"d": 0, "r": 0})
    times: dict[str, list[datetime]] = defaultdict(list)
    for item in items:
        action = (as_str(item.get("cmd")) or "").lower()
        if action not in _DELETE and action not in _RENAME:
            continue
        account = as_str(item.get("username")) or "?"
        if action in _DELETE:
            deletions += 1
            per[account]["d"] += 1
        else:
            renames += 1
            per[account]["r"] += 1
        when = _at(item.get("time"))
        if when is not None:
            times[account].append(when)
    bursts = {a: _burst(t) for a, t in times.items()}
    settings = responses.get(TRANSFER_SETTINGS.key)
    logging = None
    if isinstance(settings, dict):
        logging = TransferLogging(
            smb=settings.get("cifs") is True,
            file_station=settings.get("filestation") is True,
            ftp=settings.get("ftp") is True,
            webdav=settings.get("webdav") is True,
            afp=settings.get("afp") is True,
            tftp=settings.get("tftp") is True,
        )
    total = as_int(data.get("total"))
    ranked = sorted(per.items(), key=lambda x: (-(x[1]["d"] + x[1]["r"]), x[0]))[:TOP]
    return FileActivity(
        window_hours=WINDOW_H,
        read=len(items),
        truncated=total is not None and total > len(items),
        logging=logging,
        deletions=deletions,
        renames_moves=renames,
        max_burst=max(bursts.values(), default=0),
        by_account=[
            AccountChanges(
                account=a, deletions=c["d"], renames_moves=c["r"], max_burst=bursts.get(a, 0)
            )
            for a, c in ranked
        ],
    )


OPERATIONS = [
    Operation(
        id="security.logins",
        title="Sign-ins of the last 24 hours",
        description="Connection log of the last 24 hours: successful and failed sign-ins, the "
        "largest burst of failures within 10 minutes, the addresses and accounts with "
        "the most failures, the latest failures.",
        kind="read",
        scope="personal:read",
        personal=True,
        path="/security/logins",
        result_model=LoginActivity,
        transform=_logins,
        calls=(CONNECTION_LOG,),
        cache_ttl=60,
        verified_on=VERIFIED,
    ),
    Operation(
        id="files.activity",
        title="File changes of the last 24 hours",
        description="Transfer log of the last 24 hours: deletions, renames and moves, the "
        "largest burst by one account within 10 minutes (a ransomware sign), the "
        "accounts with the most changes, and the protocols whose transfers DSM logs.",
        kind="read",
        scope="personal:read",
        personal=True,
        path="/files/activity",
        result_model=FileActivity,
        transform=_files,
        calls=(TRANSFER_LOG, TRANSFER_SETTINGS),
        cache_ttl=60,
        verified_on=VERIFIED,
    ),
]
