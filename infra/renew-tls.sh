#!/usr/bin/env bash
set -euo pipefail
cd /opt/mollytime
exec 9>/run/lock/mollytime-tls-renew.lock
flock -n 9 || exit 0
acme_image=$(sed -n 's/^MOLLYTIME_ACME_IMAGE=//p' .env)
docker run --rm --network host \
  -v /opt/mollytime/acme:/acme.sh \
  -v /opt/mollytime/tls:/certs \
  "${acme_image:-neilpang/acme.sh:latest}" \
  --cron --home /acme.sh
chmod 600 tls/privkey.pem
docker exec mollytime-tls nginx -t
docker exec mollytime-tls nginx -s reload
