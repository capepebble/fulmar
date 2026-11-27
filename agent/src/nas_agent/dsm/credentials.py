"""Identifiants du compte de service DSM, dans un fichier JSON en mode 600."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


class CredentialsError(RuntimeError):
    pass


@dataclass(frozen=True)
class DsmCredentials:
    username: str
    password: str
    device_token: str | None = None

    def __repr__(self) -> str:  # jamais le mot de passe dans une trace
        return f"DsmCredentials(username={self.username!r}, password='***', device_token=...)"


def save_credentials(path: Path, creds: DsmCredentials) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(asdict(creds), fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_credentials(path: Path) -> DsmCredentials:
    if not path.exists():
        raise CredentialsError(f"DSM credentials missing: run 'nas-agent enroll' ({path}).")
    if path.stat().st_mode & 0o077:
        raise CredentialsError(f"{path} is readable by others: chmod 600 before going on.")
    data = json.loads(path.read_text())
    return DsmCredentials(
        username=data["username"],
        password=data["password"],
        device_token=data.get("device_token"),
    )
