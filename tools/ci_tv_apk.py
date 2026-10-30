"""Deterministic native-input fingerprint, CI version allocation and private signing setup."""

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
from pathlib import Path

MAX_VERSION = 2100000000


def native_inputs(root):
    settings = (root / "apps/tv/settings.gradle.kts").read_text()
    modules = set()
    for declaration in re.findall(r"include\s*\((.*?)\)", settings, re.DOTALL):
        modules.update(re.findall(r'"(:[A-Za-z0-9_:-]+)"', declaration))
    if ":client" not in modules or "projectDir" in settings:
        raise ValueError(
            "Native fingerprint requires explicit Gradle module paths including :client"
        )
    directories = [
        root / "apps/tv" / module.lstrip(":").replace(":", "/")
        for module in sorted(modules)
    ]
    directories += [root / "apps/tv/buildSrc", root / "apps/tv/gradle"]
    files = []
    for directory in directories:
        if not directory.is_dir():
            raise ValueError(f"Missing native build input directory: {directory}")
        for path in directory.rglob("*"):
            relative = path.relative_to(directory)
            if relative.parts[0] in {"build", ".gradle", ".kotlin", ".idea"}:
                continue
            if relative.parts[:2] in {
                ("src", "test"),
                ("src", "androidTest"),
                ("src", "testFixtures"),
            }:
                continue
            if len(relative.parts) == 1 and path.suffix == ".md":
                continue
            if path.name == "AGENTS.md":
                continue
            if path.name in {
                "local.properties",
                "release.properties",
                "keystore.properties",
                ".DS_Store",
            } or path.suffix in {".jks", ".keystore"}:
                continue
            if path.is_symlink():
                raise ValueError(f"Native input symlink is unsupported: {path}")
            if path.is_file():
                files.append(path)
    for name in (
        "build.gradle.kts",
        "settings.gradle.kts",
        "gradle.properties",
        "gradlew",
        "gradlew.bat",
        "detekt.yaml",
    ):
        path = root / "apps/tv" / name
        if path.is_file():
            files.append(path)
    for name in (
        "ci_tv_apk.py",
        "tv-apk-build.json",
        "build-tv-client.sh",
        "package-startup-sound.py",
        "android-env.sh",
    ):
        path = root / "tools" / name
        if not path.is_file():
            raise ValueError(f"Missing APK build recipe: {path}")
        files.append(path)
    return sorted(set(files), key=lambda path: path.relative_to(root).as_posix())


def fingerprint(root):
    digest = hashlib.sha256(b"molly-tv-native-v1\0")
    inputs = native_inputs(root)
    for path in inputs:
        name = path.relative_to(root).as_posix().encode()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update((path.stat().st_mode & 0o111 != 0).to_bytes(1, "big"))
        with path.open("rb") as handle:
            content = hashlib.file_digest(handle, "sha256").digest()
        digest.update(content)
    return digest.hexdigest(), [path.relative_to(root).as_posix() for path in inputs]


def version_defaults(root):
    values = {}
    for line in (root / "apps/tv/client/version.properties").read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        if key.strip() in values:
            raise ValueError("Duplicate Android version property")
        values[key.strip()] = value.strip()
    code = int(values["versionCode"])
    name = values["versionName"]
    if not 0 < code <= MAX_VERSION or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}", name
    ):
        raise ValueError("Invalid Android version defaults")
    epoch = values.get("versionEpoch", "")
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", epoch):
        raise ValueError("versionEpoch must be YYYY-MM")
    if not re.fullmatch(r"(0|[1-9]\d*)\.[1-9]\d*\.[1-9]\d*", name):
        raise ValueError("versionName must be major.month.release")
    return code, name, epoch


def release_version(state, default_name, epoch, release_date):
    """Allocate from published history, including releases preceding a rollback."""
    names = state.get("versionNames")
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise ValueError("APK state needs versionNames; update the deployment receiver")
    major = int(default_name.split(".")[0])
    year, month = map(int, epoch.split("-"))
    month_index = (release_date.year - year) * 12 + release_date.month - month + 1
    if month_index < 1:
        raise ValueError("Release date precedes versionEpoch")
    sequence = 0
    for name in names:
        match = re.fullmatch(r"(0|[1-9]\d*)\.([1-9]\d*)\.([1-9]\d*)", name)
        if not match:
            continue  # Legacy versions such as 0.4.0+11 do not use the new scheme.
        previous_major, previous_month, previous_sequence = map(int, match.groups())
        if previous_major > major or (previous_major == major and previous_month > month_index):
            raise ValueError("Release version would go backwards; check major and release date")
        if previous_major == major and previous_month == month_index:
            sequence = max(sequence, previous_sequence)
    return f"{major}.{month_index}.{sequence + 1}"


