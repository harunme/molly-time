"""Family overview with aggregates and streamed watch intervals, without N+1 queries."""

import datetime as dt
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import case, func
from sqlalchemy.orm import aliased

from ..deps import DbSession
from ..device_presence import ONLINE_WINDOW
from ..manage_auth import Parent, aware
from ..management_models import (
    Device,
    FamilyReminders,
    FamilySettings,
    ResourceState,
    UploadSession,
    WatchInterval,
    WatchSession,
)
from ..models import ChildProfile, Item, MediaFile
from ..resource_policy import visible_item_ids
from ..usage import storage_totals
from .watch_filters import family_watch_clause

router = APIRouter(prefix="/api/manage", tags=["manage-overview"])


def watch_summary(db, family, zone, now):
    today = now.astimezone(zone).date()
    first_day = today - dt.timedelta(days=364)
    week_start = today - dt.timedelta(days=today.weekday())
    days = {(first_day + dt.timedelta(days=i)).isoformat(): 0 for i in range(365)}
    lower = dt.datetime.combine(first_day, dt.time.min, zone).astimezone(dt.UTC)
    contents = {}
    # Select only the timeline columns. Older sessions can resume inside the
    # displayed range, so filtering by session start alone would lose viewing.
    intervals = db.query(
        WatchSession.id, WatchSession.started_at, WatchSession.item_id, WatchSession.item_name,
        WatchInterval.start_ms, WatchInterval.end_ms,
    ).join(WatchInterval, WatchInterval.session_id == WatchSession.id).filter(
        WatchSession.family_id == family, family_watch_clause(),
        WatchSession.started_at < now, WatchInterval.played_ms > 0,
    )
    plays = {}
    for session_id, started, item_id, name, start_ms, end_ms in intervals.yield_per(256):
        a = aware(started) + dt.timedelta(milliseconds=start_ms)
        b = min(aware(started) + dt.timedelta(milliseconds=end_ms), now)
        if b <= a:
            continue
        plays.setdefault(item_id, set()).add(session_id)
        content = contents.setdefault(item_id, {"id": item_id, "name": name, "playedMs": 0})
        content["playedMs"] += round((b - a).total_seconds() * 1000)
        a = max(a, lower)
        while a < b:
            local = a.astimezone(zone)
            midnight = dt.datetime.combine(
                local.date() + dt.timedelta(days=1), dt.time.min, zone,
            ).astimezone(dt.UTC)
            edge = min(b, midnight)
            days[local.date().isoformat()] += round((edge - a).total_seconds() * 1000)
            a = edge
    favorite = min(contents.values(), key=lambda row: (-row["playedMs"], row["id"])) if contents else None
    if favorite:
        current_name = db.query(Item.name).filter(
            Item.id == favorite["id"], Item.family_id == family,
        ).scalar()
        favorite["name"] = current_name or favorite["name"]
    ranked_ids = sorted(contents, key=lambda key: (-len(plays[key]), key))[:6]
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
         "playCount": len(plays[item_id])}
        for item_id in ranked_ids
    ]
    return {
        "todayPlayedMs": days[today.isoformat()],
        "weekPlayedMs": sum(value for day, value in days.items() if day >= week_start.isoformat()),
        "weekStart": week_start.isoformat(),
        "favoriteVideo": favorite,
        "mostPlayedVideo": most_played_videos[0] if most_played_videos else None,
        "mostPlayedVideos": most_played_videos,
        "days": [{"date": day, "playedMs": value} for day, value in days.items()],
    }


def published_resource_summary(db, family):
    parent = aliased(Item)
    grandparent = aliased(Item)
    video = db.query(MediaFile.id).filter(
        MediaFile.item_id == Item.id, MediaFile.family_id == family, MediaFile.kind == "video",
    ).exists()
    episodes = db.query(Item).filter(
        Item.family_id == family, Item.type == "Episode",
        Item.id.in_(visible_item_ids(family)), video,
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
        .filter(UploadSession.family_id == family, UploadSession.kind != "image")
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
    today = now.astimezone(zone).date()
    online = db.query(func.count(Device.id)).filter(
        Device.family_id == family, Device.revoked.is_(False),
        Device.last_seen >= now - ONLINE_WINDOW, Device.last_seen <= now,
    ).scalar()
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
            "last7DaysSessions": sessions, "timezone": str(zone),
            **watch_summary(db, family, zone, now),
        },
    }
