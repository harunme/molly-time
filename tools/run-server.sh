#!/usr/bin/env bash
# Run the MollyTime server with uvicorn. Defaults to 127.0.0.1:8096.
# Override via MOLLYTIME_LISTEN_HOST / MOLLYTIME_LISTEN_PORT env vars.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$ROOT/apps/server/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  bash "$ROOT/tools/build-server.sh"
fi

# Make all MollyTime paths absolute so the service is invariant to CWD.
export MOLLYTIME_DATA_DIR="${MOLLYTIME_DATA_DIR:-${MOLLY_DATA_DIR:-$ROOT/.local/molly-server}}"
# Uploaded media defaults to $MOLLYTIME_DATA_DIR/media; MOLLYTIME_MEDIA_DIR can override it.

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

cd "$ROOT/apps/server"
exec python -m mollytime_server.main