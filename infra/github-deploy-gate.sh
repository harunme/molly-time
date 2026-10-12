#!/usr/bin/env bash
set -euo pipefail
if [[ "${SSH_ORIGINAL_COMMAND:-}" == "check" ]]; then
  printf 'MollyTime deployment key ready\n'
elif [[ "${SSH_ORIGINAL_COMMAND:-}" == "apk-state" ]]; then
  exec /usr/bin/python3 /usr/local/lib/mollytime-deploy.py --apk-state
elif [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec /usr/bin/python3 /usr/local/lib/mollytime-deploy.py "${BASH_REMATCH[1]}"
else
  printf 'Only deployment commands are allowed\n' >&2
  exit 64
fi
