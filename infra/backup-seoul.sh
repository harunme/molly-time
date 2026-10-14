#!/usr/bin/env bash
set -euo pipefail

root=/opt/mollytime
backup_dir="$root/data/backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
if [[ "${1:-}" == --force ]]; then
  docker exec infra-mollytime-server-1 python -m mollytime_server.backup_settings start
else
  schedule=$(docker exec infra-mollytime-server-1 python -m mollytime_server.backup_settings check)
  if [[ "$schedule" != due ]]; then
    exit 0
  fi
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$backup_dir/mysql-$stamp.sql.gz"
trap 'rm -f "$backup"; docker exec infra-mollytime-server-1 python -m mollytime_server.backup_settings finish failed >/dev/null || true' ERR

database=$(python3 - "$root/.env" <<'PY'
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

lines = Path(sys.argv[1]).read_text().splitlines()
urls = [line.split("=", 1)[1] for line in lines if line.startswith("MOLLYTIME_DB_URL=")]
if len(urls) != 1:
    raise SystemExit("expected one MOLLYTIME_DB_URL in .env")
database = urlsplit(urls[0]).path.removeprefix("/")
if not re.fullmatch(r"[A-Za-z0-9_]+", database):
    raise SystemExit("invalid MySQL database name")
print(database)
PY
)

docker exec -e "MYSQL_BACKUP_DB=$database" infra-mysql-1 sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --events --hex-blob "$MYSQL_BACKUP_DB"' \
  | gzip -9 > "$backup"
test -s "$backup"
chmod 600 "$backup"
docker exec infra-mollytime-server-1 python /app/upload_mysql_backup.py "/data/backups/$(basename "$backup")"
retention=$(docker exec infra-mollytime-server-1 python -m mollytime_server.backup_settings retention)
find "$backup_dir" -maxdepth 1 -type f -name 'mysql-*.sql.gz.fernet' -mmin "+$((retention * 1440))" -delete
docker exec infra-mollytime-server-1 python -m mollytime_server.backup_settings finish success "mollytime-backups/mysql/$(basename "$backup").fernet"
trap - ERR
