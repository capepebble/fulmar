import tomllib

from synology_dsm.exceptions import (
    SynologyDSMLoginDisabledAccountException,
    SynologyDSMLoginInvalidException,
)

from nas_agent.dsm.credentials import load_credentials
from nas_agent.enroll import MAX_LOGIN_ATTEMPTS, run_enroll

FP = "ab" * 32


def answers(*values):
    pending = list(values)
    return lambda prompt: pending.pop(0)


def fetch(host, port):
    return "pem", FP


class Login:
    """Faux DSM : lève les erreurs données, puis accepte la connexion."""

    def __init__(self, *errors):
        self.errors = list(errors)
        self.usernames = []

    def __call__(self, dsm, creds, ask):
        self.usernames.append(creds.username)
        if self.errors:
            raise self.errors.pop(0)
        return "did-1"


def enroll(tmp_path, ask, login, secrets=("pw",) * MAX_LOGIN_ATTEMPTS):
    return run_enroll(tmp_path, [], ask=ask, ask_secret=answers(*secrets), fetch=fetch, login=login)


def test_enroll_writes_pinned_config_and_credentials(tmp_path):
    login = Login()
    assert enroll(tmp_path, answers("192.0.2.10", "", "", "y", "svc"), login) == 0
    config = tomllib.loads((tmp_path / "config.toml").read_text())
    assert config["dsm"] == {
        "host": "192.0.2.10",
        "port": 5001,
        "tls_mode": "pin",
        "tls_fingerprint": FP,
    }
    creds = load_credentials(tmp_path / "secrets" / "dsm.json")
    assert (creds.username, creds.password, creds.device_token) == ("svc", "pw", "did-1")


def test_empty_account_is_asked_again(tmp_path):
    login = Login()
    assert enroll(tmp_path, answers("192.0.2.10", "", "", "y", "", "  ", "svc"), login) == 0
    assert login.usernames == ["svc"]


def test_refused_login_can_be_retried(tmp_path, capsys):
    login = Login(SynologyDSMLoginInvalidException("svc"))
    ask = answers("192.0.2.10", "", "", "y", "svc", "svc")
    assert enroll(tmp_path, ask, login, secrets=("faux", "pw")) == 0
    out = capsys.readouterr().out
    assert "code 400" in out and "wrong password" in out
    assert load_credentials(tmp_path / "secrets" / "dsm.json").password == "pw"


def test_gives_up_after_max_attempts_without_writing(tmp_path, capsys):
    errors = [SynologyDSMLoginDisabledAccountException("svc")] * MAX_LOGIN_ATTEMPTS
    ask = answers("192.0.2.10", "", "", "y", *["svc"] * MAX_LOGIN_ATTEMPTS)
    assert enroll(tmp_path, ask, Login(*errors)) == 1
    assert "account disabled" in capsys.readouterr().out
    assert not (tmp_path / "config.toml").exists()
    assert not (tmp_path / "secrets").exists()


def test_certificate_is_asked_with_the_name_when_dsm_is_reached_by_name():
    # Un serveur qui sert plusieurs noms (proxy inversé, tailscale serve) exige le nom (SNI).
    from nas_agent.enroll import sni_for

    assert sni_for("nas.example.org") == "nas.example.org"
    assert sni_for("192.0.2.10") is None
    assert sni_for("fd7a:115c:a1e0::1") is None
