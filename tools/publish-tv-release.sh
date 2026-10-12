#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-env.sh"
export MOLLYTIME_DATA_DIR="${MOLLYTIME_DATA_DIR:-${MOLLY_DATA_DIR:-$MOLLYTIME_ROOT/.local/molly-server}}"
export PYTHONPATH="$MOLLYTIME_ROOT/apps/server${PYTHONPATH:+:$PYTHONPATH}"
exec "$MOLLYTIME_ROOT/apps/server/.venv/bin/python" \
  -m mollytime_server.scripts.publish_tv_release \
  "$MOLLYTIME_ROOT/artifacts/mollytime-tv-release.apk" \
  --build-tools "$ANDROID_HOME/build-tools/36.0.0" "$@"
