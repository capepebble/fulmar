import asyncio
import ssl

import aiohttp
import pytest
from synology_dsm.exceptions import (
    SynologyDSMAPIErrorException,
    SynologyDSMAPINotExistsException,
    SynologyDSMLoginInvalidException,
    SynologyDSMNotLoggedInException,
    SynologyDSMRequestException,
)

from nas_agent.config import DsmSettings
from nas_agent.dsm.credentials import (
    CredentialsError,
    DsmCredentials,
    load_credentials,
    save_credentials,
)
from nas_agent.dsm.gateway import (
    DsmAuthError,
    DsmCertificateError,
    DsmError,
    DsmGateway,
    DsmUnreachable,
    DsmUnsupported,
)
from nas_agent.dsm.tls import PinnedResolver, connector_kwargs, dsm_url_host

FP = "ab" * 32
PIN = DsmSettings(host="172.17.0.1", tls_mode="pin", tls_fingerprint=FP, timeout=0.2)
CREDS = DsmCredentials("svc-agent", "s3cr3t-pass", None)


class FakeClient:
    def __init__(self, script=None, login_error=None, delay=0.0):
        self.script = list(script or [])
        self.login_error = login_error
        self.delay = delay
        self.logins = 0
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self.device_token = None

    async def login(self, otp_code=None):
        self.logins += 1
        if self.login_error:
            raise self.login_error
        self.device_token = "did-123"
        return True

    async def logout(self):
        return True

    async def get(self, api, method, params=None, **kwargs):
        self.calls += 1
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(self.delay)
            step = self.script.pop(0) if self.script else {"success": True, "data": {"ok": 1}}
            if isinstance(step, BaseException):
                raise step
            return step
        finally:
            self.active -= 1


class DummySession:
    async def close(self):
        pass


def gateway(client, **kw):
    return DsmGateway(
        PIN,
        CREDS,
        client_factory=lambda s, st, c: client,
        session_factory=lambda st: DummySession(),
        **kw,
    )


async def test_relogin_once_on_session_expired():
    client = FakeClient([SynologyDSMAPIErrorException("SYNO.X", 119, None)])
    gw = gateway(client)
    assert await gw.call("SYNO.X", "get", max_version=1) == {"ok": 1}
    assert client.logins == 2 and client.calls == 2


async def test_not_logged_in_triggers_relogin():
    client = FakeClient([SynologyDSMNotLoggedInException()])
    assert await gateway(client).call("SYNO.X", "get", max_version=1) == {"ok": 1}
    assert client.logins == 2


async def test_second_expiry_raises():
    expired = SynologyDSMAPIErrorException("SYNO.X", 106, None)
    client = FakeClient([expired, SynologyDSMAPIErrorException("SYNO.X", 106, None)])
    with pytest.raises(DsmError):
        await gateway(client).call("SYNO.X", "get", max_version=1)
    assert client.calls == 2


async def test_concurrency_capped_at_two():
    client = FakeClient(delay=0.02)
    gw = gateway(client, concurrency=2)
    await asyncio.gather(*(gw.call("SYNO.X", "get", max_version=1) for _ in range(5)))
    assert client.max_active == 2
    assert client.logins == 1


async def test_timeout_maps_to_unreachable():
    client = FakeClient(delay=1.0)
    with pytest.raises(DsmUnreachable):
        await gateway(client).call("SYNO.X", "get", max_version=1)


def _mismatch():
    return aiohttp.ServerFingerprintMismatch(b"\0" * 32, b"\1" * 32, "172.17.0.1", 5001)


async def test_certificate_change_at_login_is_named():
    # py-synologydsm-api enveloppe l'erreur d'aiohttp (« raise … from exp »).
    wrapped = SynologyDSMRequestException(_mismatch())
    wrapped.__cause__ = _mismatch()
    with pytest.raises(DsmCertificateError, match="enroll again"):
        await gateway(FakeClient(login_error=wrapped)).call("SYNO.X", "get", max_version=1)


async def test_certificate_change_during_call_is_named():
    with pytest.raises(DsmCertificateError):
        await gateway(FakeClient([_mismatch()])).call("SYNO.X", "get", max_version=1)


async def test_request_error_maps_to_unreachable():
    client = FakeClient([SynologyDSMRequestException(aiohttp.ClientError("boom"))])
    with pytest.raises(DsmUnreachable):
        await gateway(client).call("SYNO.X", "get", max_version=1)


async def test_unknown_api_maps_to_unsupported():
    client = FakeClient([SynologyDSMAPINotExistsException("SYNO.Backup.Task")])
    with pytest.raises(DsmUnsupported):
        await gateway(client).call("SYNO.Backup.Task", "list", max_version=1)


async def test_api_error_keeps_code():
    client = FakeClient([SynologyDSMAPIErrorException("SYNO.X", 105, None)])
    with pytest.raises(DsmError) as info:
        await gateway(client).call("SYNO.X", "get", max_version=1)
    assert info.value.code == 105


