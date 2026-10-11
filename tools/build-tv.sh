#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
    echo "JDK 21 missing: $JAVA_HOME" >&2
    exit 1
fi
python3 "$MOLLY_ROOT/tools/prepare_samples.py"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$MOLLY_ROOT/apps/tv/local.properties"
cd "$MOLLY_ROOT/apps/tv"
./gradlew -Pjellyfin.version=0.19.10 :app:assembleDebug "$@"
mkdir -p "$MOLLY_ROOT/artifacts"
find app/build/outputs/apk/debug -name '*.apk' -exec cp {} "$MOLLY_ROOT/artifacts/molly-tv-preview.apk" \;
echo "APK: $MOLLY_ROOT/artifacts/molly-tv-preview.apk"
