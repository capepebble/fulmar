from nas_agent.audit import AuditLog
from nas_agent.cli import main
from nas_agent.config import DsmSettings, load_settings
from nas_agent.db import open_db
from nas_agent.enroll import choose_tls_mode, render_config


def test_token_lifecycle(tmp_path, capsys):
    d = ["--data-dir", str(tmp_path)]
    assert main([*d, "token", "create", "--label", "mac", "--scopes", "system:read"]) == 0
    raw = capsys.readouterr().out.strip()
    assert raw.startswith("nag_")
    assert main([*d, "token", "list"]) == 0
    listing = capsys.readouterr().out
    assert "mac" in listing and raw not in listing and raw.split("_", 2)[2] not in listing
    token_id = raw.split("_")[1]
    assert main([*d, "token", "revoke", token_id]) == 0
    assert main([*d, "token", "revoke", token_id]) == 1
    assert main([*d, "token", "create", "--label", "x", "--scopes", "root:all"]) == 2


def test_audit_verify(tmp_path, capsys):
    d = ["--data-dir", str(tmp_path)]
    main([*d, "token", "create", "--label", "mac", "--scopes", "system:read"])
    assert main([*d, "audit", "verify"]) == 0
    conn = open_db(tmp_path / "agent.db")
    AuditLog(conn).record(channel="cli", op="x", token_id=None, client_ip=None, outcome="ok")
    conn.execute("UPDATE audit SET op = 'forged' WHERE seq = 1")
    assert main([*d, "audit", "verify"]) == 1
    assert main([*d, "audit", "tail", "-n", "5"]) == 0


def test_ops_lists_ids(capsys):
    assert main(["ops"]) == 0
    out = capsys.readouterr().out
    assert "system.info" in out and "/v1/storage/overview" in out


def test_choose_tls_mode():
    assert choose_tls_mode("ab" * 32, None, False) == ("pin", None, "ab" * 32)
    assert choose_tls_mode("ab" * 32, "nas.example.org", False) == ("pin", None, "ab" * 32)
    assert choose_tls_mode("ab" * 32, "nas.example.org", True) == (
        "hostname",
        "nas.example.org",
        None,
    )


def test_rendered_config_loads(tmp_path):
    dsm = DsmSettings(host="172.17.0.1", tls_mode="pin", tls_fingerprint="cd" * 32)
    path = tmp_path / "config.toml"
    path.write_text(render_config(dsm, ["nas-agent-x.tailnet.ts.net"]))
    s = load_settings(path, env={})
    assert s.dsm == dsm and s.public_hosts == ["nas-agent-x.tailnet.ts.net"]


def test_audit_on_missing_db_fails(tmp_path):
    assert main(["--data-dir", str(tmp_path / "nope"), "audit", "verify"]) == 2
    assert not (tmp_path / "nope" / "agent.db").exists()


def test_hub_accepts_the_parallel_reads_of_all_its_nas(settings, tmp_path):
    # La console lit chaque NAS en une vingtaine de requêtes parallèles : un hub qui sert ses
    # NAS ajoutés en reçoit autant par NAS (conception 2026-11-26-parc-du-moteur).
    from dataclasses import replace

    from nas_agent.cli import server_options

    assert server_options(settings)["limit_concurrency"] == 32
    hub = replace(settings, console_token_file=tmp_path / "console-token", fleet_max=3)
    assert server_options(hub)["limit_concurrency"] == 32 * 4