async def test_login_failure_has_no_password():
    client = FakeClient(login_error=SynologyDSMLoginInvalidException("svc-agent"))
    with pytest.raises(DsmAuthError) as info:
        await gateway(client).call("SYNO.X", "get", max_version=1)
    assert "s3cr3t" not in str(info.value) and "s3cr3t" not in repr(info.value)
    assert "s3cr3t" not in repr(CREDS)


async def test_new_device_token_is_reported():
    seen = []
    await gateway(FakeClient(), on_device_token=seen.append).call("SYNO.X", "get", max_version=1)
    assert seen == ["did-123"]


def test_pin_mode_uses_fingerprint():
    kwargs = connector_kwargs(PIN)
    assert isinstance(kwargs["ssl"], aiohttp.Fingerprint)
    assert dsm_url_host(PIN) == "172.17.0.1"


async def test_hostname_mode_resolves_to_host():
    s = DsmSettings(host="172.17.0.1", tls_mode="hostname", tls_server_name="nas.example.org")
    kwargs = connector_kwargs(s)
    assert isinstance(kwargs["ssl"], ssl.SSLContext)
    assert kwargs["ssl"].check_hostname and kwargs["ssl"].verify_mode == ssl.CERT_REQUIRED
    assert dsm_url_host(s) == "nas.example.org"
    resolver = kwargs["resolver"]
    assert isinstance(resolver, PinnedResolver)
    [result] = await resolver.resolve("nas.example.org", 5001)
    assert result["host"] == "172.17.0.1" and result["hostname"] == "nas.example.org"
    with pytest.raises(OSError):
        await resolver.resolve("evil.example.com", 443)
    await resolver.close()


def test_credentials_file_mode_600(tmp_path):
    path = tmp_path / "secrets" / "dsm.json"
    save_credentials(path, CREDS)
    assert path.stat().st_mode & 0o777 == 0o600
    assert load_credentials(path) == CREDS


def test_credentials_world_readable_refused(tmp_path):
    path = tmp_path / "dsm.json"
    save_credentials(path, CREDS)
    path.chmod(0o644)
    with pytest.raises(CredentialsError):
        load_credentials(path)


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


async def test_auth_failure_backs_off():
    clock = Clock()
    client = FakeClient(login_error=SynologyDSMLoginInvalidException("svc-agent"))
    gw = gateway(client, clock=clock)
    for _ in range(30):
        with pytest.raises(DsmAuthError):
            await gw.call("SYNO.X", "get", max_version=1)
    assert client.logins == 1
    clock.now += 61
    with pytest.raises(DsmAuthError):
        await gw.call("SYNO.X", "get", max_version=1)
    assert client.logins == 2
    clock.now += 61  # la deuxième attente est de 120 s
    with pytest.raises(DsmAuthError):
        await gw.call("SYNO.X", "get", max_version=1)
    assert client.logins == 2


async def test_login_side_errors_are_mapped():
    client = FakeClient(login_error=SynologyDSMAPIErrorException("SYNO.DSM.Info", 105, None))
    with pytest.raises(DsmError) as info:
        await gateway(client).call("SYNO.X", "get", max_version=1)
    assert info.value.code == 105
    client = FakeClient(login_error=KeyError("sid"))
    with pytest.raises(DsmError):
        await gateway(client).call("SYNO.X", "get", max_version=1)


async def test_login_returning_false_is_auth_error():
    client = FakeClient()

    async def login(otp_code=None):
        client.logins += 1
        return False

    client.login = login
    with pytest.raises(DsmAuthError):
        await gateway(client).call("SYNO.X", "get", max_version=1)


async def test_device_token_write_failure_does_not_fail_call():
    def boom(_token):
        raise OSError("lecture seule")

    assert await gateway(FakeClient(), on_device_token=boom).call(
        "SYNO.X", "get", max_version=1
    ) == {"ok": 1}


async def test_min_version_and_unsupported_codes():
    client = FakeClient()
    client.apis = {"SYNO.Backup.Task": {"minVersion": 1, "maxVersion": 1}}
    with pytest.raises(DsmUnsupported):
        await gateway(client).call("SYNO.Backup.Task", "list", max_version=3, min_version=2)
    client = FakeClient([SynologyDSMAPIErrorException("SYNO.X", 103, None)])
    with pytest.raises(DsmUnsupported):
        await gateway(client).call("SYNO.X", "get", max_version=1)


async def test_stale_expiry_does_not_drop_newer_session():
    client = FakeClient()
    gw = gateway(client)
    await gw.call("SYNO.X", "get", max_version=1)
    await gw._invalidate(generation=0)  # réponse d'une session plus ancienne
    await gw.call("SYNO.X", "get", max_version=1)
    assert client.logins == 1


async def test_session_refuses_plain_http_and_redirects():
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    from nas_agent.dsm.tls import https_only

    async def redirect(_request):
        raise web.HTTPTemporaryRedirect("http://127.0.0.1:1/steal")

    app = web.Application()
    app.router.add_post("/webapi/auth.cgi", redirect)
    async with TestServer(app) as server:
        async with aiohttp.ClientSession(middlewares=(https_only("127.0.0.1"),)) as session:
            with pytest.raises(aiohttp.ClientError):
                await session.post(server.make_url("/webapi/auth.cgi"), data={"passwd": "x"})
