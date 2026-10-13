"""Exact byte accounting and fixed Asia/Shanghai calendar billing months."""

import datetime as dt
import hashlib
import re
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func

from .config import get_settings
from .management_models import SchemaRevision, UploadSession, UploadTarget
from .models import Family, MediaFile, User
from .storage.local import LocalStorage
from .storage.settings import get_storage_settings
from .transactions import serialize_sqlite_write
from .usage_models import TrafficEvent

BILLING_ZONE = ZoneInfo("Asia/Shanghai")
MAX_LOG_BYTES = 10 * 1024**2
MAX_LOG_LINES = 20000
# Brackets and quoted fields must remain intact (spaces are meaningful).
LOG_TOKEN = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"|\[([^\]]+)\]|(\S+)')


def month_bounds(month: str | None):
    month = month or dt.datetime.now(BILLING_ZONE).strftime("%Y-%m")
    if not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(422, "月份格式应为 YYYY-MM")
    year, number = map(int, month.split("-"))
    if not 1970 <= year <= 9998:
        raise HTTPException(422, "月份年份应在 1970 至 9998 之间")
    lower = dt.datetime(year, number, 1, tzinfo=BILLING_ZONE)
    upper = dt.datetime(year + (number == 12), number % 12 + 1, 1, tzinfo=BILLING_ZONE)
    return month, lower.astimezone(dt.UTC), upper.astimezone(dt.UTC)


def storage_totals(db, family_ids):
    """Catalog objects, including retained old versions, counted once per path.

    Temporary uploads are separate from catalog storage; OSS multipart fragments
    and derived application caches are not falsely presented as known usage.
    """
    result = {key: {"usedBytes": 0, "localBytes": 0, "ossBytes": 0,
                    "objectCount": 0, "unknownSizeCount": 0, "reservedBytes": 0,
                    "pendingBytes": 0} for key in family_ids}
    local = LocalStorage(get_settings().resolved_media_dir())
    objects = db.query(
        MediaFile.family_id, MediaFile.storage, MediaFile.path,
        func.max(MediaFile.size_bytes),
    ).filter(MediaFile.family_id.in_(family_ids)).group_by(
        MediaFile.family_id, MediaFile.storage, MediaFile.path,
    )
    for family, backend, path, size in objects.yield_per(256):
        row = result[family]
        row["objectCount"] += 1
        if backend == "local":
            try:
                size = local.size(path)
            except FileNotFoundError:
                size = 0
            except (OSError, ValueError):
                row["unknownSizeCount"] += 1
                size = max(0, size)
        elif backend != "oss" or size <= 0:
            row["unknownSizeCount"] += 1
        size = max(0, size)
        row["usedBytes"] += size
        if backend in ("local", "oss"):
            row[f"{backend}Bytes"] += size
    uploads = db.query(UploadSession, UploadTarget).outerjoin(
        UploadTarget, UploadTarget.upload_id == UploadSession.id,
    ).filter(UploadSession.family_id.in_(family_ids),
             UploadSession.status.in_(["uploading", "processing", "failed"]))
    # Completed uploads waiting for processing occupy storage, even if validation failed.
    known_ids = {key for (key,) in db.query(MediaFile.id).filter(
        MediaFile.family_id.in_(family_ids),
    )}
    for upload, target in uploads.yield_per(256):
        row = result[upload.family_id]
        row["reservedBytes"] += upload.size
        if upload.id in known_ids:
            continue
        if target and target.backend == "oss":
            size = upload.size if upload.status in ("processing", "failed") else 0
        else:
            path = get_settings().data_dir / "uploads" / f"{upload.id}.part"
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                size = 0
        row["pendingBytes"] += size
    return result


def family_usage(db, families, month=None):
    month, lower, upper = month_bounds(month)
    keys = [family.id for family in families]
    storage = storage_totals(db, keys)
    traffic = {key: {"localBytes": 0, "ossBytes": 0, "totalBytes": 0,
                     "requestCount": 0, "lastOssImportAt": None} for key in keys}
    query = db.query(TrafficEvent.family_id, TrafficEvent.source,
                     func.sum(TrafficEvent.bytes_sent), func.count(),
                     func.max(TrafficEvent.recorded_at)).filter(
        TrafficEvent.family_id.in_(keys), TrafficEvent.occurred_at >= lower,
        TrafficEvent.occurred_at < upper,
    ).group_by(TrafficEvent.family_id, TrafficEvent.source)
    for family, source, count_bytes, count, last in query:
        row = traffic[family]
        row[f"{source}Bytes"] = count_bytes
        row["totalBytes"] += count_bytes
        row["requestCount"] += count
        if source == "oss":
            row["lastOssImportAt"] = last.replace(tzinfo=dt.UTC).isoformat()
    accounts = dict(db.query(User.family_id, func.count()).filter(
        User.family_id.in_(keys),
    ).group_by(User.family_id).all())
    revision = db.get(SchemaRevision, "family-usage-v1")
    return [{"id": family.id, "name": family.name, "accountCount": accounts.get(family.id, 0),
             "month": month, "timezone": str(BILLING_ZONE),
             "storage": storage[family.id], "traffic": traffic[family.id],
             "storageMeasuredAt": dt.datetime.now(dt.UTC).isoformat(),
             "statisticsSince": revision.applied_at.replace(tzinfo=dt.UTC).isoformat()
             if revision else None} for family in families]


