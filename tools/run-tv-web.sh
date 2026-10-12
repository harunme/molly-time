#!/usr/bin/env bash
# Daily TV UI development: start only the Vite web server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/tv/web"
if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi
exec pnpm dev "$@"
