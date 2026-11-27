import pytest

from nas_agent.dsm.gateway import DsmError
from nas_agent.probe import is_read_only, load_candidates, run_probe, scrub, sensitive_values
from tests.conftest import FakeDsm


def test_read_only_gate():
    assert is_read_only("list") and is_read_only("get_status") and is_read_only("load_info")
    for method in ("backup", "set", "delete", "start", "reboot", "restore", "run"):
        assert not is_read_only(method)


def test_shipped_candidates_are_read_only():
    candidates = load_candidates()
    assert len(candidates) > 20
    assert all(is_read_only(c.method) for c in candidates)


def test_write_candidate_refused():
    with pytest.raises(ValueError):
        load_candidates('[[call]]\napi = "SYNO.Backup.Task"\nmethod = "backup"\n')


def test_scrub():
    raw = {
        "serial": "2150ABC123",
        "mac": "00:11:32:AB:CD:EF",
        "nic": [{"ip": "192.168.1.20", "note": "gw 10.0.0.1, mac 0A-1B-2C-3D-4E-5F"}],
        "loopback": "127.0.0.1",
        "email": "jean@example.org",
        "model": "DS923+",
        "disk_serial": "WD-123",
    }
    out = scrub(raw)
    assert out["serial"] == "<serial>" and out["disk_serial"] == "<disk_serial>"
    assert out["mac"] == "<mac>" and out["email"] == "<email>"
    assert out["nic"][0]["ip"] == "192.0.2.1"
    assert "10.0.0.1" not in out["nic"][0]["note"] and "0A-1B" not in out["nic"][0]["note"]
    assert out["loopback"] == "127.0.0.1" and out["model"] == "DS923+"


def test_scrub_quickconnect_identity():
    # SYNO.Core.QuickConnect get : l'identifiant QuickConnect suffit à joindre le NAS.
    out = scrub({"server_alias": "mon-nas", "server_id": "123456789", "domain": "quickconnect.to"})
    assert out == {
        "server_alias": "<server_alias>",
        "server_id": "<server_id>",
        "domain": "quickconnect.to",
    }


def test_scrub_keeps_netmasks():
    # SYNO.Core.Network.Interface list : un masque n'identifie rien, une adresse si.
    out = scrub({"ip": "192.168.1.20", "mask": "255.255.255.0", "v": "255.255.0.0 255.1.0.0"})
    assert out == {"ip": "192.0.2.1", "mask": "255.255.255.0", "v": "255.255.0.0 192.0.2.1"}


def test_scrub_backup_target_identity():
    # SYNO.Backup.Target get : « uni_key » commence par l'adresse MAC du NAS, sans séparateurs.
    out = scrub({"uni_key": "0011322ABCDE_1_1793977696", "last_detect_time": "2026/11/09 10:35"})
    assert out == {"uni_key": "<uni_key>", "last_detect_time": "2026/11/09 10:35"}


def test_scrub_camel_case_keys():
    # Vu sur le NAS d'essai : SYNO.Storage.CGI.Storage rend le numéro de série sous « machineSerial ».
    out = scrub({"machineSerial": "2240ABCDEF", "diskUuid": "u-1", "hostName": "nas-1"})
    assert out == {
        "machineSerial": "<machine_serial>",
        "diskUuid": "<disk_uuid>",
        "hostName": "<host_name>",
    }


def test_known_values_are_scrubbed_everywhere():
    info = {"serial": "2240ABCDEF", "model": "DS420+"}
    storage = {"oddKey": "2240ABCDEF", "label": "NAS 2240ABCDEF (salon)", "model": "DS420+"}
    known = sensitive_values(info) | sensitive_values(storage)
    assert known == {"2240ABCDEF"}
    out = scrub(storage, known=known)
    assert out["oddKey"] == "<redacted>" and "2240ABCDEF" not in out["label"]
    assert out["model"] == "DS420+"


def test_short_known_values_are_ignored():
    # Une valeur trop courte (« 1 », « on ») remplacerait n'importe quoi.
    assert sensitive_values({"sn": "1", "user": "on", "serial": ""}) == set()


