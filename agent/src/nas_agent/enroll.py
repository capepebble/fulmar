"""Enrôlement : relier l'agent au DSM du NAS (certificat, compte de service, 2FA)."""

from __future__ import annotations

import asyncio
import getpass
import hashlib
import ipaddress
import socket
import ssl
from collections.abc import Callable
from pathlib import Path

from synology_dsm.exceptions import (
    SynologyDSMLogin2SARequiredException,
    SynologyDSMLoginFailedException,
)

from nas_agent.config import DsmSettings
from nas_agent.dsm.credentials import DsmCredentials, save_credentials
from nas_agent.dsm.gateway import _code, default_client_factory
from nas_agent.dsm.tls import build_session

# Trois essais : DSM bloque l'adresse après dix échecs en cinq minutes (réglage par défaut).
MAX_LOGIN_ATTEMPTS = 3

# Codes de SYNO.API.Auth, dans les mots d'un administrateur.
LOGIN_REASONS = {
    400: "unknown account or wrong password",
    401: "account disabled",
    402: "this account may not sign in",
    404: "wrong two-factor authentication code",
    406: "two-factor authentication is enforced for this account",
    407: "address blocked by DSM after too many failures",
    408: "password expired",
    409: "password expired",
    410: "password must be changed in DSM",
}

Login = Callable[[DsmSettings, DsmCredentials, Callable[[str], str]], str | None]


def sni_for(host: str) -> str | None:
    """Le nom à annoncer (SNI) : celui de l'hôte s'il en est un, rien pour une adresse IP."""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host
    return None


def fetch_certificate(host: str, port: int, timeout: float = 5.0) -> tuple[str, str]:
    """Certificat présenté par DSM (PEM) et son empreinte SHA-256, sans le vérifier."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # lecture seule : l'empreinte est confirmée par l'humain
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=sni_for(host)) as tls:
            der = tls.getpeercert(binary_form=True)
    if der is None:
        raise ssl.SSLError("DSM presented no certificate.")
    return ssl.DER_cert_to_PEM_cert(der), hashlib.sha256(der).hexdigest()


def certificate_verifies(host: str, port: int, server_name: str, timeout: float = 5.0) -> bool:
    """Le certificat de DSM se vérifie-t-il normalement pour ce nom ?"""
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=server_name):
                return True
    except ssl.SSLError:
        return False


def choose_tls_mode(
    fingerprint: str, server_name: str | None, verifies: bool
) -> tuple[str, str | None, str | None]:
    """(mode, nom, empreinte) : le nom d'hôte si le certificat se vérifie, l'épinglage sinon."""
    if server_name and verifies:
        return "hostname", server_name, None
    return "pin", None, fingerprint


def render_config(dsm: DsmSettings, public_hosts: list[str]) -> str:
    lines = []
    if public_hosts:
        lines.append(f"public_hosts = [{', '.join(repr(h) for h in public_hosts)}]")
    lines += [
        "",
        "[dsm]",
        f'host = "{dsm.host}"',
        f"port = {dsm.port}",
        f'tls_mode = "{dsm.tls_mode}"',
    ]
    if dsm.tls_server_name:
        lines.append(f'tls_server_name = "{dsm.tls_server_name}"')
    if dsm.tls_fingerprint:
        lines.append(f'tls_fingerprint = "{dsm.tls_fingerprint}"')
    return "\n".join(lines).replace("'", '"') + "\n"


def default_gateway() -> str:
    """Passerelle par défaut vue du conteneur : l'hôte, donc DSM."""
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == "00000000":
                return socket.inet_ntoa(bytes.fromhex(fields[2])[::-1])
    except (OSError, IndexError, ValueError):
        pass
    return "127.0.0.1"


async def _login(dsm: DsmSettings, creds: DsmCredentials, ask: Callable[[str], str]) -> str | None:
    session = build_session(dsm)
    try:
        client = default_client_factory(session, dsm, creds)
        try:
            await client.login()
        except SynologyDSMLogin2SARequiredException:
            await client.login(ask("Two-factor authentication code: ").strip())
        token = client.device_token
        await client.logout()
        return token
    finally:
        await session.close()


def _ask_nonempty(ask: Callable[[str], str], prompt: str) -> str:
    while not (value := ask(prompt).strip()):
        print("Empty answer: try again.")
    return value


def _login_sync(dsm: DsmSettings, creds: DsmCredentials, ask: Callable[[str], str]) -> str | None:
    return asyncio.run(_login(dsm, creds, ask))


def run_enroll(
    data_dir: Path,
    public_hosts: list[str],
    ask: Callable[[str], str] = input,
    ask_secret: Callable[[str], str] = getpass.getpass,
    *,
    fetch: Callable[[str, int], tuple[str, str]] = fetch_certificate,
    login: Login = _login_sync,
) -> int:
    host = ask(f"DSM address as seen from the container [{default_gateway()}]: ").strip()
    host = host or default_gateway()
    port = int(ask("DSM HTTPS port [5001]: ").strip() or 5001)
    _pem, fingerprint = fetch(host, port)
    print(f"SHA-256 fingerprint of the certificate presented: {fingerprint}")
    name = ask("DSM certificate name (empty if self-signed): ").strip() or None
    mode, server_name, fp = choose_tls_mode(
        fingerprint, name, bool(name) and certificate_verifies(host, port, name or "")
    )
    if mode == "pin" and ask("Pin this certificate? [y/N] ").strip().lower() not in ("y", "yes"):
        print("Aborted: nothing was written.")
        return 1
    dsm = DsmSettings(
        host=host, port=port, tls_mode=mode, tls_server_name=server_name, tls_fingerprint=fp
    )
    for attempt in range(1, MAX_LOGIN_ATTEMPTS + 1):
        username = _ask_nonempty(ask, "DSM service account: ")
        creds = DsmCredentials(username, ask_secret("Password (not shown): "))
        try:
            device_token = login(dsm, creds, ask)
            break
        except SynologyDSMLoginFailedException as exc:
            code = _code(exc)
            reason = LOGIN_REASONS.get(code, "refused for no known reason")
            left = MAX_LOGIN_ATTEMPTS - attempt
            then = f"{left} attempt(s) left." if left else "nothing was written."
            print(f"DSM refused the sign-in (code {code}, {reason}): {then}")
    else:
        return 1
    save_credentials(
        data_dir / "secrets" / "dsm.json",
        DsmCredentials(creds.username, creds.password, device_token),
    )
    (data_dir / "config.toml").write_text(render_config(dsm, public_hosts))
    print(f"Agent enrolled with DSM (TLS mode: {mode}). Configuration: {data_dir / 'config.toml'}")
    return 0
