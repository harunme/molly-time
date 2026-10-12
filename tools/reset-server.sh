#!/usr/bin/env bash
# Wipe .local/molly-server (schema + image cache) and legacy .local/jellyfin.
# Use with care: this is a destructive reset.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

read -r -p "Wipe $ROOT/.local/molly-server ? [y/N] " reply
if [[ "$reply" == "y" || "$reply" == "Y" ]]; then
  rm -rf "$ROOT/.local/molly-server"
  echo "removed .local/molly-server"
fi

read -r -p "Wipe legacy $ROOT/.local/jellyfin ? [y/N] " reply
if [[ "$reply" == "y" || "$reply" == "Y" ]]; then
  rm -rf "$ROOT/.local/jellyfin"
  echo "removed .local/jellyfin"
fi

bash "$ROOT/tools/init-server.sh"