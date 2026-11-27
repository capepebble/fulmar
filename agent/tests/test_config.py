from pathlib import Path

import pytest

from nas_agent.config import ConfigError, load_settings


def _toml(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "config.toml"
    path.write_text(body)
    return path


BASE = """
[dsm]
host = "172.17.0.1"
tls_mode = "pin"
tls_fingerprint = "AB:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD"
"""


def test_defaults_bind_loopback(tmp_path):
    s = load_settings(_toml(tmp_path, BASE), env={})
    assert s.bind_host == "127.0.0.1"
    assert s.bind_port == 8765
    assert s.dsm.port == 5001
    assert s.limits.calls_per_minute == 60
    assert s.limits.dsm_concurrency == 2


def test_env_overrides_toml(tmp_path):
    s = load_settings(
        _toml(tmp_path, BASE),
        env={"NAS_AGENT_BIND_PORT": "9000", "NAS_AGENT_DSM_HOST": "10.0.0.2"},
    )
    assert s.bind_port == 9000
    assert s.dsm.host == "10.0.0.2"


def test_non_loopback_refused(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(_toml(tmp_path, 'bind_host = "0.0.0.0"\n' + BASE), env={})
    s = load_settings(
        _toml(tmp_path, 'bind_host = "0.0.0.0"\nallow_non_loopback = true\n' + BASE), env={}
    )
    assert s.bind_host == "0.0.0.0"


def test_pin_mode_requires_fingerprint(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(_toml(tmp_path, '[dsm]\nhost = "h"\ntls_mode = "pin"\n'), env={})


def test_hostname_mode_requires_server_name(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(_toml(tmp_path, '[dsm]\nhost = "h"\ntls_mode = "hostname"\n'), env={})


def test_unknown_tls_mode_refused(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(_toml(tmp_path, '[dsm]\nhost = "h"\ntls_mode = "off"\n'), env={})


def test_missing_file_uses_env_only(tmp_path):
    s = load_settings(
        None,
        env={
            "NAS_AGENT_DATA_DIR": str(tmp_path),
            "NAS_AGENT_DSM_HOST": "h",
            "NAS_AGENT_DSM_TLS_MODE": "hostname",
            "NAS_AGENT_DSM_TLS_SERVER_NAME": "nas.example.org",
        },
    )
    assert s.data_dir == tmp_path
    assert s.dsm.tls_server_name == "nas.example.org"


def test_fingerprint_normalized(tmp_path):
    s = load_settings(_toml(tmp_path, BASE), env={})
    assert s.dsm.tls_fingerprint == "ab" + "cd" * 31


def test_bad_fingerprint_refused(tmp_path):
    body = '[dsm]\nhost = "h"\ntls_mode = "pin"\ntls_fingerprint = "xyz"\n'
    with pytest.raises(ConfigError):
        load_settings(_toml(tmp_path, body), env={})


def test_audit_thresholds_default_and_override(tmp_path):
    s = load_settings(_toml(tmp_path, BASE), env={})
    a = s.audit
    assert (a.volume_warning_pct, a.volume_failure_pct) == (80, 90)
    assert (a.certificate_min_days, a.backup_max_age_hours) == (30, 26)
    assert (a.integrity_max_age_days, a.advisor_max_age_days) == (35, 30)
    s = load_settings(_toml(tmp_path, BASE + "[audit]\nvolume_warning_pct = 70\n"), env={})
    assert (s.audit.volume_warning_pct, s.audit.volume_failure_pct) == (70, 90)


def test_audit_thresholds_of_the_2026_11_26_checks(tmp_path):
    a = load_settings(_toml(tmp_path, BASE), env={}).audit
    assert (a.cpu_warning_pct, a.memory_warning_pct) == (90, 90)
    assert (a.disk_temperature_warning_c, a.disk_temperature_failure_c) == (50, 60)
    assert (a.system_temperature_warning_c, a.unreachable_minutes) == (70, 5)
    assert (a.scrubbing_max_age_days, a.password_min_length) == (180, 10)
    assert (a.login_failures_warning, a.login_burst, a.mass_change_count) == (10, 20, 200)
    assert a.pc_backup_max_age_days == 7


@pytest.mark.parametrize(
    "body",
    [
        "volume_warning_pct = 95",  # au-dessus du seuil d'échec
        "volume_failure_pct = 101",
        "backup_max_age_hours = 0",
        "certificate_min_days = -1",
        "unknown_threshold = 3",
        "cpu_warning_pct = 101",
        "disk_temperature_warning_c = 65",  # au-dessus du seuil d'échec
        "unreachable_minutes = 0",
        "login_burst = 0",
    ],
)
def test_audit_thresholds_refused(tmp_path, body):
    with pytest.raises(ConfigError):
        load_settings(_toml(tmp_path, BASE + f"[audit]\n{body}\n"), env={})


def test_history_is_on_by_default_and_can_be_turned_off(tmp_path):
    s = load_settings(_toml(tmp_path, 'data_dir = "/data"\n' + BASE), env={})
    assert s.history.enabled is True and s.history_path == Path("/data/history.db")
    off = load_settings(_toml(tmp_path, BASE + "[history]\nenabled = false\n"), env={})
    assert off.history.enabled is False
    with pytest.raises(ConfigError):
        load_settings(_toml(tmp_path, BASE + "[history]\nretention = 3\n"), env={})


def test_project_environment_opens_the_bind_and_names_the_console_token(tmp_path):
    # Le projet du moteur (conception 2026-11-25) : l'agent écoute sur le réseau du projet,
    # avec l'accord écrit dans l'environnement, et garde le jeton de la console à jour.
    s = load_settings(
        _toml(tmp_path, BASE),
        env={
            "NAS_AGENT_BIND_HOST": "0.0.0.0",
            "NAS_AGENT_ALLOW_NON_LOOPBACK": "1",
            "NAS_AGENT_CONSOLE_TOKEN_FILE": "/shared/console-token",
            "NAS_AGENT_CONSOLE_CIDR": "172.29.54.0/24",
        },
    )
    assert s.allow_non_loopback is True
    assert s.console_token_file == Path("/shared/console-token")
    assert s.console_cidrs == ["172.29.54.0/24"]


def test_allow_non_loopback_from_the_environment_must_say_yes(tmp_path):
    with pytest.raises(ConfigError):
        load_settings(
            _toml(tmp_path, BASE),
            env={"NAS_AGENT_BIND_HOST": "0.0.0.0", "NAS_AGENT_ALLOW_NON_LOOPBACK": "0"},
        )
