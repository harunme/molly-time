#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
APK="$MOLLY_ROOT/artifacts/molly-tv-preview.apk"
if [[ ! -f "$APK" ]]; then
    echo "Run bash tools/build-tv.sh first." >&2
    exit 1
fi
adb -e install -r "$APK"
adb -e shell am start -n tv.molly.app.debug/org.jellyfin.androidtv.molly.MollyHomeActivity
