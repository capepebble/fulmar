"""nas-agent notify test | status : essayer les canaux d'alerte, voir leurs files."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from nas_agent.audit import AuditLog
from nas_agent.config import ConfigError, load_settings
from nas_agent.db import open_db
from nas_agent.notify.service import NotifyService, build_channels
from nas_agent.relay.store import RelayStore


def add_parser(sub: argparse._SubParsersAction) -> None:
    notify = sub.add_parser("notify", help="Engine alerts: email, ntfy, webhook.").add_subparsers(
        dest="action", required=True
    )
    test = notify.add_parser("test", help="Send a test message on each configured channel.")
    test.add_argument("--channel", choices=["ntfy", "email", "webhook"], help="One channel only.")
    test.add_argument("--name", help='NAS name in the message (default: "NAS").')
    notify.add_parser("status", help="Configured channels and pending messages.")


async def _no_state():  # l'essai et l'état ne lisent pas DSM
    raise RuntimeError("no DSM read here")


def run(args: argparse.Namespace, data_dir: Path) -> int:
    try:
        env = dict(os.environ, NAS_AGENT_DATA_DIR=str(data_dir))
        settings = load_settings(data_dir / "config.toml", env)
        if not settings.notify.configured:
            print(
                "No alert channel in [notify]: add [notify.ntfy], [notify.email] or "
                "[notify.webhook] to config.toml.",
                file=sys.stderr,
            )
            return 2
        channels = build_channels(settings)
    except ConfigError as exc:
        print(f"Configuration: {exc}", file=sys.stderr)
        return 2
    conn = open_db(settings.db_path)
    service = NotifyService(
        RelayStore(conn),
        AuditLog(conn),
        _no_state,
        channels,
        lang=settings.language,  # type: ignore[arg-type]
    )
    if args.action == "test":
        result = asyncio.run(service.test(args.channel, args.name))
        if not result:
            print(f"Channel not configured: {args.channel}.", file=sys.stderr)
            return 2
        for name, outcome in result.items():
            print(f"{name}: {outcome}")
        return 0 if all(v == "ok" for v in result.values()) else 1
    status = service.status()
    for name in status["channels"]:
        waiting = status["queues"][name]
        print(f"{name}: configured, {waiting} message{'s' if waiting != 1 else ''} pending")
    return 0
