#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
cd "$MOLLY_ROOT/apps/tv"
./gradlew :client:assembleDebug
mkdir -p "$MOLLY_ROOT/artifacts"
cp client/build/outputs/apk/debug/client-debug.apk "$MOLLY_ROOT/artifacts/molly-tv-webview-debug.apk"
