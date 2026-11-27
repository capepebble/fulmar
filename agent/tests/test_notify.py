"""Alertes du moteur : courriel, ntfy, webhook (conception, section 4.11)."""

from __future__ import annotations

import functools
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar

import pytest

from nas_agent.audit import AuditLog
from nas_agent.config import ConfigError, load_settings
from nas_agent.db import open_db
from nas_agent.notify import channels as ch
from nas_agent.notify import messages
from nas_agent.notify.service import QUEUE_MAX, NotifyService, build_channels
from nas_agent.relay.state import BuiltState
from nas_agent.relay.store import RelayStore

# Ces tests lisent les messages en français ; l'anglais, langue par défaut, a les siens.
compose = functools.partial(messages.compose, lang="fr")
trial_message = functools.partial(messages.trial_message, lang="fr")

T0 = datetime(2026, 11, 24, 8, 0, tzinfo=UTC)
DSM = '[dsm]\nhost = "127.0.0.1"\ntls_mode = "hostname"\ntls_server_name = "nas.local"\n'


def built(checks: dict[str, str], backups: dict[str, tuple[bool, str]] | None = None) -> BuiltState:
    return BuiltState(
        content={
            "nas": {"name": "Atelier"},
            "checks": [{"id": k, "advice": f"Conseil {k}"} for k in checks],
        },
        digest="x",
        checks={k: (v, f"Titre {k}", f"Lu {k}") for k, v in checks.items()},
        backups={
            k: {
                "name": f"Tâche {k}",
                "failed": f,
                "run": r,
                "error": "Destination pleine" if f else None,
            }
            for k, (f, r) in (backups or {}).items()
        },
    )


def event(to: str, level: str, *, ring: bool = True, kind: str = "check", key: str = "a") -> dict:
    return {
        "key": f"{kind}:{key}",
        "kind": kind,
        "id": key,
        "title": f"Titre {key}",
        "from": "ok" if to != "ok" else "failed",
        "to": to,
        "level": level,
        "ring": ring,
        "observed": f"Lu {key}",
        "advice": f"Conseil {key}" if to != "ok" else None,
    }


# Les textes ------------------------------------------------------------------------------------


def test_compose_one_event_names_the_nas_and_the_check():
    m = compose([event("failed", "critical")], "Atelier", T0)
    assert m is not None
    assert m.level == "critical"
    assert m.summary == "Titre a"
    assert m.title == "Atelier : Titre a"
    assert m.body == "En échec : Titre a\nLu a\nÀ faire : Conseil a"
    assert m.payload["schema"] == "notify/1"
    assert m.payload["nas_name"] == "Atelier"
    assert m.payload["level"] == "critical"
    assert m.payload["events"][0]["id"] == "a"
    assert "ring" not in m.payload["events"][0]


def test_compose_keeps_only_ringing_events_and_says_how_many():
    events = [
        event("failed", "critical", key="a"),
        event("warning", "warning", key="b"),
        event("ok", "recovered", key="c"),
        event("failed", "critical", key="d", ring=False),
    ]
    m = compose(events, "Atelier", T0)
    assert m is not None
    assert m.summary == "3 alertes, dont 1 grave"
    assert m.level == "critical"
    assert [e["id"] for e in m.payload["events"]] == ["a", "b", "c"]
    assert "À surveiller : Titre b" in m.body
    assert "Rétabli : Titre c" in m.body
    assert compose([event("failed", "critical", ring=False)], "Atelier", T0) is None


def test_compose_a_failed_backup_carries_its_error():
    e = {
        "key": "backup:7",
        "kind": "backup",
        "id": "7",
        "title": "Sauvegarde en échec : Nuit",
        "from": "ok",
        "to": "failed",
        "level": "critical",
        "ring": True,
        "error": "Destination pleine",
    }
    m = compose([e], None, T0)
    assert m is not None
    assert m.title == "NAS : Sauvegarde en échec : Nuit"
    assert m.body == "En échec : Sauvegarde en échec : Nuit\nDestination pleine"


def test_long_texts_are_cut():
    e = event("failed", "critical")
    e["observed"] = "x" * 1000
    m = compose([e], "Atelier", T0)
    assert m is not None
    assert len(m.payload["events"][0]["observed"]) == 280


# Les canaux ------------------------------------------------------------------------------------


