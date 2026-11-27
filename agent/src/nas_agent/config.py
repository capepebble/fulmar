"""Configuration de l'agent : fichier TOML, surchargé par les variables NAS_AGENT_*."""

from __future__ import annotations

import ipaddress
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

TlsMode = Literal["hostname", "pin"]

DEFAULT_DATA_DIR = Path("/data")


class ConfigError(ValueError):
    """Configuration invalide ou dangereuse."""


@dataclass(frozen=True)
class DsmSettings:
    host: str
    port: int = 5001
    https: bool = True
    tls_mode: TlsMode = "pin"
    tls_server_name: str | None = None
    tls_fingerprint: str | None = None
    timeout: float = 10.0


@dataclass(frozen=True)
class Limits:
    calls_per_minute: int = 60
    dsm_concurrency: int = 2
    auth_failures: int = 10
    auth_window_s: int = 300
    lockout_s: int = 900


@dataclass(frozen=True)
class AuditThresholds:
    """Seuils des contrôles d'audit (section [audit]), réglables NAS par NAS."""

    volume_warning_pct: int = 80
    volume_failure_pct: int = 90
    certificate_min_days: int = 30
    # Sans planning lisible, une tâche doit avoir réussi depuis moins de ce délai.
    backup_max_age_hours: int = 26
    integrity_max_age_days: int = 35
    advisor_max_age_days: int = 30
    # Ajouts du 2026-11-26 (conception 2026-11-26-meilleur-produit, section 3.7).
    cpu_warning_pct: int = 90
    memory_warning_pct: int = 90
    disk_temperature_warning_c: int = 50
    disk_temperature_failure_c: int = 60
    system_temperature_warning_c: int = 70
    unreachable_minutes: int = 5
    scrubbing_max_age_days: int = 180
    password_min_length: int = 10
    login_failures_warning: int = 10
    login_burst: int = 20
    mass_change_count: int = 200
    # Active Backup for Business (section 3.8) : un poste éteint ou en voyage attend plus.
    pc_backup_max_age_days: int = 7


@dataclass(frozen=True)
class SynologySettings:
    """Lecture des avis de sécurité et du statut des modèles sur www.synology.com (section
    [synology], conception 2026-11-26-failles-fin-de-vie) ; active par défaut."""

    enabled: bool = True


@dataclass(frozen=True)
class HistorySettings:
    """Relevé des constantes chaque minute (section [history]) ; actif par défaut."""

    enabled: bool = True


@dataclass(frozen=True)
class RelaySettings:
    """Module relay (section [relay]) : sans `url`, aucun dépôt, la lecture directe seule.

    `direct_urls` : adresses de base de l'agent écrites dans le QR code pour la lecture
    directe ; par défaut, https:// suivi de chaque nom public. `clear_notifications` : joindre
    au dépôt d'une alerte un texte en clair pour la notification (désactivé par défaut).
    """

    url: str | None = None
    direct_urls: list[str] | None = None
    clear_notifications: bool = False


@dataclass(frozen=True)
class NtfySettings:
    """`url` : le sujet (https://ntfy.sh/un-sujet-long) ; `token_file` : jeton d'accès ntfy."""

    url: str
    token_file: Path | None = None


@dataclass(frozen=True)
class EmailSettings:
    """SMTP : `security` vaut « tls » (port 465) ou « starttls » (port 587), jamais en clair."""

    host: str
    sender: str
    to: list[str]
    port: int = 587
    security: str = "starttls"
    username: str | None = None
    password_file: Path | None = None


@dataclass(frozen=True)
class WebhookSettings:
    """`secret_file` : clé qui signe chaque envoi (en-tête X-Nas-Agent-Signature)."""

    url: str
    secret_file: Path | None = None


@dataclass(frozen=True)
class NotifySettings:
    """Alertes du moteur (section [notify], conception 4.11) : un canal de chaque au plus."""

    ntfy: NtfySettings | None = None
    email: EmailSettings | None = None
    webhook: WebhookSettings | None = None

    @property
    def configured(self) -> bool:
        return any((self.ntfy, self.email, self.webhook))


