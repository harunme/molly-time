#!/usr/bin/env bash
# Initialise SQLite schema and create admin user.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Make all MollyTime paths absolute so the service is invariant to CWD.
export MOLLYTIME_DATA_DIR="${MOLLYTIME_DATA_DIR:-${MOLLY_DATA_DIR:-$ROOT/.local/molly-server}}"

VENV_DIR="$ROOT/apps/server/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
  bash "$ROOT/tools/build-server.sh"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

cd "$ROOT/apps/server"
python -m mollytime_server.scripts init_db
python -m mollytime_server.scripts create_admin
