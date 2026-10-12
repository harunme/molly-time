#!/usr/bin/env bash
# Run the Molly server with uvicorn. Defaults to 127.0.0.1:8096.
# Override via MOLLY_LISTEN_HOST / MOLLY_LISTEN_PORT env vars.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$ROOT/apps/server/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  bash "$ROOT/tools/build-server.sh"
fi

# Make all Molly paths absolute so the service is invariant to CWD.
export MOLLY_DATA_DIR="${MOLLY_DATA_DIR:-$ROOT/.local/molly-server}"
# Uploaded media defaults to $MOLLY_DATA_DIR/media; MOLLY_MEDIA_DIR can override it.

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

cd "$ROOT/apps/server"
exec python -m molly_server.main