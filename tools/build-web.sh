#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/web"
pnpm install --frozen-lockfile
pnpm build
bash "$ROOT/tools/build-site.sh"