@dataclass(frozen=True)
class Settings:
    dsm: DsmSettings
    data_dir: Path = DEFAULT_DATA_DIR
    bind_host: str = "127.0.0.1"
    bind_port: int = 8765
    allow_non_loopback: bool = False
    public_hosts: list[str] = field(default_factory=list)
    # Seuls ces mandataires (tailscale serve, même espace réseau) font foi pour X-Forwarded-For.
    trusted_proxies: list[str] = field(default_factory=lambda: ["127.0.0.1", "127.0.0.2", "::1"])
    limits: Limits = field(default_factory=Limits)
    audit: AuditThresholds = field(default_factory=AuditThresholds)
    history: HistorySettings = field(default_factory=HistorySettings)
    synology: SynologySettings = field(default_factory=SynologySettings)
    relay: RelaySettings = field(default_factory=RelaySettings)
    notify: NotifySettings = field(default_factory=NotifySettings)
    # Projet du moteur (conception 2026-11-25) : jeton de la console tenu à jour à chaque
    # démarrage, limité au réseau du projet.
    console_token_file: Path | None = None
    console_cidrs: list[str] = field(default_factory=list)
    # Langue des textes de l'agent quand la requête n'en demande pas (MCP, alertes, relais).
    language: str = "en"
    # NAS ajoutés au hub au plus (conception 2026-11-26) : une protection de la mémoire du hub,
    # pas une limite du produit ; 0 ferme l'ajout.
    fleet_max: int = 50

    @property
    def db_path(self) -> Path:
        return self.data_dir / "agent.db"

    @property
    def history_path(self) -> Path:
        return self.data_dir / "history.db"

    @property
    def credentials_path(self) -> Path:
        return self.data_dir / "secrets" / "dsm.json"

    @property
    def relay_path(self) -> Path:
        """Clés de l'agent pour le relais et la lecture directe (mode 600)."""
        return self.data_dir / "relay.json"

    @property
    def direct_urls(self) -> list[str]:
        if self.relay.direct_urls is not None:
            return list(self.relay.direct_urls)
        return [f"https://{host}" for host in self.public_hosts]


# Variable d'environnement -> (section, clé, type)
_ENV: dict[str, tuple[str | None, str, type]] = {
    "NAS_AGENT_DATA_DIR": (None, "data_dir", Path),
    "NAS_AGENT_BIND_HOST": (None, "bind_host", str),
    "NAS_AGENT_BIND_PORT": (None, "bind_port", int),
    "NAS_AGENT_PUBLIC_HOSTS": (None, "public_hosts", list),
    "NAS_AGENT_DSM_HOST": ("dsm", "host", str),
    "NAS_AGENT_DSM_PORT": ("dsm", "port", int),
    "NAS_AGENT_DSM_TLS_MODE": ("dsm", "tls_mode", str),
    "NAS_AGENT_DSM_TLS_SERVER_NAME": ("dsm", "tls_server_name", str),
    "NAS_AGENT_DSM_TLS_FINGERPRINT": ("dsm", "tls_fingerprint", str),
    "NAS_AGENT_RELAY_URL": ("relay", "url", str),
    "NAS_AGENT_ALLOW_NON_LOOPBACK": (None, "allow_non_loopback", bool),
    "NAS_AGENT_CONSOLE_TOKEN_FILE": (None, "console_token_file", Path),
    "NAS_AGENT_CONSOLE_CIDR": (None, "console_cidrs", list),
    "NAS_AGENT_LANGUAGE": (None, "language", str),
    "NAS_AGENT_FLEET_MAX": (None, "fleet_max", int),
}


