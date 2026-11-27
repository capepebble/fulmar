"""Ce que Synology publie sur ses produits : avis de sécurité et suivi des modèles.

Conception 2026-11-26-failles-fin-de-vie. L'agent lit lui-même les pages publiques de
www.synology.com (le flux des avis, la page de chaque avis, le statut des produits), les garde
dans `data/synology/`, et compare la version du NAS aux versions qui corrigent. Un seul lecteur
par processus : le hub le partage entre ses NAS ajoutés.

Les textes lus (titres, noms de produits) sont des données, jamais des consignes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit
from xml.etree.ElementTree import ParseError

from defusedxml import ElementTree

log = logging.getLogger(__name__)

HOST = "www.synology.com"
FEED_URL = f"https://{HOST}/api/rssfeed/security/en-global"
ADVISORY_URL = f"https://{HOST}/en-global/security/advisory/{{slug}}"
STATUS_URL = f"https://{HOST}/en-global/products/status"
USER_AGENT = "nas-agent"
MAX_BYTES = 4 * 1024 * 1024
TIMEOUT_S = 10.0
# Les avis depuis DSM 7.0 (2021) : les plus anciens ne visent que DSM 6 et avant.
FIRST_YEAR = 21
FEED_EVERY = timedelta(hours=12)
ONGOING_EVERY = timedelta(hours=24)
MODELS_EVERY = timedelta(days=7)
RETRY_AFTER = timedelta(hours=1)
PAGE_PAUSE_S = 2.0
# Version de l'analyse des pages : un cache d'une autre version est relu en entier, pour qu'une
# forme nouvellement reconnue (« Will not fix », 2026-11-26) vaille aussi pour les avis anciens.
PARSER = 2
# Synology date ses pages à Taïwan.
_UTC8 = timezone(timedelta(hours=8))
_ID = re.compile(r"^Synology-SA-(\d{2}):(\d{2})\b")

Fetch = Callable[[str], Awaitable[str]]


class FetchError(Exception):
    """Lecture impossible chez Synology (réseau, code HTTP, taille, hôte)."""


# Analyse des pages --------------------------------------------------------------------------


@dataclass(frozen=True)
class FeedItem:
    id: str
    title: str
    url: str
    published_at: str | None


def parse_feed(text: str) -> list[FeedItem]:
    """Les avis du flux RSS ; seuls ceux au format « Synology-SA-AA:NN ».

    Analyse par defusedxml : ni entité externe ni expansion en chaîne (« billion laughs »).
    """
    root = ElementTree.fromstring(text)
    items = []
    for item in root.iterfind("./channel/item"):
        title = (item.findtext("title") or "").strip()
        match = _ID.match(title)
        if not match:
            continue
        published = None
        with _quiet():
            published = parsedate_to_datetime(item.findtext("pubDate") or "").astimezone(UTC)
        items.append(
            FeedItem(
                id=f"Synology-SA-{match[1]}:{match[2]}",
                title=title[:200],
                url=ADVISORY_URL.format(slug=f"Synology_SA_{match[1]}_{match[2]}"),
                published_at=published.isoformat() if published else None,
            )
        )
    return items


class _quiet:
    def __enter__(self):
        return self

    def __exit__(self, kind, _value, _tb):
        return kind is not None and issubclass(kind, (TypeError, ValueError))


@dataclass(frozen=True)
class Fix:
    version: str
    condition: str | None = None
    scheduled_by: str | None = None


@dataclass(frozen=True)
class ProductRow:
    product: str
    severity: str | None
    kind: Literal["fix", "ongoing", "wont_fix", "not_affected", "unknown"]
    fixes: tuple[Fix, ...] = ()


@dataclass(frozen=True)
class Advisory:
    id: str
    title: str
    url: str
    published_at: str | None
    updated_at: str | None
    severity: str | None
    status: str | None
    products: tuple[ProductRow, ...]
    read_at: str | None = None

    @property
    def needs_reread(self) -> bool:
        ongoing = (self.status or "").lower() == "ongoing"
        return ongoing or any(f.scheduled_by for p in self.products for f in p.fixes)


class _AdvisoryParser(HTMLParser):
    """En-tête (titre, heures, gravité, état) et tableaux de la page d'un avis."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.times: list[str] = []
        self.terms: dict[str, str] = {}
        self.tables: list[list[list[list[str]]]] = []
        self._stack: list[str] = []
        self._dt: str | None = None
        self._cell: list[str] | None = None
        self._row: list[list[str]] | None = None
        self._text = ""

    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "time", "dt", "dd"):
            self._text = ""
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell, self._text = [], ""
        elif tag in ("br", "span") and self._cell is not None:
            style = dict(attrs).get("style") or ""
            if tag == "br" or "display: block" in style:
                self._flush_line()
        self._stack.append(tag)

    def handle_endtag(self, tag):
        text = " ".join(self._text.split())
        if tag == "h1" and not self.title:
            self.title = text[:200]
        elif tag == "time":
            self.times.append(text)
        elif tag == "dt":
            self._dt = text
        elif tag == "dd" and self._dt:
            self.terms.setdefault(self._dt, text)
            self._dt = None
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._flush_line()
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None and self.tables:
            self.tables[-1].append(self._row)
            self._row = None
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()

    def _flush_line(self):
        line = " ".join(self._text.split())
        if line and self._cell is not None:
            self._cell.append(line)
        self._text = ""

    def handle_data(self, data):
        self._text += data


