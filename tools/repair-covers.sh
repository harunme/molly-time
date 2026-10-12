#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MOLLYTIME_DATA_DIR="${MOLLYTIME_DATA_DIR:-${MOLLY_DATA_DIR:-$ROOT/.local/molly-server}}"
cd "$ROOT/apps/server"
exec "$ROOT/apps/server/.venv/bin/python" -m mollytime_server.repair_covers "$@"
