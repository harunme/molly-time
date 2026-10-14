"""Restricted CI deployment receiver for the Seoul MySQL and Caddy stack."""

from __future__ import annotations

import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path("/opt/mollytime")
STATE = ROOT / "seoul-deployment-state.json"
LOCK = Path("/run/lock/mollytime-deploy-seoul.lock")

# Share the archive and APK validation with the established, tested receiver.
helper_path = Path(__file__).with_name("mollytime-deploy.py")
if not helper_path.exists():
    helper_path = Path(__file__).with_name("github-deploy.py")
spec = importlib.util.spec_from_file_location("mollytime_deploy_common", helper_path)
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
common.ROOT = ROOT
common.FILES = {
    "apps/server/pyproject.toml",
    "infra/Dockerfile.prebuilt",
    "infra/compose.seoul.yaml",
    "infra/Caddyfile.seoul",
    "infra/backup-seoul.sh",
    "tools/upload_mysql_backup.py",
}


def run(*command: str) -> None:
    subprocess.run(command, check=True)


def compose(path: Path, tag: str, *args: str) -> None:
    environment = dict(os.environ, MOLLYTIME_RELEASE=tag)
    subprocess.run(
        ["docker", "compose", "-p", "infra", "--env-file", str(ROOT / ".env"),
         "-f", str(path / "infra/compose.seoul.yaml"), *args],
        check=True,
        env=environment,
    )


common.compose = compose


def previous_release() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text())
    release = next(
        (line.split("=", 1)[1] for line in (ROOT / ".env").read_text().splitlines()
         if line.startswith("MOLLYTIME_RELEASE=")),
        "seoul",
    )
    return {"path": str(ROOT), "tag": release}


def set_release_tag(contents: str, tag: str) -> str:
    lines = contents.splitlines()
    found = any(line.startswith("MOLLYTIME_RELEASE=") for line in lines)
    lines = ["MOLLYTIME_RELEASE=" + tag if line.startswith("MOLLYTIME_RELEASE=") else line
             for line in lines]
    if not found:
        lines.append("MOLLYTIME_RELEASE=" + tag)
    return "\n".join(lines) + "\n"


def receive(tag: str, encoded_apk_url: str | None = None, apk_sha: str | None = None) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", tag):
        raise ValueError("Invalid release SHA")
    with LOCK.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if shutil.disk_usage(ROOT).free < 2 * 1024**3:
            raise RuntimeError("At least 2 GiB free disk space is required")
        previous = previous_release()
        releases = ROOT / "releases-seoul"
        releases.mkdir(exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix=tag + "-", dir=releases))
        archive = destination / "release.tar.gz"
        with archive.open("wb") as output:
            total = 0
            while chunk := sys.stdin.buffer.read(1024 * 1024):
                total += len(chunk)
                if total > 640 * 1024**2:
                    raise ValueError("Release archive is too large")
                output.write(chunk)
        common.unpack(archive, destination)
        if encoded_apk_url is not None:
            try:
                common.fetch_apk(destination, encoded_apk_url, apk_sha)
            except common.ArtifactDownloadError as error:
                print("ARTIFACT_DOWNLOAD_FAILED: " + str(error), file=sys.stderr)
                raise SystemExit(75) from error
        if shutil.disk_usage(ROOT).free < 2 * 1024**3 + archive.stat().st_size * 3:
            raise RuntimeError("Insufficient space to stage the release")
        plan = common.validate_plan(destination, tag)
        for name in (".env", ".env.mysql", "data", "mysql-data", "caddy-data", "caddy-config"):
            (destination / name).symlink_to(ROOT / name)
        (destination / ".dockerignore").write_text(
            ".env\n.env.mysql\ndata\nmysql-data\ncaddy-data\ncaddy-config\nartifacts\nrelease.tar.gz\n"
        )
        compose(destination, tag, "config", "--quiet")
        compose(destination, tag, "build", "mollytime-server")
        # Stop if the pre-deployment snapshot cannot be encrypted and uploaded.
        run("/usr/bin/flock", "-w", "600", "/var/lock/mollytime-backup.lock",
            str(ROOT / "infra/backup-seoul.sh"), "--force")
        original_env = (ROOT / ".env").read_text()
        original_state = STATE.read_text() if STATE.exists() else None
        try:
            compose(destination, tag, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "mollytime-server")
            for path in ("/healthz", "/manage/", "/tv/"):
                with urllib.request.urlopen("https://mollytime.app" + path, timeout=20) as response:
                    if response.status != 200:
                        raise RuntimeError("Public health check failed: " + path)
            common.atomic_write(ROOT / ".env", set_release_tag(original_env, tag))
            common.atomic_write(STATE, json.dumps({"path": str(destination), "tag": tag}) + "\n")
            common.publish_apk(destination, tag, plan)
            backup_script = ROOT / "infra/backup-seoul.sh"
            temporary = backup_script.with_suffix(".next")
            shutil.copy2(destination / "infra/backup-seoul.sh", temporary)
            os.chmod(temporary, 0o755)
            os.replace(temporary, backup_script)
        except Exception:
            common.atomic_write(ROOT / ".env", original_env)
            if original_state is None:
                STATE.unlink(missing_ok=True)
            else:
                common.atomic_write(STATE, original_state)
            print("Deployment failed; restoring previous Seoul application", flush=True)
            compose(Path(previous["path"]), previous["tag"], "up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "mollytime-server")
            raise
        print("Deployed Seoul " + tag, flush=True)


def main() -> None:
    if sys.argv[1:] == ["--apk-state"]:
        print(json.dumps(common.release_state()))
        return
    if len(sys.argv) == 2:
        receive(sys.argv[1])
    elif len(sys.argv) == 4:
        receive(sys.argv[1], sys.argv[2], sys.argv[3])
    else:
        raise ValueError("Invalid deployment arguments")


if __name__ == "__main__":
    main()
