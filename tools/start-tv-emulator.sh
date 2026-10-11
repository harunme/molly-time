#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME"
if [[ ! -f "$ANDROID_AVD_HOME/MollyTV.ini" ]]; then
    printf 'no\n' | avdmanager create avd --name MollyTV \
        --package 'system-images;android-34;android-tv;arm64-v8a' --device tv_1080p \
        --path "$ANDROID_AVD_HOME/MollyTV.avd"
fi
# Keep remote navigation, but allow mouse taps and Mac keyboard input for development.
python3 - "$ANDROID_AVD_HOME/MollyTV.avd/config.ini" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
lines = path.read_text().splitlines()
settings = {"hw.screen": "multi-touch", "hw.keyboard": "yes", "hw.dPad": "yes"}
lines = [line for line in lines if line.partition("=")[0] not in {*settings, "hw.touchScreen"}]
lines.extend(f"{key}={value}" for key, value in settings.items())
path.write_text("\n".join(lines) + "\n")
PY
exec emulator -avd MollyTV -no-snapshot -no-boot-anim -no-metrics -gpu auto "$@"