class FakeHttp:
    def __init__(self, status: int = 200):
        self.status = status
        self.calls: list[tuple[str, str, dict, bytes]] = []

    async def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        return self.status, b"{}"


async def test_ntfy_publishes_json_to_the_server_root_with_priority_and_token():
    http = FakeHttp()
    channel = ch.NtfyChannel("https://ntfy.example.org/mon-sujet", token="tk_abc", transport=http)
    await channel.send(compose([event("failed", "critical")], "Atelier", T0))
    method, url, headers, body = http.calls[0]
    assert (method, url) == ("POST", "https://ntfy.example.org/")
    assert headers["Authorization"] == "Bearer tk_abc"
    assert headers["Content-Type"] == "application/json"
    sent = json.loads(body)
    assert sent["topic"] == "mon-sujet"
    assert sent["title"] == "Atelier : Titre a"
    assert sent["priority"] == 5
    assert sent["tags"] == ["rotating_light"]
    assert sent["message"].startswith("En échec : Titre a")


async def test_ntfy_priorities_follow_the_level():
    http = FakeHttp()
    channel = ch.NtfyChannel("https://ntfy.sh/s", transport=http)
    await channel.send(compose([event("warning", "warning")], "A", T0))
    await channel.send(compose([event("ok", "recovered")], "A", T0))
    prios = [json.loads(c[3])["priority"] for c in http.calls]
    assert prios == [4, 3]
    assert "Authorization" not in http.calls[0][2]


async def test_a_refused_send_raises_with_the_status():
    channel = ch.NtfyChannel("https://ntfy.sh/s", transport=FakeHttp(status=403))
    with pytest.raises(ch.NotifyError) as err:
        await channel.send(compose([event("failed", "critical")], "A", T0))
    assert err.value.code == "http_403"


async def test_webhook_posts_the_payload_signed_with_a_timestamp():
    http = FakeHttp()
    channel = ch.WebhookChannel(
        "https://hooks.example.org/nas",
        secret=b"s3cret",
        transport=http,
        clock=lambda: 1_795_000_000,
    )
    m = compose([event("failed", "critical")], "Atelier", T0)
    await channel.send(m)
    method, url, headers, body = http.calls[0]
    assert (method, url) == ("POST", "https://hooks.example.org/nas")
    assert json.loads(body) == m.payload
    expected = hmac.new(b"s3cret", b"1795000000." + body, hashlib.sha256).hexdigest()
    assert headers["X-Nas-Agent-Signature"] == f"t=1795000000,v1={expected}"


async def test_webhook_without_secret_is_unsigned():
    http = FakeHttp()
    await ch.WebhookChannel("http://192.168.1.20:8080/x", transport=http).send(
        compose([event("failed", "critical")], "A", T0)
    )
    assert "X-Nas-Agent-Signature" not in http.calls[0][2]


class FakeSmtp:
    instances: ClassVar[list[FakeSmtp]] = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.timeout, self.context = host, port, timeout, context
        self.calls: list[tuple] = []
        FakeSmtp.instances.append(self)

    def starttls(self, context=None):
        self.calls.append(("starttls", context is not None))

    def login(self, user, password):
        self.calls.append(("login", user, password))

    def send_message(self, msg):
        self.calls.append(("send", msg))

    def quit(self):
        self.calls.append(("quit",))


async def test_email_starttls_login_and_plain_text():
    FakeSmtp.instances.clear()
    channel = ch.EmailChannel(
        host="smtp.example.org",
        port=587,
        security="starttls",
        sender="nas@example.org",
        to=["ops@example.org", "moi@example.org"],
        username="nas@example.org",
        password="mot-de-passe",
        smtp=FakeSmtp,
        smtp_ssl=FakeSmtp,
    )
    await channel.send(compose([event("failed", "critical")], "Atelier", T0))
    smtp = FakeSmtp.instances[0]
    assert (smtp.host, smtp.port, smtp.timeout) == ("smtp.example.org", 587, 10)
    assert smtp.calls[0] == ("starttls", True)
    assert smtp.calls[1] == ("login", "nas@example.org", "mot-de-passe")
    msg = smtp.calls[2][1]
    assert msg["Subject"] == "[Atelier] Titre a"
    assert msg["From"] == "nas@example.org"
    assert msg["To"] == "ops@example.org, moi@example.org"
    assert msg.get_content().startswith("En échec : Titre a")
    assert smtp.calls[-1] == ("quit",)


