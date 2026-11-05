"""Exact byte accounting and fixed Asia/Shanghai calendar billing months."""

import datetime as dt
import re
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import case, func

from .config import get_settings
from .management_models import SchemaRevision, UploadSession, UploadTarget
from .models import MediaFile, User
from .storage.local import LocalStorage
from .transactions import external_io
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


def object_rows(db, families):
    """Batch all families in a page, rather than querying once per household."""
    from .share_models import ContentShare, ShareFile

    files = db.query(
        MediaFile.family_id, MediaFile.storage, MediaFile.path, MediaFile.size_bytes,
    ).filter(MediaFile.family_id.in_(families), MediaFile.kind != "deleted").all()
    files += db.query(
        ContentShare.family_id, ShareFile.storage, ShareFile.path, ShareFile.size_bytes,
    ).join(ContentShare).filter(
        ContentShare.family_id.in_(families), ContentShare.expires_at > dt.datetime.now(dt.UTC),
    ).all()
    return files


def measure_objects(files, families):
    from .trash import object_identity

    objects = {family: {} for family in families}
    measured = {}
    for family, backend, path, size in files:
        identity = object_identity(backend, path)
        unknown = backend not in ("local", "oss") or size <= 0
        if backend == "local":
            if identity not in measured:
                try:
                    measured[identity] = (LocalStorage(get_settings().resolved_media_dir()).size(path), False)
                except FileNotFoundError:
                    measured[identity] = (0, False)
                except (OSError, ValueError):
                    measured[identity] = (size, True)
            size, unknown = measured[identity]
        previous = objects[family].get(identity)
        if previous is None or size > previous["size"]:
            objects[family][identity] = {"backend": backend, "path": path, "size": max(0, size), "unknown": unknown}
    return objects


def family_objects(db, family):
    """Physical identities retained by a household, including live share snapshots."""
    files = object_rows(db, [family])
    with external_io(db):
        return measure_objects(files, [family])[family]


def storage_totals(db, family_ids):
    """Reuse committed file totals until content changes; reservations stay live."""
    from .share_models import ContentShare
    from .storage_snapshots import read_snapshots, save_snapshots

    if not family_ids:
        return {}
    now = dt.datetime.now(dt.UTC)
    versions, result = read_snapshots(db, family_ids, now)
    missing = [family for family in family_ids if family not in result]
    files = object_rows(db, missing) if missing else []
    expiries = dict(db.query(ContentShare.family_id, func.min(ContentShare.expires_at)).filter(
        ContentShare.family_id.in_(missing), ContentShare.expires_at > now,
    ).group_by(ContentShare.family_id).all()) if missing else {}
    # Uploaded offsets are durable database values. Do not stat temporary files
    # on every settings request, or invalidate the media snapshot for each chunk.
    pending = case(
        (MediaFile.id.is_not(None), 0),
        (UploadTarget.backend == "oss", case(
            (UploadSession.status.in_(["processing", "failed"]), UploadSession.size),
            else_=0,
        )),
        else_=UploadSession.offset,
    )
    uploads = db.query(
        UploadSession.family_id, func.sum(UploadSession.size), func.sum(pending),
    ).outerjoin(UploadTarget, UploadTarget.upload_id == UploadSession.id).outerjoin(
        MediaFile, MediaFile.id == UploadSession.id,
    ).filter(UploadSession.family_id.in_(family_ids),
             UploadSession.status.in_(["uploading", "processing", "failed"])
    ).group_by(UploadSession.family_id).all()
    if missing:
        with external_io(db):
            objects = measure_objects(files, missing)
        snapshots = []
        for family, values in objects.items():
            totals = {"usedBytes": 0, "localBytes": 0, "ossBytes": 0,
                      "objectCount": 0, "unknownSizeCount": 0}
            for obj in values.values():
                totals["objectCount"] += 1
                totals["unknownSizeCount"] += obj["unknown"]
                totals["usedBytes"] += obj["size"]
                if obj["backend"] in ("local", "oss"):
                    totals[f"{obj['backend']}Bytes"] += obj["size"]
            result[family] = totals
            expiry = now + dt.timedelta(hours=1)
            if family in expiries:
                expiry = min(expiry, expiries[family].replace(tzinfo=dt.UTC))
            snapshots.append({"family_id": family, "version": versions[family],
                              "totals": totals, "valid_until": expiry.replace(tzinfo=None)})
        save_snapshots(db.get_bind(), snapshots)
    for totals in result.values():
        totals.update(reservedBytes=0, pendingBytes=0)
    for family, reserved, pending_bytes in uploads:
        result[family].update(reservedBytes=int(reserved), pendingBytes=int(pending_bytes))
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
    from .oss_usage import sync_status
    oss_status = sync_status(db)
    return [{"id": family.id, "name": family.name, "accountCount": accounts.get(family.id, 0),
             "month": month, "timezone": str(BILLING_ZONE),
             "storage": storage[family.id], "traffic": traffic[family.id],
             "ossSync": oss_status,
             "storageMeasuredAt": dt.datetime.now(dt.UTC).isoformat(),
             "statisticsSince": revision.applied_at.replace(tzinfo=dt.UTC).isoformat()
             if revision else None} for family in families]
