"""OSS access-log accounting. No signed URLs, keys, IPs or raw logs are persisted."""

import datetime as dt
import hashlib
import hmac
import io
import logging
import re
import tempfile
import threading
from urllib.parse import parse_qs, quote, unquote, urlsplit

from sqlalchemy.exc import IntegrityError

from .config import get_settings
from .db import get_session_factory
from .models import Family
from .storage.settings import get_storage_settings
from .transactions import serialize_sqlite_write
from .usage_models import OssLogImport, OssLogRequest, OssLogSync, TrafficEvent

logger = logging.getLogger(__name__)
# Quote-aware fields, including the bracketed timestamp; tolerate appended fields.
FIELDS = re.compile(r'"([^"\n]*)"|\[([^\]\n]*)\]|([^\s]+)')
PARAM = "x-molly-usage"


def digest(*parts):
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


def attribution(family_id, key):
    message = f"oss-usage\0{family_id}\0{key}".encode()
    signature = hmac.new(get_settings().auth_secret.encode(), message, hashlib.sha256).hexdigest()
    return f"{family_id}.{signature}"


def media_url(storage, key, ttl, family_id):
    """x- parameters are ignored by OSS signing and retained in access logs."""
    url = storage.signed_url(key, ttl)
    if not family_id:
        return url
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{PARAM}={quote(attribution(family_id, key), safe='')}"


def parse_line(line, bucket):
    fields = [next(value for value in match.groups() if value is not None)
              for match in FIELDS.finditer(line)]
    if len(fields) < 23:
        raise ValueError("日志字段不足")
    # Standard OSS fields: time=3, request=4, status=5, bytes=6,
    # host=10, request ID=11, operation=14, bucket=15, sync request=23.
    if fields[15] != bucket or fields[14] != "GetObject":
        return None
    host = fields[10].lower().split(":", 1)[0]
    if "-internal." in host or (len(fields) > 23 and fields[23] == "cdn"):
        return None
    request = fields[4].split()
    if len(request) != 3 or request[0] != "GET":
        return None
    status, size = int(fields[5]), int(fields[6])
    if status not in (200, 206) or size <= 0:
        return None
    if size > 2**63 - 1 or fields[11] in ("", "-"):
        raise ValueError("日志请求无有效字节数或 ID")
    occurred = dt.datetime.strptime(fields[3], "%d/%b/%Y:%H:%M:%S %z").astimezone(dt.UTC)
    url = urlsplit(request[1])
    key = unquote(url.path.lstrip("/"))
    tokens = parse_qs(url.query).get(PARAM, [])
    family = None
    if len(tokens) == 1 and "." in tokens[0]:
        candidate, _ = tokens[0].rsplit(".", 1)
        if hmac.compare_digest(tokens[0], attribution(candidate, key)):
            family = candidate
    return digest(bucket, fields[11]), family, size, occurred


def import_log(lines, source_bucket, import_id=None):
    """Commit one log atomically; overlapping logs deduplicate by bucket/request ID."""
    with get_session_factory()() as db:
        serialize_sqlite_write(db)
        if import_id and db.get(OssLogImport, import_id):
            return 0
        count = 0
        for line in lines:
            if not line.strip():
                continue
            parsed = parse_line(line, source_bucket)
            if parsed is None:
                continue
            identity, family, size, occurred = parsed
            if family and db.get(Family, family) is None:
                family = None
            try:
                with db.begin_nested():
                    db.add(OssLogRequest(id=identity, family_id=family, bytes_sent=size,
                                         occurred_at=occurred))
                    db.flush()
                    if family:
                        db.add(TrafficEvent(id=identity, family_id=family, source="oss",
                                            bytes_sent=size, occurred_at=occurred))
                        db.flush()
                count += 1
            except IntegrityError:
                # Only ignore known duplicates, not unrelated constraint failures.
                if db.get(OssLogRequest, identity) is None:
                    raise
        if import_id:
            db.add(OssLogImport(id=import_id))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if not import_id or db.get(OssLogImport, import_id) is None:
                raise
        return count


def sync_status(db):
    config = get_settings()
    row = db.get(OssLogSync, "oss")
    def iso(value):
        return value.replace(tzinfo=dt.UTC).isoformat() if value else None
    return {"enabled": bool(config.oss_log_bucket),
            "lastSuccessAt": iso(row.last_success_at) if row else None,
            "lastAttemptAt": iso(row.last_attempt_at) if row else None,
            "error": row.error if row else None}


def record_sync(success, error=None):
    # Multiple API processes can finish the first scan together.
    for attempt in range(2):
        with get_session_factory()() as db:
            serialize_sqlite_write(db)
            row = db.get(OssLogSync, "oss")
            if row is None:
                row = OssLogSync(id="oss")
                db.add(row)
            row.last_attempt_at = dt.datetime.now(dt.UTC)
            if success:
                row.last_success_at = row.last_attempt_at
            row.error = error
            try:
                db.commit()
                return
            except IntegrityError:
                if attempt:
                    raise


def sync_once(stop=None):
    """Re-scan recent date prefixes so late delivery and prior-month logs are included."""
    import oss2

    config = get_settings()
    if not config.oss_log_bucket:
        return
    settings = get_storage_settings()
    endpoint = settings.oss_internal_endpoint or settings.oss_endpoint
    if not endpoint or not endpoint.startswith("https://") or not settings.oss_bucket:
        raise ValueError("OSS configuration is incomplete")
    client = oss2.Bucket(oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret),
                         endpoint, config.oss_log_bucket, connect_timeout=20)
    today = dt.datetime.now(dt.UTC).date()
    for offset in range(config.oss_log_lookback_days):
        day = today - dt.timedelta(days=offset)
        prefix = f"{config.oss_log_prefix}{settings.oss_bucket}{day:%Y-%m-%d}-"
        for obj in oss2.ObjectIterator(client, prefix=prefix):
            if stop and stop.is_set():
                return
            identity = digest(config.oss_log_bucket, obj.key, obj.etag)
            with get_session_factory()() as db:
                done = db.get(OssLogImport, identity) is not None
            if done:
                continue
            # Stream to avoid loading whole logs; transactions never wrap network I/O.
            with tempfile.TemporaryFile() as temporary:
                response = client.get_object(obj.key)
                try:
                    while block := response.read(256 * 1024):
                        temporary.write(block)
                finally:
                    response.close()
                temporary.seek(0)
                with io.TextIOWrapper(temporary, encoding="utf-8") as lines:
                    import_log(lines, settings.oss_bucket, identity)
    record_sync(True)


def start_worker():
    stop = threading.Event()
    def loop():
        while not stop.is_set():
            try:
                sync_once(stop)
            except Exception as error:  # noqa: BLE001 -- background task must retry safely
                # SDK exception strings can contain signed URLs. Never expose them.
                record_sync(False, "OSS 日志同步失败，请检查日志格式、存储配置及读取权限")
                logger.warning("OSS usage sync failed (%s)", type(error).__name__)
            stop.wait(get_settings().oss_log_sync_seconds)
    thread = threading.Thread(target=loop, name="mollytime-oss-usage", daemon=True)
    thread.start()
    return stop, thread


if __name__ == "__main__":
    from .db import init_db
    init_db()
    sync_once()