def _convert(value: str, kind: type) -> Any:
    if kind is bool:
        return value.strip().lower() in ("1", "true", "yes", "oui")
    if kind is list:
        return [item.strip() for item in value.split(",") if item.strip()]
    return kind(value)


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_fingerprint(value: str) -> str:
    """« AB:CD:… » ou « abcd… » -> 64 caractères hexadécimaux en minuscules."""
    fp = value.replace(":", "").replace(" ", "").lower()
    if len(fp) != 64 or any(c not in "0123456789abcdef" for c in fp):
        raise ConfigError("tls_fingerprint must be a SHA-256 fingerprint (64 hex characters).")
    return fp


def load_settings(path: Path | None, env: Mapping[str, str]) -> Settings:
    raw: dict[str, Any] = {}
    if path is not None and path.exists():
        raw = tomllib.loads(path.read_text())
    top = {k: v for k, v in raw.items() if not isinstance(v, dict)}
    dsm = dict(raw.get("dsm", {}))
    limits = dict(raw.get("limits", {}))
    audit = dict(raw.get("audit", {}))
    history = dict(raw.get("history", {}))
    synology = dict(raw.get("synology", {}))
    relay = dict(raw.get("relay", {}))
    notify = _notify(dict(raw.get("notify", {})))

    for name, (section, key, kind) in _ENV.items():
        if name in env:
            target = {"dsm": dsm, "relay": relay}.get(section or "", top)
            target[key] = _convert(env[name], kind)
    if not relay.get("url"):
        # Variable vide ou absente : pas de relais.
        relay.pop("url", None)

    for key in ("data_dir", "console_token_file"):
        if key in top:
            top[key] = Path(top[key])
    if dsm.get("tls_fingerprint"):
        dsm["tls_fingerprint"] = normalize_fingerprint(dsm["tls_fingerprint"])
    if "host" not in dsm:
        raise ConfigError("DSM host missing ([dsm] host or NAS_AGENT_DSM_HOST).")

    try:
        settings = Settings(
            dsm=DsmSettings(**dsm),
            limits=Limits(**limits),
            audit=AuditThresholds(**audit),
            history=HistorySettings(**history),
            synology=SynologySettings(**synology),
            relay=RelaySettings(**relay),
            notify=notify,
            **top,
        )
    except TypeError as exc:
        raise ConfigError(f"Unknown configuration key: {exc}") from exc

    _validate(settings)
    return settings


def _notify(raw: dict[str, Any]) -> NotifySettings:
    unknown = set(raw) - {"ntfy", "email", "webhook"}
    if unknown:
        raise ConfigError(f"[notify] : canal inconnu : {', '.join(sorted(unknown))}.")
    try:
        ntfy = webhook = email = None
        if "ntfy" in raw:
            n = dict(raw["ntfy"])
            if "token_file" in n:
                n["token_file"] = Path(n["token_file"])
            ntfy = NtfySettings(**n)
        if "webhook" in raw:
            w = dict(raw["webhook"])
            if "secret_file" in w:
                w["secret_file"] = Path(w["secret_file"])
            webhook = WebhookSettings(**w)
        if "email" in raw:
            e = dict(raw["email"])
            if "password" in e:
                raise ConfigError(
                    "[notify.email]: the password is read from a file (password_file), never from "
                    "the configuration."
                )
            if "from" in e:
                e["sender"] = e.pop("from")
            if "password_file" in e:
                e["password_file"] = Path(e["password_file"])
            email = EmailSettings(**e)
    except TypeError as exc:
        raise ConfigError(f"[notify]: unknown or missing setting: {exc}") from exc
    return NotifySettings(ntfy=ntfy, email=email, webhook=webhook)


def _validate_notify(n: NotifySettings) -> None:
    from nas_agent.relay.encoding import url_allowed

    for name, channel in (("ntfy", n.ntfy), ("webhook", n.webhook)):
        if channel is None:
            continue
        # Les mêmes règles que les adresses directes : https, ou http vers une adresse privée.
        if len(channel.url) > 500 or not url_allowed(channel.url, private=True):
            raise ConfigError(f"[notify.{name}] url: https, or http to a private address only.")
    if n.ntfy is not None and not urlsplit(n.ntfy.url).path.strip("/"):
        raise ConfigError("[notify.ntfy] url: the topic is missing (https://ntfy.sh/<topic>).")
    e = n.email
    if e is not None:
        if e.security not in ("tls", "starttls"):
            raise ConfigError('[notify.email] security: "tls" or "starttls", never plain text.')
        if not e.host or not 0 < e.port < 65536:
            raise ConfigError("[notify.email]: SMTP host and port required.")
        if not e.to or not all("@" in a for a in e.to) or "@" not in e.sender:
            raise ConfigError('[notify.email]: "from" and at least one address in "to".')
        if e.username and e.password_file is None:
            raise ConfigError("[notify.email]: with username, password_file is required.")


