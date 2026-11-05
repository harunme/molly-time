"""Family overview backed by SQL aggregates and transactional watch summaries."""

import datetime as dt
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import case, func
from sqlalchemy.orm import aliased

from ..deps import DbSession
from ..device_presence import ONLINE_WINDOW
from ..manage_auth import Parent
from ..management_models import (
    Device,
    FamilyReminders,
    FamilySettings,
    ResourceState,
    UploadSession,
)
from ..models import ChildProfile, Item, MediaFile
from ..resource_policy import visible_item_ids
from ..usage import storage_totals

router = APIRouter(prefix="/api/manage", tags=["manage-overview"])


def watch_summary(db, family, zone, now):
    from ..watch_rollups import read_summary
    summary, favorite, ranked = read_summary(db, family, now)
    ranked_ids = [row["id"] for row in ranked]
    contents = {row["id"]: row for row in ranked}
    if favorite:
        favorite = {key: favorite[key] for key in ("id", "name", "playedMs")}
        current_name = db.query(Item.name).filter(Item.id == favorite["id"], Item.family_id == family).scalar()
        favorite["name"] = current_name or favorite["name"]
    parent = aliased(Item)
    grandparent = aliased(Item)
    series_name = case(
        (parent.type == "Series", parent.name),
        ((parent.type == "Season") & (grandparent.type == "Series"), grandparent.name),
    )
    current_videos = {
        item_id: (name, series)
        for item_id, name, series in db.query(Item.id, Item.name, series_name).outerjoin(
            parent, (parent.id == Item.parent_id) & (parent.family_id == family),
        ).outerjoin(
            grandparent, (grandparent.id == parent.parent_id) & (grandparent.family_id == family),
        ).filter(Item.id.in_(ranked_ids), Item.family_id == family).all()
    } if ranked_ids else {}
    most_played_videos = [
        {"id": item_id, "name": current_videos.get(item_id, (None, None))[0] or contents[item_id]["name"],
         "seriesName": current_videos.get(item_id, (None, None))[1],
         "playCount": contents[item_id]["playCount"]}
        for item_id in ranked_ids
    ]
    return {**summary, "favoriteVideo": favorite,
            "mostPlayedVideo": most_played_videos[0] if most_played_videos else None,
            "mostPlayedVideos": most_played_videos}



def published_resource_summary(db, family):
    parent = aliased(Item)
    grandparent = aliased(Item)
    video = db.query(MediaFile.item_id).filter(
        MediaFile.family_id == family, MediaFile.kind == "video",
    ).distinct().subquery()
    episodes = db.query(Item).join(video, video.c.item_id == Item.id).filter(
        Item.family_id == family, Item.type == "Episode",
        Item.id.in_(visible_item_ids(family)),
    )
    reminders = db.get(FamilyReminders, family)
    if reminders:
        private_ids = [key for key in (reminders.folder_id, reminders.warning_id, reminders.farewell_id) if key]
        if private_ids:
            episodes = episodes.filter(Item.id.notin_(private_ids))
    series_id = case((parent.type == "Series", parent.id),
                     (grandparent.type == "Series", grandparent.id))
    series_count, episode_count = episodes.with_entities(
        func.count(func.distinct(series_id)), func.count(Item.id),
    ).outerjoin(parent, (parent.id == Item.parent_id) & (parent.family_id == family)).outerjoin(
        grandparent, (grandparent.id == parent.parent_id) & (grandparent.family_id == family),
    ).one()
    subtitle_count = db.query(func.count(MediaFile.id)).filter(
        MediaFile.family_id == family, MediaFile.kind == "subtitle",
        MediaFile.item_id.in_(episodes.with_entities(Item.id)),
    ).scalar()
    return {"series": series_count, "episodes": episode_count, "subtitles": subtitle_count}


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
        .filter(UploadSession.family_id == family, UploadSession.kind.notin_(["image", "preview"]))
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
    now = dt.datetime.now(dt.UTC)
    online = db.query(func.count(Device.id)).filter(
        Device.family_id == family, Device.revoked.is_(False),
        Device.last_seen >= now - ONLINE_WINDOW, Device.last_seen <= now,
    ).scalar()
    return {
        "media": media,
        "resources": published_resource_summary(db, family),
        "uploads": {
            "active": upload_counts.get("uploading", 0) + upload_counts.get("processing", 0),
            "failed": upload_counts.get("failed", 0),
            "ready": upload_counts.get("ready", 0),
        },
        "devices": {
            "active": device_counts.get(False, 0), "revoked": device_counts.get(True, 0),
            "online": online,
        },
        "children": db.query(func.count(ChildProfile.id)).filter(ChildProfile.family_id == family).scalar(),
        "storageBytes": storage_totals(db, [family])[family]["usedBytes"],
        "watch": {
            **watch_summary(db, family, zone, now),
        },
    }
