"""Les trois canaux : ntfy, webhook, courriel. Chacun envoie un `Message` ou lève NotifyError.

HTTP : aucune redirection suivie, 10 secondes au plus, réponse lue au plus 64 Kio (comme le
client du relais). Courriel : TLS toujours, certificat vérifié, jamais en clair.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import smtplib
import ssl
import time
from collections.abc import Awaitable, Callable, Mapping
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from urllib.parse import urlsplit, urlunsplit

import aiohttp

from nas_agent import __version__
from nas_agent.notify.messages import Message

TIMEOUT_S = 10
READ_MAX = 64 * 1024
USER_AGENT = f"nas-agent/{__version__}"

# ntfy : 5 « urgent », 4 « haute », 3 « normale » ; une étiquette par niveau.
NTFY_PRIORITY = {"critical": 5, "warning": 4, "recovered": 3, "notice": 3}
NTFY_TAGS = {
    "critical": "rotating_light",
    "warning": "warning",
    "recovered": "white_check_mark",
    "notice": "information_source",
}

HttpTransport = Callable[[str, str, Mapping[str, str], bytes], Awaitable[tuple[int, bytes]]]


class NotifyError(Exception):
    """Envoi refusé ou impossible ; `code` est court et sans contenu (il va au journal)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code[:40]


async def aiohttp_post(
    method: str, url: str, headers: Mapping[str, str], body: bytes
) -> tuple[int, bytes]:
    timeout = aiohttp.ClientTimeout(total=TIMEOUT_S)
    try:
        async with (
            aiohttp.ClientSession(timeout=timeout) as session,
            session.request(
                method, url, headers=dict(headers), data=body, allow_redirects=False
            ) as resp,
        ):
            data = await resp.content.read(READ_MAX)
            return resp.status, data
    except TimeoutError as exc:
        raise NotifyError("timeout") from exc
    except aiohttp.ClientError as exc:
        raise NotifyError(f"unreachable:{type(exc).__name__}") from exc


def _check(status: int) -> None:
    if not 200 <= status < 300:
        raise NotifyError(f"http_{status}")


class NtfyChannel:
    """Publication JSON à la racine du serveur, le sujet dans le corps : un titre en UTF-8
    n'a pas à passer par un en-tête HTTP."""

    name = "ntfy"

    def __init__(
        self, url: str, *, token: str | None = None, transport: HttpTransport | None = None
    ):
        parts = urlsplit(url)
        self.topic = parts.path.strip("/")
        self.root = urlunsplit((parts.scheme, parts.netloc, "/", "", ""))
        self.token = token
        self._transport = transport or aiohttp_post

    async def send(self, m: Message) -> None:
        body = {
            "topic": self.topic,
            "title": m.title,
            "message": m.body,
            "priority": NTFY_PRIORITY.get(m.level, 3),
            "tags": [NTFY_TAGS.get(m.level, "information_source")],
        }
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = json.dumps(body, ensure_ascii=False).encode()
        status, _ = await self._transport("POST", self.root, headers, data)
        _check(status)


class WebhookChannel:
    """Corps JSON `notify/1` ; avec un secret, signé sur « horodatage.corps » (HMAC-SHA256)."""

    name = "webhook"

    def __init__(
        self,
        url: str,
        *,
        secret: bytes | None = None,
        transport: HttpTransport | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.url = url
        self.secret = secret
        self._transport = transport or aiohttp_post
        self._clock = clock

    async def send(self, m: Message) -> None:
        body = json.dumps(m.payload, ensure_ascii=False, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        if self.secret:
            ts = int(self._clock())
            sig = hmac.new(self.secret, f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
            headers["X-Nas-Agent-Signature"] = f"t={ts},v1={sig}"
        status, _ = await self._transport("POST", self.url, headers, body)
        _check(status)


class EmailChannel:
    """SMTP en TLS implicite (`tls`, port 465) ou STARTTLS (`starttls`, port 587)."""

    name = "email"

    def __init__(
        self,
        *,
        host: str,
        port: int,
        security: str,
        sender: str,
        to: list[str],
        username: str | None = None,
        password: str | None = None,
        smtp: type = smtplib.SMTP,
        smtp_ssl: type = smtplib.SMTP_SSL,
    ):
        self.host, self.port, self.security = host, port, security
        self.sender, self.to = sender, list(to)
        self.username, self.password = username, password
        self._smtp, self._smtp_ssl = smtp, smtp_ssl

    def _message(self, m: Message) -> EmailMessage:
        msg = EmailMessage()
        msg["Subject"] = f"[{m.nas}] {m.summary}"
        msg["From"] = self.sender
        msg["To"] = ", ".join(self.to)
        msg["Date"] = format_datetime(m.at)
        msg["Message-ID"] = make_msgid(domain=self.sender.rpartition("@")[2] or None)
        msg.set_content(m.body)
        return msg

    def _send_sync(self, m: Message) -> None:
        context = ssl.create_default_context()
        try:
            if self.security == "tls":
                client = self._smtp_ssl(self.host, self.port, timeout=TIMEOUT_S, context=context)
            else:
                client = self._smtp(self.host, self.port, timeout=TIMEOUT_S)
                client.starttls(context=context)
            try:
                if self.username:
                    client.login(self.username, self.password or "")
                client.send_message(self._message(m))
            finally:
                client.quit()
        except smtplib.SMTPAuthenticationError as exc:
            raise NotifyError("smtp_auth") from exc
        except smtplib.SMTPException as exc:
            raise NotifyError(f"smtp:{type(exc).__name__}") from exc
        except (OSError, ssl.SSLError) as exc:
            raise NotifyError(f"unreachable:{type(exc).__name__}") from exc

    async def send(self, m: Message) -> None:
        await asyncio.to_thread(self._send_sync, m)
