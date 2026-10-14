#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pnpm --dir "$ROOT/apps/site" install --frozen-lockfile
pnpm --dir "$ROOT/apps/site" build
# Existing release archives already carry apps/web/dist, including this subdirectory.
rm -rf "$ROOT/apps/web/dist/site"
mkdir -p "$ROOT/apps/web/dist/site"
cp -R "$ROOT/apps/site/dist/." "$ROOT/apps/web/dist/site/"
test -s "$ROOT/apps/web/dist/site/index.html"
