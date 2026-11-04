#!/usr/bin/env bash
set -euo pipefail

MOLLYTIME_IOS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOLLYTIME_IOS_RESOURCES="$MOLLYTIME_IOS_ROOT/apps/ios/MollyTime/Resources"

# Like the TV build, snapshot the published sound before packaging. A failed
# download or checksum aborts the build instead of silently shipping old audio.
if [[ -n "${MOLLYTIME_STARTUP_CONFIG:-}" ]]; then
  python3 "$MOLLYTIME_IOS_ROOT/tools/package-startup-sound.py" \
    --config "$MOLLYTIME_STARTUP_CONFIG" --output "$MOLLYTIME_IOS_RESOURCES"
else
  python3 "$MOLLYTIME_IOS_ROOT/tools/package-startup-sound.py" \
    --source "${MOLLYTIME_STARTUP_SOURCE:-https://mollytime.app}" --output "$MOLLYTIME_IOS_RESOURCES"
fi

if [[ $# -eq 0 ]]; then set -- build; fi
exec xcodebuild -project "$MOLLYTIME_IOS_ROOT/apps/ios/MollyTime.xcodeproj" \
  -scheme MollyTime "$@"
