#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
cd "$MOLLYTIME_ROOT/apps/tv"
./gradlew :client:assembleDebug
mkdir -p "$MOLLYTIME_ROOT/artifacts"
cp client/build/outputs/apk/debug/client-debug.apk "$MOLLYTIME_ROOT/artifacts/mollytime-tv-debug.apk"
