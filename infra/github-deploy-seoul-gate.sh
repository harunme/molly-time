#!/usr/bin/env bash
set -euo pipefail
if [[ "${SSH_ORIGINAL_COMMAND:-}" == check ]]; then
  printf 'MollyTime Seoul deployment key ready\n'
elif [[ "${SSH_ORIGINAL_COMMAND:-}" == apk-state ]]; then
  exec sudo -n /usr/bin/python3 /usr/local/lib/mollytime-deploy-seoul.py --apk-state
elif [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec sudo -n /usr/bin/python3 /usr/local/lib/mollytime-deploy-seoul.py "${BASH_REMATCH[1]}"
elif [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})\ apk\ ([A-Za-z0-9_-]{1,5500})\ ([0-9a-f]{64})$ ]]; then
  exec sudo -n /usr/bin/python3 /usr/local/lib/mollytime-deploy-seoul.py \
    "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
else
  printf 'Only deployment commands are allowed\n' >&2
  exit 64
fi
