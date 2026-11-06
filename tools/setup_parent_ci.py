"""Upgrade the fixed Seoul CI receiver for the independent parent APK channel.

Only deployment scripts are installed. Application code, signing Secrets,
release manifests, databases and running containers are untouched.
"""

import argparse
import hashlib
import io
from pathlib import Path
import subprocess
import tarfile

FILES = {
    "mollytime-deploy.py": "infra/github-deploy.py",
    "mollytime-deploy-seoul.py": "infra/github-deploy-seoul.py",
    "mollytime-github-deploy-seoul": "infra/github-deploy-seoul-gate.sh",
}


def receiver_archive(root):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, source in FILES.items():
            value = (root / source).read_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(value)
            info.mode = 0o755 if name.endswith("seoul") else 0o644
            archive.addfile(info, io.BytesIO(value))
    return output.getvalue()


INSTALL = r"""sudo -n /bin/sh -c '
set -eu
stage=$(mktemp -d /usr/local/lib/mollytime-parent-ci.XXXXXX)
trap '\''rm -rf "$stage"'\'' EXIT
tar -xzf - -C "$stage"
python3 -m py_compile "$stage/mollytime-deploy.py" "$stage/mollytime-deploy-seoul.py"
bash -n "$stage/mollytime-github-deploy-seoul"
exec 9>/run/lock/mollytime-deploy-seoul.lock
flock -x 9
python3 /usr/local/lib/mollytime-deploy-seoul.py --apk-state > "$stage/before.json"
python3 "$stage/mollytime-deploy-seoul.py" --apk-state > "$stage/after.json"
cmp "$stage/before.json" "$stage/after.json"
python3 "$stage/mollytime-deploy-seoul.py" --parent-apk-state > /dev/null
backup=$(mktemp -d /usr/local/lib/mollytime-parent-ci-backup.XXXXXX)
cp -p /usr/local/lib/mollytime-deploy.py /usr/local/lib/mollytime-deploy-seoul.py /usr/local/sbin/mollytime-github-deploy-seoul "$backup/"
installed=0
trap '\''if [ "$installed" = 0 ]; then cp -p "$backup/mollytime-deploy.py" /usr/local/lib/mollytime-deploy.py; cp -p "$backup/mollytime-deploy-seoul.py" /usr/local/lib/mollytime-deploy-seoul.py; cp -p "$backup/mollytime-github-deploy-seoul" /usr/local/sbin/mollytime-github-deploy-seoul; fi; rm -rf "$stage"'\'' EXIT
install -m 644 "$stage/mollytime-deploy.py" /usr/local/lib/mollytime-deploy.py.next
install -m 755 "$stage/mollytime-deploy-seoul.py" /usr/local/lib/mollytime-deploy-seoul.py.next
install -m 755 "$stage/mollytime-github-deploy-seoul" /usr/local/sbin/mollytime-github-deploy-seoul.next
mv /usr/local/lib/mollytime-deploy.py.next /usr/local/lib/mollytime-deploy.py
mv /usr/local/lib/mollytime-deploy-seoul.py.next /usr/local/lib/mollytime-deploy-seoul.py
mv /usr/local/sbin/mollytime-github-deploy-seoul.next /usr/local/sbin/mollytime-github-deploy-seoul
SSH_ORIGINAL_COMMAND=apk-state /usr/local/sbin/mollytime-github-deploy-seoul > "$stage/installed.json"
cmp "$stage/before.json" "$stage/installed.json"
SSH_ORIGINAL_COMMAND=parent-apk-state /usr/local/sbin/mollytime-github-deploy-seoul
installed=1
printf "Receiver installed; previous scripts retained at %s\n" "$backup"
'
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--identity", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    identity = (args.identity or root / ".local/deployment/mollytime-seoul").resolve()
    if not identity.is_file():
        parser.error("Provide the existing Seoul management SSH identity path")
    subprocess.run(
        [
            "ssh",
            "-i",
            str(identity),
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "UserKnownHostsFile=" + str(root / "infra/seoul-known-hosts"),
            "-o",
            "ConnectTimeout=15",
            "ubuntu@43.133.227.83",
            INSTALL,
        ],
        input=receiver_archive(root),
        check=True,
    )
    print(
        "Common receiver SHA-256: "
        + hashlib.sha256((root / "infra/github-deploy.py").read_bytes()).hexdigest()
    )


if __name__ == "__main__":
    main()