def _validate(s: Settings) -> None:
    from nas_agent.i18n import LANGS

    if s.language not in LANGS:
        raise ConfigError(f"language: {' or '.join(LANGS)}, not '{s.language[:20]}'.")
    if not 0 <= s.fleet_max <= 1000:
        raise ConfigError("fleet_max: between 0 and 1000.")
    _validate_notify(s.notify)
    if not _is_loopback(s.bind_host) and not s.allow_non_loopback:
        raise ConfigError(
            f"The agent must listen on 127.0.0.1; {s.bind_host} requires allow_non_loopback = true."
        )
    if s.dsm.tls_mode not in ("hostname", "pin"):
        raise ConfigError('tls_mode must be "hostname" or "pin": TLS is always verified.')
    if s.dsm.tls_mode == "pin" and not s.dsm.tls_fingerprint:
        raise ConfigError(
            'The "pin" mode requires tls_fingerprint (SHA-256 of DSM\'s certificate).'
        )
    if s.dsm.tls_mode == "hostname" and not s.dsm.tls_server_name:
        raise ConfigError(
            'The "hostname" mode requires tls_server_name (name on DSM\'s certificate).'
        )
    if not s.dsm.https:
        raise ConfigError("DSM is reached over HTTPS only.")
    a = s.audit
    if not 0 < a.volume_warning_pct < a.volume_failure_pct <= 100:
        raise ConfigError("[audit]: 0 < volume_warning_pct < volume_failure_pct <= 100.")
    days = (a.certificate_min_days, a.backup_max_age_hours, a.integrity_max_age_days)
    if min(*days, a.advisor_max_age_days) < 1:
        raise ConfigError("[audit]: delays are at least 1.")
    if not (0 < a.cpu_warning_pct <= 100 and 0 < a.memory_warning_pct <= 100):
        raise ConfigError("[audit]: cpu_warning_pct and memory_warning_pct within 1..100.")
    if not 0 < a.disk_temperature_warning_c < a.disk_temperature_failure_c <= 100:
        raise ConfigError(
            "[audit]: 0 < disk_temperature_warning_c < disk_temperature_failure_c <= 100."
        )
    counts = (
        a.system_temperature_warning_c,
        a.unreachable_minutes,
        a.scrubbing_max_age_days,
        a.password_min_length,
        a.login_failures_warning,
        a.login_burst,
        a.mass_change_count,
        a.pc_backup_max_age_days,
    )
    if min(counts) < 1:
        raise ConfigError("[audit]: thresholds are at least 1.")
    if s.relay.url is not None:
        check_relay_url(s.relay.url)
    from nas_agent.relay.encoding import url_allowed

    for url in s.direct_urls:
        # Les règles de l'appli (protocole, section 6.2) : https, ou http vers une adresse
        # privée ou la boucle locale ; une autre adresse serait refusée au scan du QR code.
        if len(url) > 200 or not url_allowed(url, private=True):
            raise ConfigError(f"[relay] direct_urls: address the app would refuse: {url[:60]}")


def check_relay_url(url: str) -> str:
    """Le relais se joint en HTTPS ; HTTP seulement sur la boucle locale (développement)."""
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if parsed.scheme == "https" and host:
        return url.rstrip("/")
    if parsed.scheme == "http" and _is_loopback(host):
        return url.rstrip("/")
    raise ConfigError("[relay] url: the relay is reached over HTTPS (HTTP on the loopback only).")
