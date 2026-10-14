"""Seoul receiver keeps MySQL data and the previous image on failed releases."""

import importlib.util
import io
from pathlib import Path
import tarfile
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


def test_failed_publication_restores_previous_seoul_image_and_env(tmp_path):
    root = tmp_path / "server"
    root.mkdir()
    original_env = "MOLLYTIME_RELEASE=" + "a" * 40 + "\nMOLLYTIME_AUTH_SECRET=keep\n"
    (root / ".env").write_text(original_env)
    for name in (".env.mysql", "data", "mysql-data", "caddy-data", "caddy-config"):
        path = root / name
        path.write_text("secret") if name.startswith(".") else path.mkdir()
    calls = []

    def compose(path, tag, *args):
        calls.append((tag, args))

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    with patch.multiple(deploy, ROOT=root, STATE=root / "state.json", LOCK=root / "deploy.lock"), \
            patch.object(deploy.common, "ROOT", root), \
            patch.object(deploy, "compose", side_effect=compose), \
            patch.object(deploy, "run"), \
            patch.object(deploy.common, "validate_plan", return_value={"requiresApk": False}), \
            patch.object(deploy.common, "publish_apk", side_effect=RuntimeError("publish failed")), \
            patch.object(deploy.urllib.request, "urlopen", return_value=Response()), \
            patch.object(deploy.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024**3)), \
            patch.object(deploy.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(release_archive()))):
        with pytest.raises(RuntimeError, match="publish failed"):
            deploy.receive("b" * 40)
    assert (root / ".env").read_text() == original_env
    assert not (root / "state.json").exists()
    assert calls[-1][0] == "a" * 40
    assert calls[-1][1][:2] == ("up", "-d")
