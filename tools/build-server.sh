#!/usr/bin/env bash
# Bootstrap a Python venv for the MollyTime server and install dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/apps/server"
VENV_DIR="$SERVER_DIR/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

python -m pip install --upgrade pip >/dev/null
python -m pip install -e "$SERVER_DIR[dev]"

echo "mollytime-server ready: $VENV_DIR"