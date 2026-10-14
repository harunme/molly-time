"""Seoul receiver keeps MySQL data and the previous image on failed releases."""

import importlib.util
import io
from pathlib import Path
import tarfile
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest

spec = importlib.util.spec_from_file_location(
    "github_deploy_seoul", Path(__file__).resolve().parents[2] / "infra/github-deploy-seoul.py"
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def release_archive():
    output = io.BytesIO()
    names = deploy.common.FILES | {
        "apps/server/mollytime_server/main.py",
        "apps/web/dist/index.html",
        "apps/tv/web/dist/index.html",
        "artifacts/tv-client-plan.json",
    }
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name in names:
            item = tarfile.TarInfo(name)
            item.size = 4
            archive.addfile(item, io.BytesIO(b"test"))
    return output.getvalue()


def test_seoul_receiver_accepts_expected_archive_without_secrets(tmp_path):
    archive = tmp_path / "release.tar.gz"
    archive.write_bytes(release_archive())
    destination = tmp_path / "release"
    destination.mkdir()
    deploy.common.unpack(archive, destination)
    assert (destination / "infra/compose.seoul.yaml").exists()
    assert not (destination / ".env").exists()


@pytest.mark.parametrize("failure", [None, "publish", "https"])
def test_deployment_skips_backup_and_preserves_rollback(tmp_path, failure):
    root = tmp_path / "server"
    root.mkdir()
    (root / "infra").mkdir()
    original_env = "MOLLYTIME_RELEASE=" + "a" * 40 + "\nMOLLYTIME_AUTH_SECRET=keep\n"
    (root / ".env").write_text(original_env)
    for name in (".env.mysql", "data", "mysql-data", "caddy-data", "caddy-config"):
        path = root / name
        path.write_text("secret") if name.startswith(".") else path.mkdir()
    calls = []

    def compose(path, tag, *args):
        calls.append((tag, args))

    with patch.multiple(deploy, ROOT=root, STATE=root / "state.json", LOCK=root / "deploy.lock"), \
            patch.object(deploy.common, "ROOT", root), \
            patch.object(deploy, "compose", side_effect=compose), \
            patch.object(deploy, "run") as run, \
            patch.object(deploy.common, "validate_plan", return_value={"requiresApk": False}), \
            patch.object(deploy.common, "publish_apk",
                         side_effect=RuntimeError("publish failed") if failure == "publish" else None) as publish, \
            patch.object(deploy, "verify_local_https",
                         side_effect=RuntimeError("https failed") if failure == "https" else None), \
            patch.object(deploy.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024**3)), \
            patch.object(deploy.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(release_archive()))):
        if failure:
            with pytest.raises(RuntimeError, match=failure + " failed"):
                deploy.receive("b" * 40)
        else:
            deploy.receive("b" * 40)
        run.assert_not_called()
        if failure == "https":
            publish.assert_not_called()
    if failure is None:
        assert "MOLLYTIME_RELEASE=" + "b" * 40 in (root / ".env").read_text()
        assert (root / "state.json").exists()
        assert (root / "infra/backup-seoul.sh").read_bytes() == b"test"
        assert calls[-1][0] == "b" * 40
        return
    assert (root / ".env").read_text() == original_env
    assert not (root / "state.json").exists()
    assert calls[-1][0] == "a" * 40
    assert calls[-1][1][:2] == ("up", "-d")


def test_local_https_checks_run_in_parallel_with_tls_and_request_limits():
    ready = threading.Barrier(4)
    urls = []

    def curl(command, **kwargs):
        urls.append(command[-1])
        assert command[command.index("--resolve") + 1] == "mollytime.app:443:127.0.0.1"
        assert command[command.index("--max-time") + 1] == "10"
        assert "--insecure" not in command
        assert kwargs["timeout"] == 15
        ready.wait(timeout=3)
        return SimpleNamespace(stdout=b"MollyTime\n200\ntext/html; charset=utf-8")

    with patch.object(deploy.subprocess, "run", side_effect=curl):
        deploy.verify_local_https()
    assert set(urls) == {"https://mollytime.app" + path for path in ("/healthz", "/manage/", "/tv/", "/")}


@pytest.mark.parametrize("response", [
    b"MollyTime\n503\ntext/html", b"Wrong site\n200\ntext/html",
    b"MollyTime\n200\napplication/json",
])
def test_local_https_rejects_bad_status_or_homepage(response):
    with patch.object(deploy.subprocess, "run", return_value=SimpleNamespace(stdout=response)):
        with pytest.raises(RuntimeError):
            deploy.verify_local_https()


@pytest.mark.parametrize("error", [
    deploy.subprocess.CalledProcessError(28, ["curl"], stderr=b"request timed out"),
    deploy.subprocess.TimeoutExpired(["curl"], 15),
])
def test_local_https_reports_failed_route(error):
    with patch.object(deploy.subprocess, "run", side_effect=error):
        with pytest.raises(RuntimeError, match=r"Local HTTPS check .*: /"):
            deploy.verify_local_https()
