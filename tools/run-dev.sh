#!/usr/bin/env bash
# Release development ports, then supervise the API and all web dev servers.
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v lsof >/dev/null 2>&1; then
  echo "make dev requires lsof to find processes occupying development ports." >&2
  exit 1
fi

listeners() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

release_port() {
  local port="$1" pids remaining pid attempt
  pids="$(listeners "$port")"
  [[ -n "$pids" ]] || return 0

  echo "[dev] Port $port is occupied; stopping PID(s): $(echo "$pids" | tr '\n' ' ')"
  # Only signal listening processes; established client connections are excluded.
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  for ((attempt = 0; attempt < 50; attempt++)); do
    [[ -n "$(listeners "$port")" ]] || return 0
    sleep 0.1
  done

  remaining="$(listeners "$port")"
  for pid in $remaining; do
    # Do not kill a new process that acquired the port during the wait.
    if [[ $'\n'"$pids"$'\n' == *$'\n'"$pid"$'\n'* ]]; then
      echo "[dev] PID $pid still occupies port $port; sending SIGKILL."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  for ((attempt = 0; attempt < 20; attempt++)); do
    [[ -n "$(listeners "$port")" ]] || return 0
    sleep 0.1
  done
  echo "[dev] Could not release port $port; aborting startup." >&2
  return 1
}

api_port="${MOLLYTIME_LISTEN_PORT:-${MOLLY_LISTEN_PORT:-8096}}"
# Match the API's .env configuration when its environment is already installed.
if [[ -x "$ROOT/apps/server/.venv/bin/python" ]]; then
  api_port="$(cd "$ROOT/apps/server" && .venv/bin/python -c 'from mollytime_server.config import Settings; print(Settings().listen_port)')"
fi
for port in "$api_port" 5173 5174 4321; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
    echo "[dev] Invalid development port: $port" >&2
    exit 1
  fi
done
for port in "$api_port" 5173 5174 4321; do
  release_port "$port"
done

# All dev frontends must follow the API's configured port. Website app links
# go to Vite rather than the API's previously built static files.
export MOLLYTIME_API_PROXY="${MOLLYTIME_API_PROXY:-${MOLLY_API_PROXY:-http://127.0.0.1:$api_port}}"
export MOLLYTIME_WEB_PROXY="http://127.0.0.1:5174"
export MOLLYTIME_TV_PROXY="http://127.0.0.1:5173"

echo "[dev] Website: http://127.0.0.1:4321/"
echo "[dev] Parent:  http://127.0.0.1:5174/manage/"
echo "[dev] TV:      http://127.0.0.1:5173/tv/"
echo "[dev] API:     http://127.0.0.1:$api_port (auto reload)"

pids=()
cleanup() {
  # Background jobs have separate process groups, including pnpm's Vite child.
  for pid in "${pids[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Background services must not read the controlling terminal (SIGTTIN stops their group).
bash tools/run-server.sh --reload </dev/null & pids+=("$!")
bash tools/run-tv-web.sh --port 5173 --strictPort </dev/null & pids+=("$!")
pnpm --dir apps/web dev --strictPort </dev/null & pids+=("$!")
pnpm --dir apps/site dev </dev/null & pids+=("$!")

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      exit "$status"
    fi
  done
  sleep 1
done