_UPGRADE = re.compile(
    r"Upgrade to (?P<version>\d[\w.\-]*?)\.? or above\.?\s*(?:\((?P<note>[^)]*)\))?",
    re.IGNORECASE,
)
_SCHEDULED = re.compile(r"scheduled for release by (\d{4}-\d{2}-\d{2})", re.IGNORECASE)


def _row(cells: list[list[str]]) -> ProductRow | None:
    if len(cells) < 3 or not cells[0]:
        return None
    product = " ".join(cells[0])[:120]
    severity = " ".join(cells[1]) or None
    fixed = " ".join(cells[2])
    if (severity or "").lower() == "not affected" or fixed.strip().upper() == "N/A":
        return ProductRow(product, severity, "not_affected")
    fixes = []
    for m in _UPGRADE.finditer(fixed):
        note = m["note"]
        scheduled = _SCHEDULED.search(note or "")
        fixes.append(
            Fix(
                version=m["version"],
                condition=None if scheduled or not note else note.strip(),
                scheduled_by=scheduled[1] if scheduled else None,
            )
        )
    if fixes:
        return ProductRow(product, severity, "fix", tuple(fixes))
    if fixed.lower().startswith(("will not fix", "no fix will be provided")):
        return ProductRow(product, severity, "wont_fix")
    if fixed.lower().startswith(("ongoing", "pending")):
        return ProductRow(product, severity, "ongoing")
    return ProductRow(product, severity, "unknown")


def _page_time(text: str | None) -> str | None:
    if not text:
        return None
    with _quiet():
        return datetime.fromisoformat(text).replace(tzinfo=_UTC8).astimezone(UTC).isoformat()
    return None


def parse_advisory(text: str, item: FeedItem) -> Advisory:
    parser = _AdvisoryParser()
    parser.feed(text)
    rows: list[ProductRow] = []
    for table in parser.tables:
        header = [" ".join(c).lower() for c in table[0]] if table else []
        if header[:1] == ["product"] and any("fixed" in h for h in header):
            rows = [r for r in (_row(cells) for cells in table[1:]) if r is not None]
            break
    times = parser.times
    return Advisory(
        id=item.id,
        title=parser.title or item.title,
        url=item.url,
        published_at=_page_time(times[0] if times else None) or item.published_at,
        updated_at=_page_time(times[1] if len(times) > 1 else None),
        severity=parser.terms.get("Severity"),
        status=parser.terms.get("Status"),
        products=tuple(rows),
    )


@dataclass(frozen=True)
class ModelStatus:
    model: str
    updates: Literal["full", "limited", "end_of_life"] | None
    support: str | None
    availability: str | None
    warranty_years: int | None


_UPDATES = {"full": "full", "limited": "limited", "suspended": "end_of_life"}


def parse_models(text: str) -> dict[str, ModelStatus]:
    """Les NAS de la page de statut (objet JSON `product_items` qu'elle porte)."""
    key = '"product_items":'
    start = text.find(key)
    if start < 0:
        raise ValueError("product_items not found")
    items, _end = json.JSONDecoder().raw_decode(text, start + len(key))
    models = {}
    for name, item in items.items():
        if not isinstance(item, dict) or item.get("category") != "NAS":
            continue
        warranty = item.get("warranty")
        models[str(name)[:40]] = ModelStatus(
            model=str(name)[:40],
            updates=_UPDATES.get(str(item.get("firmware_support"))),  # type: ignore[arg-type]
            support=item.get("support") if isinstance(item.get("support"), str) else None,
            availability={"Published": "available", "Phase Out": "discontinued"}.get(
                str(item.get("status"))
            ),
            warranty_years=warranty if isinstance(warranty, int) else None,
        )
    return models