def plan(root, state, commit, force=False, release_date=None):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("CI source commit must be a full SHA")
    current = state.get("current")
    highest = state.get("highestVersionCode")
    if type(highest) is not int or not 0 <= highest <= MAX_VERSION:
        raise ValueError("Invalid published APK version state")
    if current is not None:
        if (
            type(current.get("versionCode")) is not int
            or not 0 < current["versionCode"] <= highest
            or not re.fullmatch(r"[a-f0-9]{64}", current.get("sha256", ""))
        ):
            raise ValueError("Invalid current APK state")
        previous = current.get("sourceFingerprint")
        if previous is not None and not re.fullmatch(r"[a-f0-9]{64}", previous):
            raise ValueError("Invalid native fingerprint baseline")
    digest, inputs = fingerprint(root)
    required = force or current is None or current.get("sourceFingerprint") != digest
    minimum, name, epoch = version_defaults(root)
    if release_date is None:
        release_date = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()
    name = release_version(state, name, epoch, release_date) if required else current.get("versionName")
    if not isinstance(name, str) or not name:
        raise ValueError("APK state needs current versionName; update the deployment receiver")
    code = max(minimum, highest) + 1 if required else current["versionCode"]
    if code > MAX_VERSION:
        raise ValueError("Android versionCode range is exhausted")
    return {
        "schemaVersion": 1,
        "requiresApk": required,
        "sourceCommit": commit,
        "sourceFingerprint": digest,
        "versionCode": code,
        "versionName": name,
        "expectedRelease": None
        if current is None
        else {"versionCode": current["versionCode"], "sha256": current["sha256"]},
        "reason": "forced"
        if force
        else "no-baseline"
        if current is None or not current.get("sourceFingerprint")
        else "native-inputs-changed"
        if required
        else "native-inputs-unchanged",
        "inputCount": len(inputs),
    }


def property_value(value):
    escaped = []
    for character in value:
        if character in "\\ :=#!":
            escaped.append("\\" + character)
        elif character in "\r\n\t":
            escaped.append({"\r": "\\r", "\n": "\\n", "\t": "\\t"}[character])
        elif not 32 <= ord(character) < 127:
            units = character.encode("utf-16-be")
            escaped.extend(
                "\\u" + units[index : index + 2].hex()
                for index in range(0, len(units), 2)
            )
        else:
            escaped.append(character)
    return "".join(escaped)


def signing_files(directory):
    fields = {
        "storePassword": "MOLLYTIME_TV_STORE_PASSWORD",
        "keyPassword": "MOLLYTIME_TV_KEY_PASSWORD",
    }
    values = {
        key: os.environ.get(environment, "") for key, environment in fields.items()
    }
    encoded = os.environ.get("MOLLYTIME_TV_KEYSTORE_BASE64", "")
    if not encoded or not all(values.values()):
        raise ValueError(
            "Configure MOLLYTIME_TV_KEYSTORE_BASE64, MOLLYTIME_TV_STORE_PASSWORD and MOLLYTIME_TV_KEY_PASSWORD secrets"
        )
    keystore = base64.b64decode(encoded, validate=True)
    if not 0 < len(keystore) <= 128 * 1024:
        raise ValueError("Invalid CI keystore size")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name, data in (
        ("release.jks", keystore),
        (
            "release.properties",
            (
                "storeFile=release.jks\n"
                + "keyAlias="
                + property_value(
                    os.environ.get("MOLLYTIME_TV_KEY_ALIAS") or "mollytime"
                )
                + "\n"
                + "".join(
                    key + "=" + property_value(value) + "\n"
                    for key, value in values.items()
                )
            ).encode("ascii"),
        ),
    ):
        fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("plan")
    build.add_argument("--root", type=Path, default=Path.cwd())
    build.add_argument("--state", type=Path, required=True)
    build.add_argument("--commit", required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--force", choices=("true", "false"), default="false")
    signing = commands.add_parser("prepare-signing")
    signing.add_argument("--directory", type=Path, required=True)
    cleanup = commands.add_parser("cleanup-signing")
    cleanup.add_argument("--directory", type=Path, required=True)
    verify = commands.add_parser("verify-inputs")
    verify.add_argument("--root", type=Path, default=Path.cwd())
    verify.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare-signing":
        signing_files(args.directory)
    elif args.command == "cleanup-signing":
        for name in ("release.jks", "release.properties"):
            (args.directory / name).unlink(missing_ok=True)
    elif args.command == "verify-inputs":
        expected = json.loads(args.plan.read_text())["sourceFingerprint"]
        if fingerprint(args.root.resolve())[0] != expected:
            raise ValueError(
                "Native inputs changed after CI planning; refuse to publish this APK"
            )
    else:
        result = plan(
            args.root.resolve(),
            json.loads(args.state.read_text()),
            args.commit,
            args.force == "true",
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
        recipe = json.loads((args.root / "tools/tv-apk-build.json").read_text())
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as handle:
                handle.writelines(
                    f"{key}={value}\n"
                    for key, value in {
                        "required": str(result["requiresApk"]).lower(),
                        "version_code": result["versionCode"],
                        "version_name": result["versionName"],
                        "java_version": recipe["javaVersion"],
                        "compile_sdk": recipe["compileSdk"],
                        "build_tools": recipe["buildTools"],
                    }.items()
                )
        print(
            f"APK build required: {result['requiresApk']}; reason: {result['reason']}; versionCode: {result['versionCode']}"
        )


if __name__ == "__main__":
    main()
