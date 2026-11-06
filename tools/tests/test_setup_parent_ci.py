import importlib.util
import io
from pathlib import Path
import shlex
import subprocess
import tarfile

spec = importlib.util.spec_from_file_location(
    "setup_parent_ci", Path(__file__).resolve().parents[1] / "setup_parent_ci.py"
)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def test_receiver_bundle_contains_only_fixed_scripts_and_no_credentials():
    root = Path(__file__).resolve().parents[2]
    with tarfile.open(
        fileobj=io.BytesIO(setup.receiver_archive(root)), mode="r:gz"
    ) as archive:
        assert set(archive.getnames()) == set(setup.FILES)
        for member in archive.getmembers():
            assert member.isfile() and member.mode in (0o644, 0o755)
            assert (
                archive.extractfile(member).read()
                == (root / setup.FILES[member.name]).read_bytes()
            )


def test_remote_install_uses_lock_rollback_and_valid_shell():
    command = shlex.split(setup.INSTALL)
    assert command[:4] == ["sudo", "-n", "/bin/sh", "-c"]
    subprocess.run(["sh", "-n"], input=command[4], text=True, check=True)
    assert command[4].index("flock -x 9") < command[4].index("--apk-state")
    assert "backup/mollytime-deploy.py" in command[4] and "installed=1" in command[4]
    assert "docker" not in command[4] and "parent-apk-state" in command[4]
