#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
startup_args=(--source "${MOLLYTIME_STARTUP_SOURCE:-https://mollytime.app}")
if [[ -n "${MOLLYTIME_STARTUP_CONFIG:-}" ]]; then
    startup_args=(--config "$MOLLYTIME_STARTUP_CONFIG")
fi
python3 "$MOLLYTIME_ROOT/tools/package-startup-sound.py" "${startup_args[@]}" \
  --output "$MOLLYTIME_ROOT/apps/android/app/build/generated/startupSoundAssets"
BUILD_TYPE=debug
if [[ "${1:-}" == debug || "${1:-}" == release ]]; then BUILD_TYPE="$1"; shift; fi
case "$BUILD_TYPE" in
  debug) TASKS=(:app:lintDebug :app:assembleDebug) ;;
  release) TASKS=(:app:lintRelease :app:assembleRelease) ;;
esac
case "${MOLLYTIME_ANDROID_RUN_TESTS:-0}" in
  1) TASKS=(:app:testDebugUnitTest "${TASKS[@]}") ;;
  0) ;;
  *) echo "MOLLYTIME_ANDROID_RUN_TESTS must be 0 or 1" >&2; exit 2 ;;
esac
cd "$MOLLYTIME_ROOT/apps/android"
./gradlew "${TASKS[@]}" "$@"
CLIENT_APK="app/build/outputs/apk/$BUILD_TYPE/app-$BUILD_TYPE.apk"
if [[ "$BUILD_TYPE" == release ]]; then
  "$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$CLIENT_APK"
fi
mkdir -p "$MOLLYTIME_ROOT/artifacts"
cp "$CLIENT_APK" "$MOLLYTIME_ROOT/artifacts/mollytime-android-$BUILD_TYPE.apk"
echo "APK: $MOLLYTIME_ROOT/artifacts/mollytime-android-$BUILD_TYPE.apk"
