"""Snapshot the operator's launch sound into immutable APK assets, never at runtime."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.request

MAX_AUDIO = 128 * 1024


def download(url, limit):
    failure = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=15) as response:
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise ValueError("Startup asset exceeds its size limit")
                return data
        except (OSError, urllib.error.URLError) as error:
            failure = error
    raise RuntimeError("Cannot obtain startup sound; refusing to build a silently incomplete APK") from failure


def package(output: Path, *, source=None, config_file=None, silent=False):
    if silent:
        config, audio = {"configured": False}, None
    elif config_file:
        record = json.loads(Path(config_file).read_text())
        config = {**record, "configured": bool(record)}
        audio = base64.b64decode(record["data"], validate=True) if record else None
    else:
        source = source.rstrip("/")
        config = json.loads(download(source + "/api/startup", 4096))
        audio = None
        if config.get("configured") is True:
            version = config.get("version", "")
            if not re.fullmatch(r"[a-f0-9]{64}", version):
                raise ValueError("Invalid startup sound version")
            # Ignore remote audioUrl: only fetch the same origin's known route.
            audio = download(source + "/api/startup/audio/" + version, MAX_AUDIO)
    if config.get("configured") is True:
        if not audio or len(audio) > MAX_AUDIO or hashlib.sha256(audio).hexdigest() != config.get("version"):
            raise ValueError("Startup sound checksum mismatch")
        if not isinstance(config.get("durationMs"), int) or not 0 < config["durationMs"] <= 5000:
            raise ValueError("Invalid startup sound duration")
        manifest = {key: config[key] for key in ("filename", "version", "durationMs")}
        manifest.update(configured=True, file="sound.mp3")
    elif config.get("configured") is False:
        manifest, audio = {"configured": False}, None
    else:
        raise ValueError("Invalid startup sound config; refusing to silently omit audio")
    directory = output / "startup"
    directory.mkdir(parents=True, exist_ok=True)
    # Do not overwrite an existing prepared package until the entire new one is verified.
    if audio:
        fd, temp = tempfile.mkstemp(dir=directory)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(audio)
            os.replace(temp, directory / "sound.mp3")
        finally:
            if os.path.exists(temp): os.unlink(temp)
    else:
        (directory / "sound.mp3").unlink(missing_ok=True)
    (directory / "config.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument("--source", default=None)
    choice.add_argument("--config", type=Path)
    choice.add_argument("--silent", action="store_true", help="Explicitly build a silent client for local development")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "apps/tv/client/build/generated/startupSoundAssets")
    args = parser.parse_args()
    config = package(args.output, source=args.source or "https://mollytime.app", config_file=args.config, silent=args.silent)
    print("Bundled startup sound:", config.get("filename", "silent (unconfigured)"), config.get("version", ""))


if __name__ == "__main__":
    main()
