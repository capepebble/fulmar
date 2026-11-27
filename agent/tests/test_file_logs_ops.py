import pytest

from nas_agent.catalog.ops import build_catalog
from nas_agent.dsm.gateway import DsmError
from nas_agent.engine import Engine, OpError
from tests.conftest import FakeDsm, principal
from tests.real_nas import real

LOGS = "SYNO.Core.SyslogClient.Log.list"
XFER = "SYNO.Core.SyslogClient.FileTransfer.get"

# Entrées synthétiques pour les cas que le NAS d'essai n'a pas produits : SMB (journal
# d'origine « smbxfer », nom repris de l'interface du Centre des journaux), taille en Ko,
# flèche dans un nom de fichier, renommage ambigu, entrées illisibles.
SYNTHETIC = {
    "items": [
        {
            "cmd": "write",
            "descr": "/essai/devis -> client.pdf",
            "filesize": "1.5 KB",
            "ip": "192.0.2.10",
            "isdir": "false",
            "logtype": "SMB",
            "orginalLogType": "smbxfer",
            "time": "2026/11/09 21:40:12",
            "username": "jeanne",
        },
        {"cmd": "rename", "descr": "/a -> /b -> /c", "filesize": "?", "logtype": "Autre"},
        "x",
        None,
    ],
    "total": 2,
}
ALL_ON = {"afp": False, "cifs": True, "filestation": True, "ftp": False, "webdav": False}


async def run(responses, audit, settings, *scopes, **params):
    dsm = FakeDsm(responses)
    engine = Engine(build_catalog(), dsm, audit, settings, service_account="claude")
    p = principal(*(scopes or ("personal:read",)))
    env = await engine.run("logs.files", params, p, channel="rest", client_ip=None)
    return env.data, dsm


# Réponse réelle du NAS d'essai (DS420+, DSM 7.4.1), nettoyée : la forme qui fait foi.


async def test_file_logs_real_ds420p_dsm741(audit, settings):
    responses = {LOGS: real("log_files"), XFER: real("file_transfer_settings")}
    data, dsm = await run(responses, audit, settings, limit=20)
    assert data["total"] == 6
    assert data["logging"] == {
        "smb": True,
        "file_station": True,
        "ftp": False,
        "webdav": False,
        "afp": False,
        "tftp": False,
    }
    assert [(e["action"], e["path"], e["destination"]) for e in data["entries"]] == [
        ("delete", "/essai/journal 2 renommé", None),
        ("delete", "/essai/journal renommé", None),
        ("move", "/essai/journal 2 renommé/note-2.txt", "/essai/journal renommé/note-2.txt"),
        ("copy", "/essai/documents/note-2.txt", "/essai/journal 2 renommé/note-2.txt"),
        ("rename", "/essai/journal-essai-2", "/essai/journal 2 renommé"),
        ("create folder", "/essai/journal-essai-2", None),
    ]
    assert data["entries"][2] == {
        "time": "2026-11-09T21:26:37",
        "protocol": "File Station",
        "account": "claude",
        "address": "127.0.0.1",
        "action": "move",
        "path": "/essai/journal 2 renommé/note-2.txt",
        "destination": "/essai/journal renommé/note-2.txt",
        "is_dir": False,
        "size": 45,
    }
    log_call = next(c for c in dsm.calls if c[0] == "SYNO.Core.SyslogClient.Log")
    assert log_call[2]["logtype"] == "ftp,filestation,webdav,cifs,afp,tftp"
    assert log_call[2]["limit"] == 20


async def test_file_logs_smb_sizes_and_odd_entries(audit, settings):
    data, _ = await run({LOGS: SYNTHETIC, XFER: ALL_ON}, audit, settings)
    assert data["entries"] == [
        {
            "time": "2026-11-09T21:40:12",
            "protocol": "SMB",
            "account": "jeanne",
            "address": "192.0.2.10",
            "action": "write",
            "path": "/essai/devis -> client.pdf",
            "destination": None,
            "is_dir": False,
            "size": 1536,
        },
        {
            "time": None,
            "protocol": "Autre",
            "account": None,
            "address": None,
            "action": "rename",
            "path": "/a -> /b -> /c",
            "destination": None,
            "is_dir": None,
            "size": None,
        },
    ]
    assert data["logging"]["tftp"] is None


async def test_file_logs_without_logging_settings(audit, settings):
    data, _ = await run({LOGS: {"items": [], "total": 0}, XFER: DsmError(105)}, audit, settings)
    assert data["logging"] is None
    assert data["entries"] == []


async def test_file_logs_params_are_bounded(audit, settings):
    for params in ({"limit": 0}, {"limit": 201}, {"kind": "system"}):
        with pytest.raises(OpError) as info:
            await run({LOGS: {}, XFER: {}}, audit, settings, **params)
        assert info.value.status == 422


async def test_file_logs_need_personal_read(audit, settings):
    with pytest.raises(OpError) as info:
        await run({LOGS: {}, XFER: {}}, audit, settings, "system:read", "audit:checks")
    assert info.value.status == 403


def test_file_logs_scope_and_verification():
    op = build_catalog().get("logs.files")
    assert op.scope == "personal:read" and op.personal is True and op.kind == "read"
    assert op.path == "/logs/files"
    assert op.verified_on