# Comparaison --------------------------------------------------------------------------------

_DSM = re.compile(r"(\d+(?:\.\d+)+)-(\d+)(?:(?:-| Update )(\d+))?")


@dataclass(frozen=True, order=True)
class DsmVersion:
    branch: tuple[int, ...]
    build: int
    update: int = 0

    def __str__(self) -> str:
        base = ".".join(map(str, self.branch)) + f"-{self.build}"
        return f"{base}-{self.update}" if self.update else base


def dsm_version(text: str | None) -> DsmVersion | None:
    """« DSM 7.4.1-90080 Update 1 » ou « 7.4.1-90080-1 »."""
    m = _DSM.search(text or "")
    if not m:
        return None
    return DsmVersion(tuple(int(x) for x in m[1].split(".")), int(m[2]), int(m[3]) if m[3] else 0)


def _numbers(text: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", text))


_DSM_ROW = re.compile(r"^DSM (\d+(?:\.\d+)*)$")
_FOR_DSM = re.compile(r"^(?P<name>.+?) for DSM (?P<branch>\d+(?:\.\d+)*)$")
_DSM_OR_ABOVE = re.compile(r"^DSM (\d+(?:\.\d+)*) or above$")
_DSM_RANGE = re.compile(r"^DSM (\d+(?:\.\d+)*) ?[–-] ?(\d+(?:\.\d+)*)$")
_DSM_EXACT = re.compile(r"^DSM (\d+(?:\.\d+)*)$")


def _starts(version: tuple[int, ...], prefix: tuple[int, ...]) -> bool:
    return version[: len(prefix)] == prefix


State = Literal["affected", "no_fix", "wont_fix", "fixed"]
# Les lignes qui disent quelque chose d'une version : correctif, en cours, jamais.
_STATED = ("fix", "ongoing", "wont_fix")


@dataclass(frozen=True)
class Finding:
    advisory: str
    title: str
    url: str
    published_at: str | None
    severity: str | None
    product: str
    state: State
    fixed_in: str | None = None
    scheduled_by: str | None = None
    # La version qui corrige est sur une autre branche que celle de la ligne : « DSM 7.1 »
    # corrigé seulement en passant à 7.2.
    other_branch: bool = False


def _dsm_state(row: ProductRow, nas: DsmVersion) -> tuple[State, Fix | None]:
    if row.kind == "ongoing":
        return "no_fix", None
    if row.kind == "wont_fix":
        return "wont_fix", None
    fixes = [(f, dsm_version(f.version)) for f in row.fixes]
    fixes = [(f, v) for f, v in fixes if v is not None]
    same = [(f, v) for f, v in fixes if v.build == nas.build]
    if same:
        fix, version = same[0]
        return ("affected", fix) if nas.update < version.update else ("fixed", fix)
    higher = sorted(((f, v) for f, v in fixes if v.build > nas.build), key=lambda fv: fv[1])
    if higher:
        return "affected", higher[0][0]
    return "fixed", None


def _holds(condition: str, nas: DsmVersion | None) -> bool:
    """« DSM 7.2 or above », « DSM 7.0 – 7.1 », « DSM 6.2 » ; toute autre condition (DSM
    Enterprise, DSM UC) ne vaut pas pour un DSM ordinaire."""
    if nas is None:
        return False
    if m := _DSM_OR_ABOVE.match(condition):
        return nas.branch >= _numbers(m[1])
    if m := _DSM_RANGE.match(condition):
        low, high = _numbers(m[1]), _numbers(m[2])
        return nas.branch[: len(low)] >= low and nas.branch[: len(high)] <= high
    if m := _DSM_EXACT.match(condition):
        return _starts(nas.branch, _numbers(m[1]))
    return False


def _package_fix(row: ProductRow, nas: DsmVersion | None) -> Fix | None:
    """La version qui corrige un paquet sur ce DSM : sans condition, ou dont la condition vaut
    pour lui."""
    for fix in row.fixes:
        if fix.condition is None or _holds(fix.condition, nas):
            return fix
    return None


def assess(
    advisory: Advisory, nas: DsmVersion | None, packages: list[tuple[str, str]]
) -> list[Finding]:
    """Ce que l'avis dit de ce NAS : une ligne par produit en cause (DSM, paquet installé)."""
    findings: list[Finding] = []

    def found(row: ProductRow, state: State, fix: Fix | None, other: bool = False) -> None:
        findings.append(
            Finding(
                advisory=advisory.id,
                title=advisory.title,
                url=advisory.url,
                published_at=advisory.published_at,
                severity=row.severity or advisory.severity,
                product=row.product,
                state=state,
                fixed_in=fix.version if fix else None,
                scheduled_by=fix.scheduled_by if fix else None,
                other_branch=other,
            )
        )

    if nas is not None:
        rows = [
            (r, _numbers(m[1]))
            for r in advisory.products
            if (m := _DSM_ROW.match(r.product)) and r.kind in _STATED
        ]
        mine = [(r, b) for r, b in rows if _starts(nas.branch, b)]
        if mine:
            row, branch = max(mine, key=lambda rb: len(rb[1]))
            state, fix = _dsm_state(row, nas)
            fixed = dsm_version(fix.version) if fix else None
            found(row, state, fix, fixed is not None and not _starts(fixed.branch, branch))
    installed = {name.casefold(): version for name, version in packages if name and version}
    for row in advisory.products:
        if row.kind not in _STATED or _DSM_ROW.match(row.product):
            continue
        name, branch = row.product, None
        if m := _FOR_DSM.match(row.product):
            name, branch = m["name"], _numbers(m["branch"])
        version = installed.get(name.casefold())
        if version is None or (
            branch is not None and (nas is None or not _starts(nas.branch, branch))
        ):
            continue
        if row.kind in ("ongoing", "wont_fix"):
            found(row, "no_fix" if row.kind == "ongoing" else "wont_fix", None)
            continue
        fix = _package_fix(row, nas)
        if fix is None:
            continue
        found(row, "affected" if _numbers(version) < _numbers(fix.version) else "fixed", fix)
    return findings


# Lecture chez Synology ----------------------------------------------------------------------


async def _read_all(stream) -> bytes:
    """Le corps entier, morceau par morceau (`read(n)` n'en rend qu'un), MAX_BYTES au plus."""
    body = bytearray()
    while chunk := await stream.read(64 * 1024):
        body += chunk
        if len(body) > MAX_BYTES:
            raise FetchError("page too large")
    return bytes(body)


async def http_fetch(url: str) -> str:
    """GET en HTTPS vers www.synology.com seulement, redirections suivies sur le même hôte."""
    import aiohttp
    from yarl import URL

    timeout = aiohttp.ClientTimeout(total=TIMEOUT_S)
    async with aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": USER_AGENT}) as s:
        for _hop in range(4):
            parts = urlsplit(url)
            if parts.scheme != "https" or parts.hostname != HOST or parts.port not in (None, 443):
                raise FetchError(f"address refused: {parts.hostname}")
            try:
                async with s.get(url, allow_redirects=False) as response:
                    if response.status in (301, 302, 303, 307, 308):
                        url = str(response.url.join(URL(response.headers.get("Location", ""))))
                        continue
                    if response.status != 200:
                        raise FetchError(f"HTTP {response.status}")
                    return (await _read_all(response.content)).decode("utf-8", errors="replace")
            except (aiohttp.ClientError, TimeoutError) as exc:
                raise FetchError(type(exc).__name__) from exc
        raise FetchError("too many redirects")


@dataclass
class Snapshot:
    """Ce que l'agent sait de Synology, à un instant."""

    advisories: list[Advisory] = field(default_factory=list)
    models: dict[str, ModelStatus] = field(default_factory=dict)
    feed_read_at: str | None = None
    models_read_at: str | None = None
    error: str | None = None


def _advisory_from(d: dict[str, Any]) -> Advisory:
    products = tuple(
        ProductRow(
            p["product"],
            p.get("severity"),
            p["kind"],
            tuple(Fix(**f) for f in p.get("fixes", ())),
        )
        for p in d.get("products", ())
    )
    return Advisory(**{**d, "products": products})


class SynologyFeed:
    """Le lecteur : cache sur disque, lectures dues, une page toutes les deux secondes."""

    def __init__(
        self,
        folder: Path,
        fetch: Fetch | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        pause_s: float = PAGE_PAUSE_S,
    ):
        self.folder = folder
        # Sans lecteur donné, http_fetch, cherché à chaque lecture (les tests le remplacent).
        self._given = fetch
        self._clock = clock
        self._pause_s = pause_s
        self._feed: list[FeedItem] = []
        self._advisories: dict[str, Advisory] = {}
        self._models: dict[str, ModelStatus] = {}
        self._feed_read_at: datetime | None = None
        self._models_read_at: datetime | None = None
        self._failed_at: datetime | None = None
        self._error: str | None = None
        self._load()

    # Cache ---------------------------------------------------------------------------------

    def _load(self) -> None:
        """Le cache du disque ; illisible ou absent, on repart de rien."""
        try:
            data = json.loads((self.folder / "advisories.json").read_text())
            self._feed_read_at = _dt(data.get("feed_read_at"))
            self._feed = [FeedItem(**i) for i in data.get("feed", [])]
            if data.get("parser") == PARSER:
                self._advisories = {a["id"]: _advisory_from(a) for a in data.get("advisories", [])}
        except (OSError, ValueError, TypeError, KeyError):
            self._feed, self._advisories, self._feed_read_at = [], {}, None
        try:
            data = json.loads((self.folder / "models.json").read_text())
            self._models_read_at = _dt(data.get("read_at"))
            self._models = {m["model"]: ModelStatus(**m) for m in data.get("models", [])}
        except (OSError, ValueError, TypeError, KeyError):
            self._models, self._models_read_at = {}, None

    def _save(self, name: str, data: dict[str, Any]) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        tmp = self.folder / f".{name}.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
        os.replace(tmp, self.folder / name)

    def _save_advisories(self) -> None:
        self._save(
            "advisories.json",
            {
                "parser": PARSER,
                "feed_read_at": _iso(self._feed_read_at),
                "feed": [asdict(i) for i in self._feed],
                "advisories": [asdict(a) for a in self._advisories.values()],
            },
        )

    # Lectures ------------------------------------------------------------------------------

    async def _fetch(self, url: str) -> str:
        return await (self._given or http_fetch)(url)

    def snapshot(self) -> Snapshot:
        return Snapshot(
            advisories=sorted(self._advisories.values(), key=lambda a: a.id, reverse=True),
            models=dict(self._models),
            feed_read_at=_iso(self._feed_read_at),
            models_read_at=_iso(self._models_read_at),
            error=self._error,
        )

    def _due(self, last: datetime | None, every: timedelta) -> bool:
        now = self._clock()
        if self._failed_at is not None and now - self._failed_at < RETRY_AFTER:
            return False
        return last is None or now - last >= every

    def _wanted(self) -> list[FeedItem]:
        now = self._clock()
        wanted = []
        for item in self._feed:
            if int(item.id[12:14]) < FIRST_YEAR:
                continue
            known = self._advisories.get(item.id)
            read_at = _dt(known.read_at) if known else None
            if known is None or (
                known.needs_reread and (read_at is None or now - read_at >= ONGOING_EVERY)
            ):
                wanted.append(item)
        return wanted

    async def refresh(self) -> None:
        """Fait ce qui est dû : le flux, les pages nouvelles ou en cours, le statut des modèles."""
        try:
            if self._due(self._feed_read_at, FEED_EVERY):
                self._feed = parse_feed(await self._fetch(FEED_URL))
                self._feed_read_at = self._clock()
                self._save_advisories()
            for item in self._wanted():
                advisory = parse_advisory(await self._fetch(item.url), item)
                self._advisories[item.id] = replace(advisory, read_at=_iso(self._clock()))
                self._save_advisories()
                await asyncio.sleep(self._pause_s)
            if self._due(self._models_read_at, MODELS_EVERY):
                self._models = parse_models(await self._fetch(STATUS_URL))
                self._models_read_at = self._clock()
                self._save(
                    "models.json",
                    {
                        "read_at": _iso(self._models_read_at),
                        "models": [asdict(m) for m in self._models.values()],
                    },
                )
            self._error, self._failed_at = None, None
        except (FetchError, ValueError, ParseError) as exc:
            self._error = f"{type(exc).__name__}: {exc}"[:200]
            self._failed_at = self._clock()
            log.warning("Synology: %s", self._error)

    async def run(self, every_s: float = 600.0) -> None:
        while True:
            await self.refresh()
            await asyncio.sleep(every_s)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _dt(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    with _quiet():
        return datetime.fromisoformat(value)
    return None
