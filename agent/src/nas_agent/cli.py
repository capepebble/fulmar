"""Ligne de commande : nas-agent serve | ops | enroll | token … | audit … | relay … | notify …"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from nas_agent import __version__
from nas_agent.audit import AuditLog
from nas_agent.config import DEFAULT_DATA_DIR, ConfigError, Settings, load_settings
from nas_agent.db import open_db, transaction
from nas_agent.tokens import KNOWN_SCOPES, TokenStore


def _data_dir(args: argparse.Namespace) -> Path:
    return Path(args.data_dir or os.environ.get("NAS_AGENT_DATA_DIR") or DEFAULT_DATA_DIR)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="nas-agent", description="Read-only agent of a Synology NAS.")
    p.add_argument("--version", action="version", version=f"nas-agent {__version__}")
    p.add_argument("--data-dir", help="Data folder (default: $NAS_AGENT_DATA_DIR or /data).")
    sub = p.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Run the REST and MCP API.")
    serve.add_argument("--fixtures", type=Path, help="Development: recorded answers.")
    sub.add_parser("ops", help="List the catalog operations.")
    probe = sub.add_parser("probe", help="Read-only DSM discovery probe.")
    probe.add_argument(
        "--out",
        type=Path,
        help="Folder for raw answers (default: <data-dir>/probe-out). Never in the repository.",
    )
    enroll = sub.add_parser("enroll", help="Enroll the agent with the NAS's DSM.")
    enroll.add_argument(
        "--public-host",
        action="append",
        default=[],
        help="Public name of the agent (e.g. nas-agent-x.tailnet.ts.net).",
    )

    token = sub.add_parser("token", help="Manage access tokens.").add_subparsers(
        dest="action", required=True
    )
    create = token.add_parser("create", help="Create a token (shown only once).")
    create.add_argument("--label", required=True)
    create.add_argument(
        "--scopes",
        required=True,
        help=f"Comma-separated scopes: {', '.join(sorted(KNOWN_SCOPES))}",
    )
    create.add_argument("--ttl-days", type=int, default=90)
    create.add_argument("--cidr", action="append", default=[], help="Allowed address range.")
    token.add_parser("list", help="List the tokens.")
    revoke = token.add_parser("revoke", help="Revoke a token.")
    revoke.add_argument("token_id")

    audit = sub.add_parser("audit", help="Call log.").add_subparsers(dest="action", required=True)
    audit.add_parser("verify", help="Verify the hash chain.")
    tail = audit.add_parser("tail", help="Latest entries.")
    tail.add_argument("-n", type=int, default=20)

    from nas_agent import relay

    # Le relais (téléphones) n'est là qu'avec son chiffrement (`relay.available()`).
    if relay.available():
        from nas_agent.relay import cli as relay_cli

        relay_cli.add_parser(sub)
    from nas_agent.notify import cli as notify_cli

    notify_cli.add_parser(sub)
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    data_dir = _data_dir(args)

    if args.command == "ops":
        from nas_agent.catalog.ops import build_catalog

        for op in build_catalog():
            flag = " (personal data)" if op.personal else ""
            print(f"{op.id:<26} {op.kind:<6} {op.scope:<14} /v1{op.path}{flag}")
        return 0

    if args.command == "serve":
        return _serve(data_dir, args.fixtures)

    if args.command == "probe":
        return _probe(data_dir, args.out)

    if args.command == "enroll":
        from nas_agent.enroll import run_enroll

        return run_enroll(data_dir, args.public_host)

    if args.command == "relay":
        from nas_agent.relay import cli as relay_cli

        return relay_cli.run(args, data_dir)

    if args.command == "notify":
        from nas_agent.notify import cli as notify_cli

        return notify_cli.run(args, data_dir)

    db_path = data_dir / "agent.db"
    if not db_path.exists() and not (args.command == "token" and args.action == "create"):
        print(f"Database missing: {db_path}. Wrong --data-dir?", file=sys.stderr)
        return 2
    conn = open_db(db_path)
    audit = AuditLog(conn)
    if args.command == "token":
        return _token(args, TokenStore(conn), audit)
    return _audit(args, audit)


_UVICORN = {
    "proxy_headers": False,
    "server_header": False,
    "log_level": "info",
    "limit_concurrency": 32,
    "h11_max_incomplete_event_size": 16 * 1024,
}


def server_options(settings: Settings) -> dict[str, object]:
    """Les réglages d'uvicorn. Un hub sert aussi ses NAS ajoutés, que la console lit chacun
    en une vingtaine de requêtes parallèles : la limite de connexions suit leur nombre."""
    options = dict(_UVICORN)
    if settings.console_token_file is not None:
        options["limit_concurrency"] = int(_UVICORN["limit_concurrency"]) * (1 + settings.fleet_max)
    return options


def serve_mode(data_dir: Path, env: Mapping[str, str], fixtures: Path | None) -> str:
    """« setup » : dans le projet du moteur, l'agent attend d'être enrôlé par la console."""
    from nas_agent.setup import is_enrolled

    if fixtures is None and env.get("NAS_AGENT_CONSOLE_TOKEN_FILE") and not is_enrolled(data_dir):
        return "setup"
    return "normal"


def _wait_for_enrollment(env: Mapping[str, str]) -> bool:
    """L'agent en attente, jusqu'à son enrôlement par la console ; vrai s'il a été enrôlé."""
    import uvicorn

    from nas_agent.setup import (
        Enroller,
        create_setup_app,
        ensure_console_token,
        is_enrolled,
        load_setup_settings,
    )

    setup = load_setup_settings(env)
    if setup is None:  # serve_mode l'a vérifié
        return False
    conn = open_db(setup.data_dir / "agent.db")
    tokens, audit = TokenStore(conn), AuditLog(conn)
    ensure_console_token(tokens, setup.console_token_file, setup.console_cidrs)
    server: uvicorn.Server | None = None

    def enrolled() -> None:
        # La réponse part, puis le serveur d'attente s'arrête et l'agent démarre pour de bon.
        if server is not None:
            server.should_exit = True

    app = create_setup_app(setup, tokens, audit, Enroller(), enrolled)
    server = uvicorn.Server(
        uvicorn.Config(app, host=setup.bind_host, port=setup.bind_port, **_UVICORN)
    )
    print("Agent waiting for enrollment: open the project's console.", file=sys.stderr)
    server.run()
    conn.close()
    return is_enrolled(setup.data_dir)


