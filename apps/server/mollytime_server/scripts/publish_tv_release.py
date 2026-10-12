"""Publish a signed APK and atomically advance the release manifest."""

import argparse
import datetime as dt
import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..ci_release_plan import CiReleasePlan
from ..client_releases import (
    MAX_APK_BYTES,
    ClientRelease,
    archive_release,
    local_apk,
    manifest_path,
    publication_lock,
    read_release,
    release_dir,
)
from ..config import get_settings
from ..storage import build_storage


def tool_environment() -> dict:
    env = os.environ.copy()
    java_home = get_settings().android_java_home
    # Match the existing macOS Android development environment when JAVA_HOME is unset.
    local_java = Path("/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home")
    if java_home:
        env["JAVA_HOME"] = str(java_home)
    elif not env.get("JAVA_HOME") and local_java.is_dir():
        env["JAVA_HOME"] = str(local_java)
    return env


def inspect_apk(apk: Path, build_tools: Path) -> dict:
    signature = subprocess.run(
        [str(build_tools / "apksigner"), "verify", "--print-certs", str(apk)],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
        env=tool_environment(),
    )
    badging = subprocess.check_output(
        [str(build_tools / "aapt"), "dump", "badging", str(apk)],
        text=True,
        stderr=subprocess.PIPE,
        timeout=30,
        env=tool_environment(),
    )
    package = re.search(
        r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging, re.MULTILINE
    )
    sdk = re.search(r"^sdkVersion:'(\d+)'", badging, re.MULTILINE)
    if not package or not sdk:
        raise ValueError("APK package/version/minSdk metadata is missing")
    signers = sorted(
        set(
            re.findall(
                r"^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$",
                signature.stdout,
                re.MULTILINE,
            )
        )
    )
    if not signers:
        raise ValueError("APK signing certificate is missing")
    return {
        "packageName": package[1],
        "versionCode": int(package[2]),
        "versionName": package[3],
        "minSdk": int(sdk[1]),
        "signerSha256": [signer.lower() for signer in signers],
    }


def publish(
    apk: Path, storage: str, notes: str, build_tools: Path, ci_plan: CiReleasePlan | None = None
) -> ClientRelease:
    directory = release_dir()
    directory.mkdir(parents=True, exist_ok=True)
    # Serialize publishers and inspect/hash/upload the same frozen snapshot.
    with publication_lock():
        previous = read_release("com.molly.tv") if ci_plan else None
        if ci_plan and (not ci_plan.requiresApk or not ci_plan.matches(previous)):
            raise ValueError("Published APK changed after CI planning; rerun the workflow")
        if not apk.is_file() or not 0 < apk.stat().st_size <= MAX_APK_BYTES:
            raise ValueError("APK is missing or exceeds 512 MiB")
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            snapshot = Path(temporary) / "release.apk"
            shutil.copyfile(apk, snapshot)
            metadata = inspect_apk(snapshot, build_tools)
            if ci_plan and (
                metadata["packageName"] != "com.molly.tv"
                or metadata["versionCode"] != ci_plan.versionCode
                or metadata["versionName"] != ci_plan.versionName
            ):
                raise ValueError("APK metadata does not match the CI release plan")
            previous = read_release(metadata["packageName"])
            if storage == "auto":
                from ..storage.settings import get_storage_settings

                storage = previous.storage if previous else get_storage_settings().storage_backend
            with snapshot.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            release = ClientRelease(
                **metadata,
                size=snapshot.stat().st_size,
                sha256=digest,
                notes=notes,
                storage=storage,
                publishedAt=dt.datetime.now(dt.UTC).isoformat(),
                sourceFingerprint=ci_plan.sourceFingerprint if ci_plan else None,
                sourceCommit=ci_plan.sourceCommit if ci_plan else None,
                key=f"releases/tv/{metadata['packageName']}/{metadata['versionCode']}/{digest}.apk",
            )
            previous = read_release(release.packageName)
            if previous:
                same_artifact = release.model_dump(
                    exclude={
                        "notes",
                        "storage",
                        "publishedAt",
                        "signerSha256",
                        "sourceFingerprint",
                        "sourceCommit",
                    }
                ) == previous.model_dump(
                    exclude={
                        "notes",
                        "storage",
                        "publishedAt",
                        "signerSha256",
                        "sourceFingerprint",
                        "sourceCommit",
                    }
                )
                if release.versionCode < previous.versionCode or (
                    release.versionCode == previous.versionCode and not same_artifact
                ):
                    raise ValueError("New APK versionCode must exceed the published version")
                if previous.signerSha256 and set(release.signerSha256) != set(
                    previous.signerSha256
                ):
                    raise ValueError("APK signing certificate does not match the published channel")
                if release.versionCode == previous.versionCode:
                    release = release.model_copy(
                        update={
                            "publishedAt": previous.publishedAt,
                            "sourceFingerprint": previous.sourceFingerprint,
                            "sourceCommit": previous.sourceCommit,
                        }
                    )
            if storage == "oss":
                cloud = build_storage("oss")
                cloud.put_file(release.key, snapshot, "application/vnd.android.package-archive")
                if cloud.size(release.key) != release.size:
                    raise ValueError("Uploaded APK size mismatch")
            else:
                destination = local_apk(release)
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(snapshot, destination)
            if previous:
                archive_release(previous)
            archive_release(release)
            pending = Path(temporary) / "manifest.json"
            with pending.open("w") as handle:
                handle.write(release.model_dump_json(indent=2) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(pending, manifest_path(release.packageName))
            return release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--storage", choices=("local", "oss", "auto"), default="local")
    parser.add_argument("--ci-plan-file", type=Path)
    parser.add_argument("--notes", default="")
    parser.add_argument("--notes-file", type=Path)
    parser.add_argument("--build-tools", type=Path, required=True)
    args = parser.parse_args()
    notes = args.notes_file.read_text() if args.notes_file else args.notes
    try:
        ci_plan = (
            CiReleasePlan.model_validate_json(args.ci_plan_file.read_text())
            if args.ci_plan_file
            else None
        )
        release = publish(args.apk, args.storage, notes, args.build_tools, ci_plan)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release publication failed: {error}\n")
    print(
        f"Published {release.packageName} {release.versionName} (versionCode={release.versionCode})"
    )
    print(f"Storage: {release.storage}; object: {release.key}")


if __name__ == "__main__":
    main()
