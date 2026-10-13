"""Exact byte accounting and fixed Asia/Shanghai calendar billing months."""

import datetime as dt
import re
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func

from .config import get_settings
from .management_models import SchemaRevision, UploadSession, UploadTarget
from .models import MediaFile, User
from .storage.local import LocalStorage
from .usage_models import TrafficEvent

BILLING_ZONE = ZoneInfo("Asia/Shanghai")


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
    ).filter(MediaFile.family_id.in_(family_ids), MediaFile.kind != "deleted").group_by(
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