def _serve(data_dir: Path, fixtures: Path | None) -> int:
    import uvicorn

    from nas_agent.app_factory import build_runtime

    env = dict(os.environ, NAS_AGENT_DATA_DIR=str(data_dir))
    while True:
        try:
            if serve_mode(data_dir, env, fixtures) == "setup" and not _wait_for_enrollment(env):
                return 0  # arrêté avant d'être enrôlé
            settings = load_settings(data_dir / "config.toml", env)
        except ConfigError as exc:
            print(f"Configuration invalide : {exc}", file=sys.stderr)
            return 2
        runtime = build_runtime(settings, fixtures=fixtures)
        server = uvicorn.Server(
            uvicorn.Config(
                runtime.app,
                host=settings.bind_host,
                port=settings.bind_port,
                **server_options(settings),  # type: ignore[arg-type]
            )
        )

        def stop(server: uvicorn.Server = server) -> None:
            server.should_exit = True

        runtime.control.stop = stop
        server.run()
        runtime.close()
        # Détaché de Fulmar (agent.detach) : l'agent attend une nouvelle installation, dans le
        # même processus. Arrêté autrement, il s'arrête.
        if not runtime.control.detached or fixtures is not None:
            return 0
        print("Agent detached from Fulmar: waiting for a new installation.", file=sys.stderr)


def _probe(data_dir: Path, out: Path | None) -> int:
    from nas_agent.dsm.credentials import load_credentials
    from nas_agent.dsm.gateway import DsmGateway
    from nas_agent.probe import probe_main

    env = dict(os.environ, NAS_AGENT_DATA_DIR=str(data_dir))
    settings = load_settings(data_dir / "config.toml", env)
    gateway = DsmGateway(settings.dsm, load_credentials(settings.credentials_path), concurrency=1)
    return probe_main(gateway, out or data_dir / "probe-out")


def _token(args: argparse.Namespace, tokens: TokenStore, audit: AuditLog) -> int:
    if args.action == "create":
        scopes = [s.strip() for s in args.scopes.split(",") if s.strip()]
        try:
            # Le jeton et sa trace dans le journal existent ensemble ou pas du tout.
            with transaction(tokens.conn):
                info, raw = tokens.create(args.label, scopes, args.ttl_days, args.cidr)
                audit.record(
                    channel="cli",
                    op="token.create",
                    token_id=info.id,
                    client_ip=None,
                    outcome="ok",
                    params={"label": args.label, "scopes": ",".join(scopes)},
                )
        except ValueError as exc:
            print(f"Refused: {exc}", file=sys.stderr)
            return 2
        print(raw)
        print(
            f"Token {info.id} created, expires on {info.expires_at:%Y-%m-%d}. It will never be "
            "shown again: store it now.",
            file=sys.stderr,
        )
        return 0
    if args.action == "list":
        for t in tokens.list():
            state = "revoked" if t.revoked_at else f"expires {t.expires_at:%Y-%m-%d}"
            used = f"{t.last_used_at:%Y-%m-%d %H:%M}" if t.last_used_at else "never"
            print(
                f"{t.id}  {t.label:<20} {','.join(sorted(t.scopes)):<40} {state:<18} used: {used}"
            )
        return 0
    ok = tokens.revoke(args.token_id)
    audit.record(
        channel="cli",
        op="token.revoke",
        token_id=args.token_id,
        client_ip=None,
        outcome="ok" if ok else "error",
    )
    print("Revoked." if ok else "Unknown or already revoked token.", file=sys.stderr)
    return 0 if ok else 1


def _audit(args: argparse.Namespace, audit: AuditLog) -> int:
    if args.action == "verify":
        result = audit.verify()
        if result.ok:
            print(f"Chain intact: {result.checked} entries checked.")
            return 0
        print(
            f"Chain broken at entry {result.broken_at} ({result.checked} sound entries before it).",
            file=sys.stderr,
        )
        return 1
    for e in audit.tail(args.n):
        print(
            f"{e.seq:>6} {e.ts} {e.channel:<4} {e.outcome:<6} {e.op or '-':<24} "
            f"{e.code or '':<16} {e.token_id or '-'} {e.client_ip or '-'}"
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
