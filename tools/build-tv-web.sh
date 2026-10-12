#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/tv/web"
pnpm install --frozen-lockfile
pnpm build
python3 "$ROOT/tools/package-tv-web.py"