async def test_email_implicit_tls_uses_the_ssl_client_with_a_verifying_context():
    FakeSmtp.instances.clear()

    class FakeSsl(FakeSmtp):
        pass

    channel = ch.EmailChannel(
        host="smtp.example.org",
        port=465,
        security="tls",
        sender="a@b.c",
        to=["d@e.f"],
        smtp=FakeSmtp,
        smtp_ssl=FakeSsl,
    )
    await channel.send(compose([event("failed", "critical")], "A", T0))
    smtp = FakeSmtp.instances[0]
    assert isinstance(smtp, FakeSsl)
    assert smtp.context is not None
    assert not any(c[0] in ("starttls", "login") for c in smtp.calls)


# La boucle -------------------------------------------------------------------------------------


class Source:
    def __init__(self, state: BuiltState):
        self.state = state

    async def __call__(self) -> BuiltState:
        return self.state


class Recorder:
    def __init__(self, name: str, fail: bool = False):
        self.name = name
        self.fail = fail
        self.sent: list = []

    async def send(self, m):
        if self.fail:
            raise ch.NotifyError("http_500")
        self.sent.append(m)


@pytest.fixture
def parts(tmp_path: Path):
    conn = open_db(tmp_path / "agent.db")
    now = {"t": T0}
    audit = AuditLog(conn, clock=lambda: now["t"])
    return conn, audit, now


def service(parts, source, channels):
    conn, audit, now = parts
    return NotifyService(
        RelayStore(conn), audit, source, channels, clock=lambda: now["t"], lang="fr"
    )


def journal(conn, op: str) -> list[tuple[str, str | None]]:
    rows = conn.execute(
        "SELECT outcome, code FROM audit WHERE op = ? ORDER BY seq", (op,)
    ).fetchall()
    return [(r["outcome"], r["code"]) for r in rows]


async def test_first_tick_is_a_baseline_then_a_change_sends_one_message_per_channel(parts):
    conn, _, now = parts
    source = Source(built({"a": "ok", "b": "ok"}))
    ntfy, mail = Recorder("ntfy"), Recorder("email")
    svc = service(parts, source, [ntfy, mail])
    await svc.tick()
    assert ntfy.sent == [] and mail.sent == []

    source.state = built({"a": "failed", "b": "warning"})
    now["t"] = T0 + timedelta(minutes=1)
    await svc.tick()
    assert len(ntfy.sent) == 1 and len(mail.sent) == 1
    assert ntfy.sent[0].summary == "2 alertes, dont 1 grave"
    assert journal(conn, "notify.send") == [("ok", "ntfy"), ("ok", "email")]

    # Rien de neuf : rien ne part.
    now["t"] = T0 + timedelta(minutes=2)
    await svc.tick()
    assert len(ntfy.sent) == 1


async def test_a_failed_channel_keeps_its_message_and_retries_without_blocking_the_others(parts):
    conn, _, now = parts
    source = Source(built({"a": "ok"}))
    broken, ok = Recorder("webhook", fail=True), Recorder("ntfy")
    svc = service(parts, source, [broken, ok])
    await svc.tick()
    source.state = built({"a": "failed"})
    now["t"] = T0 + timedelta(minutes=1)
    await svc.tick()
    assert len(ok.sent) == 1
    assert svc.status()["queues"] == {"webhook": 1, "ntfy": 0}

    broken.fail = False
    now["t"] = T0 + timedelta(minutes=2)
    await svc.tick()
    assert len(broken.sent) == 1
    assert broken.sent[0].title == "Atelier : Titre a"
    assert svc.status()["queues"] == {"webhook": 0, "ntfy": 0}
    assert ("error", "webhook") in journal(conn, "notify.send")


