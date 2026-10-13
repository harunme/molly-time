"""Family overview backed by aggregate queries, without loading list records."""

import datetime as dt
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import func

from ..deps import DbSession
from ..manage_auth import Parent
from ..management_models import (
    Device,
    FamilySettings,
    ResourceState,
    UploadSession,
    WatchInterval,
    WatchSession,
)
from ..models import ChildProfile, Item, MediaFile
from .watch_filters import family_watch_clause

router = APIRouter(prefix="/api/manage", tags=["manage-overview"])


@router.get("/overview")
def overview(user: Parent, db: DbSession):
    family = user.family_id
    media = {"folders": 0, "videos": 0, "published": 0, "draft": 0, "archived": 0}
    groups = (
        db.query(Item.type, func.coalesce(ResourceState.status, "published"), func.count(Item.id))
        .outerjoin(ResourceState, ResourceState.item_id == Item.id)
        .filter(Item.family_id == family, Item.type.in_(("Series", "Episode")))
        .group_by(Item.type, ResourceState.status)
        .all()
    )
    for kind, status, count in groups:
        if kind == "Series":
            media["folders"] += count
        else:
            media["videos"] += count
            if status in ("published", "draft", "archived"):
                media[status] += count
    upload_counts = dict(
        db.query(UploadSession.status, func.count(UploadSession.id))
        .filter(UploadSession.family_id == family)
        .group_by(UploadSession.status)
        .all()
    )
    device_counts = dict(
        db.query(Device.revoked, func.count(Device.id))
        .filter(Device.family_id == family)
        .group_by(Device.revoked)
        .all()
    )
    settings = db.get(FamilySettings, family)
    zone = ZoneInfo(settings.timezone if settings else "Asia/Shanghai")
    today = dt.datetime.now(dt.UTC).astimezone(zone).date()
    start = dt.datetime.combine(today - dt.timedelta(days=6), dt.time.min, zone).astimezone(dt.UTC)
    end = dt.datetime.combine(today + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)
    played = db.query(WatchInterval.id).filter(
        WatchInterval.session_id == WatchSession.id, WatchInterval.played_ms > 0
    ).exists()
    sessions = db.query(func.count(WatchSession.id)).filter(
        WatchSession.family_id == family,
        family_watch_clause(),
        WatchSession.started_at >= start,
        WatchSession.started_at < end,
        played,
    ).scalar()
    return {
        "media": media,
        "uploads": {
            "active": upload_counts.get("uploading", 0) + upload_counts.get("processing", 0),
            "failed": upload_counts.get("failed", 0),
            "ready": upload_counts.get("ready", 0),
        },
        "devices": {"active": device_counts.get(False, 0), "revoked": device_counts.get(True, 0)},
        "children": db.query(func.count(ChildProfile.id)).filter(ChildProfile.family_id == family).scalar(),
        "storageBytes": db.query(func.coalesce(func.sum(MediaFile.size_bytes), 0)).filter(
            MediaFile.family_id == family
        ).scalar(),
        "watch": {"last7DaysSessions": sessions, "timezone": str(zone)},
    }