def parse_oss_logs(data: bytes, bucket: str):
    """Official OSS bucket logging format. Invalid input fails atomically."""
    try:
        lines = data.decode("utf-8-sig").splitlines()
    except UnicodeDecodeError as exc:
        raise HTTPException(422, "日志必须为 UTF-8 文本") from exc
    if len(lines) > MAX_LOG_LINES:
        raise HTTPException(413, "每次最多导入 20000 行日志，请分批导入")
    endpoint = urlsplit(get_storage_settings().oss_endpoint or "").hostname
    expected_host = f"{bucket}.{endpoint}"
    parsed, ignored = [], 0
    for index, line in enumerate(lines, 1):
        if not line.strip():
            continue
        matches = list(LOG_TOKEN.finditer(line))
        if any(line[a:b].strip() for a, b in zip(
            [0] + [m.end() for m in matches], [m.start() for m in matches] + [len(line)],
        )):
            raise HTTPException(422, f"第 {index} 行日志格式无效")
        fields = [next(value for value in match.groups() if value is not None)
                  for match in matches]
        try:
            if len(fields) < 24 or fields[1:3] != ["-", "-"]:
                raise ValueError()
            occurred = dt.datetime.strptime(fields[3], "%d/%b/%Y:%H:%M:%S %z").astimezone(dt.UTC)
            status, sent = int(fields[5]), int(fields[6]) if fields[6] != "-" else 0
            if sent < 0 or sent > 2**63 - 1 or not 100 <= status <= 599:
                raise ValueError()
            if not fields[11] or fields[11] == "-" or len(fields[11]) > 128:
                raise ValueError()
        except (ValueError, StopIteration) as exc:
            raise HTTPException(422, f"第 {index} 行日志格式无效") from exc
        # Ignore uploads, errors, HEAD, internal processing and CDN origin requests.
        if (fields[15] != bucket or fields[10] != expected_host
                or fields[14] != "GetObject" or fields[23] != "-"
                or not fields[4].startswith("GET ") or status not in (200, 206) or sent == 0):
            ignored += 1
            continue
        # The URL is intentionally discarded: it may contain a signing credential.
        key = unquote(fields[16])
        event_id = hashlib.sha256(f"oss:{bucket}:{fields[11]}".encode()).hexdigest()
        parsed.append((event_id, key, occurred, sent))
    return parsed, ignored


def import_oss_logs(db, data: bytes):
    if len(data) > MAX_LOG_BYTES:
        raise HTTPException(413, "每次最多导入 10 MiB 日志")
    bucket = get_storage_settings().oss_bucket
    if not bucket or not get_storage_settings().oss_endpoint:
        raise HTTPException(409, "请先配置 OSS Bucket 和 Endpoint")
    events, ignored = parse_oss_logs(data, bucket)
    serialize_sqlite_write(db)
    families = {key for (key,) in db.query(Family.id)}
    # Legacy object keys lack family prefixes. Only unambiguous database ownership qualifies.
    owners = {}
    for key, family in db.query(MediaFile.path, MediaFile.family_id).filter(MediaFile.storage == "oss"):
        owners.setdefault(key, set()).add(family)
    imported, duplicates, unresolved = 0, 0, 0
    for event_id, key, occurred, sent in events:
        match = re.fullmatch(r"families/([^/]+)/.+", key)
        candidates = owners.get(key, set())
        family = match[1] if match and match[1] in families else (
            next(iter(candidates)) if len(candidates) == 1 else None
        )
        if not family or (candidates and candidates != {family}):
            unresolved += 1
            continue
        previous = db.get(TrafficEvent, event_id)
        if previous:
            if (previous.family_id != family or previous.bytes_sent != sent
                    or previous.occurred_at.replace(tzinfo=dt.UTC) != occurred):
                db.rollback()
                raise HTTPException(409, "同一 OSS 请求 ID 存在冲突，导入已取消")
            duplicates += 1
            continue
        db.add(TrafficEvent(id=event_id, family_id=family, source="oss",
                            occurred_at=occurred, bytes_sent=sent))
        db.flush()  # Deduplicate repeated request IDs within this same file as well.
        imported += 1
    db.commit()
    return {"imported": imported, "duplicates": duplicates,
            "ignored": ignored, "unresolved": unresolved}