async def test_queue_is_capped_and_old_messages_are_dropped(parts):
    conn, _, now = parts
    source = Source(built({"a": "ok"}))
    broken = Recorder("ntfy", fail=True)
    svc = service(parts, source, [broken])
    await svc.tick()
    for i in range(QUEUE_MAX + 5):
        source.state = built({"a": "failed" if i % 2 == 0 else "ok"})
        now["t"] = T0 + timedelta(minutes=31 * (i + 1))
        await svc.tick()
    assert svc.status()["queues"]["ntfy"] == QUEUE_MAX

    now["t"] += timedelta(hours=25)
    source.state = built({"a": "ok" if (QUEUE_MAX + 5) % 2 == 0 else "failed"})
    broken.fail = False
    await svc.tick()
    # Tout ce qui attendait depuis plus de 24 heures est abandonné, et noté.
    assert ("error", "expired") in journal(conn, "notify.drop")


async def test_the_test_message_goes_to_each_channel_and_reports(parts):
    svc = service(parts, Source(built({})), [Recorder("ntfy"), Recorder("email", fail=True)])
    result = await svc.test()
    assert result == {"ntfy": "ok", "email": "http_500"}
    only = await svc.test("ntfy")
    assert only == {"ntfy": "ok"}


def test_the_test_message_says_it_is_a_test():
    m = trial_message("Atelier", T0)
    assert m.title == "Atelier : message d'essai"
    assert "essai" in m.body
    assert m.level == "notice"


# Les réglages ----------------------------------------------------------------------------------


