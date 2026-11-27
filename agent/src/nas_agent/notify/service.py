"""La boucle des alertes du moteur : un tour par minute, sur l'état du module relay.

Mémoire propre (`notify` dans agent.db) : ne dépend pas de l'inscription au relais. Un message
par tour et par canal ; ce qui ne part pas attend dans la file du canal (QUEUE_MAX), dans
l'ordre, et repart au tour suivant ; au-delà de MAX_AGE, abandonné et noté.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from nas_agent.audit import AuditLog, Channel
from nas_agent.config import ConfigError, Settings
from nas_agent.i18n import Lang
from nas_agent.notify import channels as ch
from nas_agent.notify.messages import Message, compose, trial_message
from nas_agent.relay import alerts as alert_rules
from nas_agent.relay.state import BuiltState
from nas_agent.relay.store import RelayStore

log = logging.getLogger(__name__)

CYCLE_S = 60
QUEUE_MAX = 20
MAX_AGE = timedelta(hours=24)
MEMORY_KEY = "notify"
QUEUE_KEY = "notify_queue"
# Dernier nom connu du NAS : DSM muet, l'état n'en a plus, l'alerte le garde.
NAME_KEY = "notify_nas_name"


class Sender(Protocol):
    name: str

    async def send(self, m: Message) -> None: ...


def _secret(settings: Settings, path: Path | None) -> str | None:
    if path is None:
        return None
    full = path if path.is_absolute() else settings.data_dir / path
    try:
        value = full.read_text().strip()
    except OSError as exc:
        raise ConfigError(f"[notify] : fichier secret illisible : {path}") from exc
    if not value:
        raise ConfigError(f"[notify] : fichier secret vide : {path}")
    return value


def build_channels(settings: Settings) -> list[Sender]:
    """Les canaux réglés, dans l'ordre ntfy, courriel, webhook ; secrets lus dans leurs fichiers."""
    n = settings.notify
    out: list[Sender] = []
    if n.ntfy is not None:
        out.append(ch.NtfyChannel(n.ntfy.url, token=_secret(settings, n.ntfy.token_file)))
    if n.email is not None:
        e = n.email
        out.append(
            ch.EmailChannel(
                host=e.host,
                port=e.port,
                security=e.security,
                sender=e.sender,
                to=e.to,
                username=e.username,
                password=_secret(settings, e.password_file),
            )
        )
    if n.webhook is not None:
        secret = _secret(settings, n.webhook.secret_file)
        out.append(ch.WebhookChannel(n.webhook.url, secret=secret.encode() if secret else None))
    return out


class NotifyService:
    def __init__(
        self,
        store: RelayStore,
        audit: AuditLog,
        state_source: Callable[[], Awaitable[BuiltState]],
        channels: list[Sender],
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        lang: Lang = "en",
    ):
        self.store = store
        self._audit = audit
        self._source = state_source
        self.lang = lang
        self.channels = channels
        self._clock = clock

    # Boucle -----------------------------------------------------------------------------------

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # dernier filet : la boucle ne s'arrête jamais sur une erreur
                log.exception("Alertes : tour impossible")
            await asyncio.sleep(CYCLE_S)

    async def tick(self) -> None:
        now = self._clock()
        built = await self._source()
        memory = alert_rules.Memory.load(self.store.get(MEMORY_KEY))
        events = alert_rules.detect(built, memory, now, self.lang)
        self.store.set(MEMORY_KEY, memory.dump())
        name = built.content.get("nas", {}).get("name")
        if name:
            if self.store.get(NAME_KEY) != name:
                self.store.set(NAME_KEY, name)
        else:
            name = self.store.get(NAME_KEY)
        message = compose(events, name, now, self.lang)
        queues = self._queues()
        if message is not None:
            for c in self.channels:
                queue = queues.setdefault(c.name, [])
                queue.append(message.dump())
                del queue[:-QUEUE_MAX]
        await self._flush(queues, now)

    def _queues(self) -> dict[str, list[dict[str, Any]]]:
        raw = self.store.get(QUEUE_KEY) or {}
        return {c.name: list(raw.get(c.name) or []) for c in self.channels}

    async def _flush(self, queues: dict[str, list[dict[str, Any]]], now: datetime) -> None:
        for c in self.channels:
            queue = queues.get(c.name, [])
            while queue:
                m = Message.load(queue[0])
                if now - m.at > MAX_AGE:
                    queue.pop(0)
                    self._journal(
                        "notify.drop", "error", code="expired", params={"channel": c.name}
                    )
                    continue
                try:
                    await c.send(m)
                except ch.NotifyError as exc:
                    self._journal("notify.send", "error", code=c.name, params={"error": exc.code})
                    log.warning("Alertes : %s refuse l'envoi (%s)", c.name, exc.code)
                    break
                except Exception:
                    self._journal(
                        "notify.send", "error", code=c.name, params={"error": "unexpected"}
                    )
                    log.exception("Alerts: sending failed on %s", c.name)
                    break
                queue.pop(0)
                self._journal("notify.send", "ok", code=c.name, params={"level": m.level})
        self.store.set(QUEUE_KEY, queues)

    # Essai et état ----------------------------------------------------------------------------

    async def test(self, only: str | None = None, nas_name: str | None = None) -> dict[str, str]:
        """Un message d'essai sur chaque canal (ou le seul `only`) : « ok » ou le code d'erreur."""
        m = trial_message(nas_name, self._clock(), self.lang)
        out: dict[str, str] = {}
        for c in self.channels:
            if only is not None and c.name != only:
                continue
            try:
                await c.send(m)
                out[c.name] = "ok"
            except ch.NotifyError as exc:
                out[c.name] = exc.code
            self._journal("notify.test", "ok" if out[c.name] == "ok" else "error", code=c.name)
        return out

    def status(self) -> dict[str, Any]:
        queues = self._queues()
        return {
            "channels": [c.name for c in self.channels],
            "queues": {c.name: len(queues.get(c.name, [])) for c in self.channels},
        }

    def _journal(self, op: str, outcome, channel: Channel = "internal", **fields) -> None:
        try:
            self._audit.record(
                channel=channel, op=op, token_id=None, client_ip=None, outcome=outcome, **fields
            )
        except Exception:  # base verrouillée ou pleine : le module continue
            log.exception("Cannot write the call log (alerts)")
