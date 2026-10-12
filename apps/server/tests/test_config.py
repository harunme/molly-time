from pathlib import Path

from mollytime_server.config import Settings


def test_legacy_environment_and_new_prefix_precedence(monkeypatch):
    monkeypatch.setenv("MOLLY_AUTH_SECRET", "legacy-secret")
    monkeypatch.setenv("MOLLY_DATA_DIR", "/tmp/legacy-library")
    monkeypatch.delenv("MOLLYTIME_AUTH_SECRET", raising=False)
    monkeypatch.delenv("MOLLYTIME_DATA_DIR", raising=False)
    legacy = Settings(_env_file=None)
    assert legacy.auth_secret == "legacy-secret"
    assert legacy.data_dir == Path("/tmp/legacy-library")

    monkeypatch.setenv("MOLLYTIME_AUTH_SECRET", "new-secret")
    monkeypatch.setenv("MOLLYTIME_DATA_DIR", "/tmp/new-library")
    current = Settings(_env_file=None)
    assert current.auth_secret == "new-secret"
    assert current.data_dir == Path("/tmp/new-library")


def test_legacy_dotenv_and_constructor_values(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text("MOLLY_LISTEN_PORT=8097\nMOLLYTIME_LISTEN_PORT=8098\n")
    assert Settings(_env_file=dotenv).listen_port == 8098
    assert Settings(_env_file=dotenv, listen_port=8099).listen_port == 8099
