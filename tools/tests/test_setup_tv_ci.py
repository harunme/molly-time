"""Bootstrap does not place private material in arguments, output or the server archive."""

import importlib.util
import io
import json
from pathlib import Path
import tarfile
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location("setup_tv_ci", Path(__file__).resolve().parents[1] / "setup_tv_ci.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def signing(root):
    directory = root / ".local/signing"
    directory.mkdir(parents=True)
    (directory / "release.jks").write_bytes(b"private-keystore")
    (directory / "release.properties").write_text("storeFile=release.jks\nstorePassword=private-password\nkeyPassword=private-password\nkeyAlias=mollytime\n")


def test_secrets_use_stdin_only(tmp_path, monkeypatch, capsys):
    signing(tmp_path)
    calls = []
    monkeypatch.setattr(setup.subprocess, "check_output", lambda *args, **kwargs: "[]")
    monkeypatch.setattr(setup.subprocess, "run", lambda args, **kwargs: calls.append((args, kwargs)))
    setup.configure_secrets(tmp_path, "owner/repo")
    assert len(calls) == 4
    assert all("private-password" not in str(args) and "private-keystore" not in str(args) for args, _ in calls)
    assert any(kwargs["input"] == "private-password" for _, kwargs in calls)
    assert "private-password" not in capsys.readouterr().out


def test_existing_partial_secrets_are_not_mixed(tmp_path, monkeypatch):
    signing(tmp_path)
    monkeypatch.setattr(setup.subprocess, "check_output", lambda *args, **kwargs: json.dumps([{"name": "MOLLYTIME_TV_KEYSTORE_BASE64"}]))
    with pytest.raises(ValueError, match="Partial"):
        setup.configure_secrets(tmp_path, "owner/repo")


def test_server_archive_contains_only_deployment_entrypoints(tmp_path, monkeypatch):
    directory = tmp_path / "infra"
    directory.mkdir()
    (directory / "github-deploy.py").write_text("receiver")
    (directory / "github-deploy-gate.sh").write_text("gate")
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout=b'{"highestVersionCode":3}')
    monkeypatch.setattr(setup.subprocess, "run", run)
    setup.install_receiver(tmp_path, "example.test", tmp_path / "admin.pem")
    with tarfile.open(fileobj=io.BytesIO(calls[0][1]["input"]), mode="r:gz") as archive:
        assert set(archive.getnames()) == {"mollytime-deploy.py", "mollytime-github-deploy"}
    assert "StrictHostKeyChecking=yes" in calls[0][0]