def test_builtin_accounts_are_not_hunted_elsewhere():
    # Vu sur le NAS d'essai : « SYSTEM_ADMIN » sous la clé « user » du journal de Hyper Backup
    # effaçait ce pseudo-compte de DSM dans tous les journaux. Il n'identifie personne.
    raw = {"user": "SYSTEM_ADMIN", "owner": "root", "username": "jeanne"}
    assert sensitive_values(raw) == {"jeanne"}
    assert scrub({"who": "SYSTEM_ADMIN"}, known=sensitive_values(raw)) == {"who": "SYSTEM_ADMIN"}


async def test_run_probe_writes_private_files_and_expands_tasks(tmp_path):
    from nas_agent.probe import Candidate

    dsm = FakeDsm(
        {
            "SYNO.API.Info.query": {
                "SYNO.Backup.Task": {"minVersion": 1, "maxVersion": 1},
                "SYNO.Core.User": {"minVersion": 1, "maxVersion": 1},
            },
            "SYNO.Backup.Task.list": {"task_list": [{"task_id": 3}, {"task_id": 7}]},
            "SYNO.Backup.Task.status": {"state": "ok"},
            "SYNO.Core.User.list": DsmError(105),
        }
    )
    candidates = [
        Candidate("SYNO.Backup.Task", "list"),
        Candidate(
            "SYNO.Backup.Task",
            "status",
            each={"from": "SYNO.Backup.Task.list", "items": "task_list", "key": "task_id"},
        ),
        Candidate("SYNO.Core.User", "list"),
        Candidate("SYNO.Missing.Api", "get"),
    ]
    lines = await run_probe(dsm, tmp_path / "out", candidates)
    outcomes = {f"{x.api}.{x.method}{x.suffix}": x.outcome for x in lines}
    assert outcomes == {
        "SYNO.Backup.Task.list": "ok",
        "SYNO.Backup.Task.status.3": "ok",
        "SYNO.Backup.Task.status.7": "ok",
        "SYNO.Core.User.list": "error 105",
        "SYNO.Missing.Api.get": "absent",
    }
    assert ("SYNO.Backup.Task", "status", {"task_id": "3"}) in dsm.calls
    written = tmp_path / "out" / "SYNO.Backup.Task.status.7.json"
    assert written.stat().st_mode & 0o077 == 0
    assert (tmp_path / "out" / "summary.tsv").exists()


async def test_run_probe_names_files_of_devices_with_slashes(tmp_path):
    """Les disques s'appellent « /dev/sata1 » : le fichier garde un nom plat, l'appel la valeur."""
    from nas_agent.probe import Candidate

    dsm = FakeDsm(
        {
            "SYNO.API.Info.query": {
                "SYNO.Storage.CGI.Storage": {"minVersion": 1, "maxVersion": 1},
                "SYNO.Storage.CGI.Smart": {"minVersion": 1, "maxVersion": 1},
            },
            "SYNO.Storage.CGI.Storage.load_info": {"disks": [{"device": "/dev/sata1"}]},
            "SYNO.Storage.CGI.Smart.get_smart_info": {"overview": {}},
        }
    )
    candidates = [
        Candidate("SYNO.Storage.CGI.Storage", "load_info"),
        Candidate(
            "SYNO.Storage.CGI.Smart",
            "get_smart_info",
            each={"from": "SYNO.Storage.CGI.Storage.load_info", "items": "disks", "key": "device"},
        ),
    ]
    await run_probe(dsm, tmp_path / "out", candidates)
    assert ("SYNO.Storage.CGI.Smart", "get_smart_info", {"device": "/dev/sata1"}) in dsm.calls
    assert (tmp_path / "out" / "SYNO.Storage.CGI.Smart.get_smart_info._dev_sata1.json").exists()


def test_scrub_secret_shaped_keys():
    """SNMP, notifications, nom de domaine de DSM : jamais une communauté, un jeton, un nom."""
    raw = {
        "rocommunity": "s3cr3t-community",
        "rouser": "monitor-user",
        "smtp_auth": {"password": "hunter22", "token": "tok-123456"},
        "client_secret": "abcdef123456",
        "fqdn": "nas.example-client.fr",
        "enable_snmp_v1v2": True,
        "http_port": 5000,
    }
    clean = scrub(raw)
    assert clean["rocommunity"] == "<rocommunity>"
    assert clean["rouser"] == "<rouser>"
    assert clean["smtp_auth"] == {"password": "<password>", "token": "<token>"}
    assert clean["client_secret"] == "<client_secret>"
    assert clean["fqdn"] == "<fqdn>"
    assert clean["enable_snmp_v1v2"] is True and clean["http_port"] == 5000