def write(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "config.toml"
    p.write_text(DSM + text)
    return p


def test_settings_read_the_three_channels(tmp_path: Path):
    p = write(
        tmp_path,
        '[notify.ntfy]\nurl = "https://ntfy.sh/sujet-long"\ntoken_file = "secrets/ntfy"\n'
        '[notify.email]\nhost = "smtp.example.org"\nfrom = "nas@example.org"\nto = ["a@b.c"]\n'
        'username = "nas@example.org"\npassword_file = "secrets/smtp"\n'
        '[notify.webhook]\nurl = "https://hooks.example.org/x"\nsecret_file = "secrets/hook"\n',
    )
    s = load_settings(p, {"NAS_AGENT_DATA_DIR": str(tmp_path)})
    assert s.notify.ntfy is not None and s.notify.ntfy.url == "https://ntfy.sh/sujet-long"
    assert s.notify.email is not None
    assert (s.notify.email.port, s.notify.email.security, s.notify.email.sender) == (
        587,
        "starttls",
        "nas@example.org",
    )
    assert s.notify.webhook is not None and s.notify.webhook.secret_file == Path("secrets/hook")


@pytest.mark.parametrize(
    "text",
    [
        '[notify.ntfy]\nurl = "http://ntfy.example.org/s"\n',  # http public
        '[notify.webhook]\nurl = "ftp://x/y"\n',
        '[notify.ntfy]\nurl = "https://ntfy.sh/"\n',  # pas de sujet
        '[notify.email]\nhost = "smtp.x"\nfrom = "a@b.c"\nto = []\n',
        '[notify.email]\nhost = "smtp.x"\nfrom = "a@b.c"\nto = ["d@e.f"]\nsecurity = "none"\n',
        '[notify.email]\nhost = "smtp.x"\nfrom = "a@b.c"\nto = ["d@e.f"]\nusername = "u"\n',  # sans mot de passe
        '[notify.email]\nhost = "smtp.x"\nfrom = "a@b.c"\nto = ["d@e.f"]\npassword = "en clair"\n',
        '[notify.sms]\nurl = "https://x/y"\n',
    ],
)
def test_settings_refuse_what_is_unsafe_or_incomplete(tmp_path: Path, text: str):
    with pytest.raises(ConfigError):
        load_settings(write(tmp_path, text), {"NAS_AGENT_DATA_DIR": str(tmp_path)})


def test_channels_read_their_secrets_from_files(tmp_path: Path):
    (tmp_path / "secrets").mkdir()
    (tmp_path / "secrets" / "ntfy").write_text("tk_secret\n")
    (tmp_path / "secrets" / "hook").write_text("cle-du-webhook\n")
    p = write(
        tmp_path,
        '[notify.ntfy]\nurl = "https://ntfy.sh/s"\ntoken_file = "secrets/ntfy"\n'
        '[notify.webhook]\nurl = "https://hooks.example.org/x"\nsecret_file = "secrets/hook"\n',
    )
    s = load_settings(p, {"NAS_AGENT_DATA_DIR": str(tmp_path)})
    channels = build_channels(s)
    names = [c.name for c in channels]
    assert names == ["ntfy", "webhook"]
    assert channels[0].token == "tk_secret"
    assert channels[1].secret == b"cle-du-webhook"


def test_a_missing_secret_file_is_a_configuration_error(tmp_path: Path):
    p = write(tmp_path, '[notify.ntfy]\nurl = "https://ntfy.sh/s"\ntoken_file = "secrets/absent"\n')
    s = load_settings(p, {"NAS_AGENT_DATA_DIR": str(tmp_path)})
    with pytest.raises(ConfigError):
        build_channels(s)


def test_no_notify_section_means_no_channel(tmp_path: Path):
    s = load_settings(write(tmp_path, ""), {"NAS_AGENT_DATA_DIR": str(tmp_path)})
    assert build_channels(s) == []


# La ligne de commande et le vrai client HTTP ----------------------------------------------------


import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402

from nas_agent.cli import main  # noqa: E402


class _Receiver(BaseHTTPRequestHandler):
    received: ClassVar[list[tuple[str, dict, bytes]]] = []
    status = 200

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        _Receiver.received.append((self.path, dict(self.headers), body))
        self.send_response(_Receiver.status)
        if _Receiver.status == 302:
            self.send_header("Location", "http://127.0.0.1:1/ailleurs")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def receiver():
    _Receiver.received.clear()
    _Receiver.status = 200
    server = HTTPServer(("127.0.0.1", 0), _Receiver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_cli_notify_test_sends_a_signed_trial_to_the_webhook(tmp_path: Path, receiver, capsys):
    (tmp_path / "secrets").mkdir()
    (tmp_path / "secrets" / "hook").write_text("cle")
    (tmp_path / "config.toml").write_text(
        DSM + f'[notify.webhook]\nurl = "{receiver}/fulmar"\nsecret_file = "secrets/hook"\n'
    )
    code = main(["--data-dir", str(tmp_path), "notify", "test", "--name", "Atelier"])
    out = capsys.readouterr().out
    assert code == 0
    assert "webhook: ok" in out
    path, headers, body = _Receiver.received[0]
    assert path == "/fulmar"
    assert json.loads(body)["test"] is True
    assert headers["X-Nas-Agent-Signature"].startswith("t=")

    assert main(["--data-dir", str(tmp_path), "notify", "status"]) == 0
    assert "webhook" in capsys.readouterr().out


def test_cli_notify_test_reports_a_redirect_as_a_failure(tmp_path: Path, receiver, capsys):
    _Receiver.status = 302
    (tmp_path / "config.toml").write_text(DSM + f'[notify.webhook]\nurl = "{receiver}/x"\n')
    code = main(["--data-dir", str(tmp_path), "notify", "test"])
    assert code == 1
    assert "webhook: http_302" in capsys.readouterr().out
    # La redirection n'est pas suivie : un seul appel, au receveur.
    assert len(_Receiver.received) == 1


def test_cli_notify_without_channels_says_so(tmp_path: Path, capsys):
    (tmp_path / "config.toml").write_text(DSM)
    assert main(["--data-dir", str(tmp_path), "notify", "test"]) == 2
    assert "[notify]" in capsys.readouterr().err


def test_messages_in_english():
    m = messages.compose([event("failed", "critical")], "Workshop", T0)
    assert m.title.startswith("Workshop: ")
    assert m.body.startswith("Failed: ")
    many = messages.compose(
        [event("failed", "critical"), event("warning", "warning")], "Workshop", T0
    )
    assert many.summary == "2 alerts, 1 critical"
    assert "test message" == messages.trial_message("Workshop", T0).summary
    # Un message en file, d'avant les langues, se relit en français.
    old = m.dump()
    del old["lang"]
    assert messages.Message.load(old).lang == "fr"


async def test_the_nas_name_is_kept_when_dsm_goes_silent(parts):
    """DSM muet : l'état n'a plus de nom ; l'alerte garde le dernier connu (2026-11-26)."""
    _, _, now = parts
    source = Source(built({"system.reachable": "ok"}))
    ntfy = Recorder("ntfy")
    svc = service(parts, source, [ntfy])
    await svc.tick()
    silent = built({"system.reachable": "failed"})
    silent.content["nas"] = {"name": None}
    source.state = silent
    now["t"] = T0 + timedelta(minutes=6)
    await svc.tick()
    (message,) = ntfy.sent
    assert message.nas == "Atelier"
