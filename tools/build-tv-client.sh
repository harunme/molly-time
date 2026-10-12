#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
bash "$MOLLYTIME_ROOT/tools/build-tv-web.sh"
BUILD_TYPE="${1:-debug}"
case "$BUILD_TYPE" in
  debug) GRADLE_TASK=assembleDebug ;;
  release) GRADLE_TASK=assembleRelease ;;
  *) echo "Usage: bash tools/build-tv-client.sh [debug|release]" >&2; exit 2 ;;
esac
if [[ $# -gt 0 ]]; then shift; fi
cd "$MOLLYTIME_ROOT/apps/tv"
./gradlew ":client:$GRADLE_TASK" "$@"
CLIENT_APK="client/build/outputs/apk/$BUILD_TYPE/client-$BUILD_TYPE.apk"
if [[ "$BUILD_TYPE" == release ]]; then
  "$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$CLIENT_APK"
fi
mkdir -p "$MOLLYTIME_ROOT/artifacts"
cp "$CLIENT_APK" "$MOLLYTIME_ROOT/artifacts/mollytime-tv-$BUILD_TYPE.apk"
echo "APK: $MOLLYTIME_ROOT/artifacts/mollytime-tv-$BUILD_TYPE.apk"
