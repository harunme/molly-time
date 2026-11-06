#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Ship the same verified launch sound as the native clients. Playback itself
# uses the static, content-hashed asset and never waits for the startup API.
if [[ -n "${MOLLYTIME_STARTUP_CONFIG:-}" ]]; then
  python3 "$ROOT/tools/package-startup-sound.py" --config "$MOLLYTIME_STARTUP_CONFIG" --output "$ROOT/apps/site/src/assets"
else
  python3 "$ROOT/tools/package-startup-sound.py" --source "${MOLLYTIME_STARTUP_SOURCE:-https://mollytime.app}" --output "$ROOT/apps/site/src/assets"
fi
pnpm --dir "$ROOT/apps/site" install --frozen-lockfile
pnpm --dir "$ROOT/apps/site" build
# Existing release archives already carry apps/web/dist, including this subdirectory.
rm -rf "$ROOT/apps/web/dist/site"
mkdir -p "$ROOT/apps/web/dist/site"
cp -R "$ROOT/apps/site/dist/." "$ROOT/apps/web/dist/site/"
test -s "$ROOT/apps/web/dist/site/index.html"
