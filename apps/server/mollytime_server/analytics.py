"""Deterministic operational aggregates, independent of family watch policy."""

import datetime as dt
from zoneinfo import ZoneInfo

from sqlalchemy import or_

from .analytics_models import DeviceDay
from .manage_auth import aware
from .management_models import Device, SchemaRevision, WatchInterval, WatchSession
from .models import Item

ZONE = ZoneInfo("Asia/Shanghai")
REVISION = "operations-analytics-v1"


def record_device_day(db, device_id, at=None):
    at = at or dt.datetime.now(dt.UTC)
    day = at.astimezone(ZONE).date()
    if db.get(DeviceDay, (device_id, day)) is not None:
        return
    # Native upsert makes overlapping page/player heartbeats safe on both databases.
    device = db.get(Device, device_id)
    if device is None or device.revoked:
        return
    values = {"device_id": device_id, "family_id": device.family_id, "day": day}
    if db.bind.dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert

        statement = insert(DeviceDay).values(**values).on_conflict_do_nothing()
    else:
        from sqlalchemy.dialects.mysql import insert

        statement = (
            insert(DeviceDay).values(**values).on_duplicate_key_update(family_id=device.family_id)
        )
    db.execute(statement)


def metadata(db, now):
    revision = db.get(SchemaRevision, REVISION)
    return {
        "timezone": str(ZONE),
        "updatedAt": now.isoformat(),
        "collectionStartedAt": aware(revision.applied_at).isoformat() if revision else None,
    }


def bounds(days, now):
    today = now.astimezone(ZONE).date()
    first = today - dt.timedelta(days=days - 1)
    return first, dt.datetime.combine(first, dt.time.min, ZONE).astimezone(dt.UTC)


def watching(db, days, now, family_ids=None):
    first, lower = bounds(days, now)
    buckets = {
        (first + dt.timedelta(days=i)).isoformat(): {
            "families": set(),
            "devices": set(),
            "vodMs": 0,
            "liveMs": 0,
        }
        for i in range(days)
    }
    families = {}
    # Offset intervals may belong to a session started before this reporting range.
    # Filter by its latest report, not its start, to retain resumed/offline sessions.
    query = (
        db.query(
            WatchSession.family_id,
            WatchSession.device_id,
            WatchSession.started_at,
            WatchSession.purpose,
            Item.type,
            WatchInterval.start_ms,
            WatchInterval.end_ms,
        )
        .join(
            WatchInterval,
            WatchInterval.session_id == WatchSession.id,
        )
        .outerjoin(Item, Item.id == WatchSession.item_id)
        .filter(
            WatchInterval.played_ms > 0,
            WatchSession.started_at < now,
            or_(WatchSession.last_reported_at >= lower, WatchSession.last_reported_at.is_(None)),
            or_(
                WatchSession.purpose.in_(("family_watch", "child_watch")),
                WatchSession.device_id.is_not(None),
            ),
        )
    )
    if family_ids is not None:
        query = query.filter(WatchSession.family_id.in_(family_ids))
    for family, device, started, purpose, kind, start, end in query.yield_per(512):
        a = max(aware(started) + dt.timedelta(milliseconds=start), lower)
        b = min(aware(started) + dt.timedelta(milliseconds=end), now)
        live = purpose == "live_tv" or kind == "LiveChannel"
        while a < b:
            day = a.astimezone(ZONE).date()
            edge = min(
                b,
                dt.datetime.combine(day + dt.timedelta(days=1), dt.time.min, ZONE).astimezone(
                    dt.UTC
                ),
            )
            duration = round((edge - a).total_seconds() * 1000)
            bucket = buckets[day.isoformat()]
            bucket["families"].add(family)
            if device:
                bucket["devices"].add(device)
            bucket["liveMs" if live else "vodMs"] += duration
            families[family] = families.get(family, 0) + duration
            a = edge
    return buckets, families
