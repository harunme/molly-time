"""Children, device revocation, timezone and real-time watch reports."""

import datetime as dt
import shutil
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased

from ..auth import hash_password, verify_password
from ..config import get_settings
from ..deps import DbSession
from ..manage_auth import Parent, aware
from ..management_models import Device, FamilySettings, WatchInterval, WatchSession
from ..models import ChildProfile, Family, Item
from ..playback_settings import SubtitlePreference, default_subtitle, save_default_subtitle
from ..storage.settings import get_storage_settings
from ..transactions import external_io, serialize_sqlite_write
from ..usage import storage_totals
from .manage_resources import owned
from .pagination import paginate
from .watch_filters import family_watch_clause

router = APIRouter(prefix="/api/manage", tags=["manage-family"])


@router.get("/children")
def children(
    user: Parent, db: DbSession,
    page: int | None = Query(default=None, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
):
    query = (db.query(ChildProfile)
        .filter(ChildProfile.family_id == user.family_id)
        .order_by(ChildProfile.created_at, ChildProfile.id))
    return paginate(query, page, pageSize, lambda c: {"id": c.id, "name": c.name})


class ChildBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)


def save_child(row, body, db):
    if not body.name.strip():
        raise HTTPException(422, "姓名不能为空")
    row.name = body.name.strip()
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "已有同名儿童") from exc
    return {"id": row.id, "name": row.name}


@router.post("/children")
def create_child(body: ChildBody, user: Parent, db: DbSession):
    return save_child(ChildProfile(family_id=user.family_id), body, db)


@router.patch("/children/{child_id}")
def edit_child(child_id: str, body: ChildBody, user: Parent, db: DbSession):
    return save_child(owned(db, ChildProfile, child_id, user.family_id), body, db)


@router.get("/devices")
def devices(
    user: Parent, db: DbSession,
    page: int | None = Query(default=None, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
    activeOnly: bool = False,
):
    query = (db.query(Device).filter(Device.family_id == user.family_id)
             .order_by(Device.created_at.desc(), Device.id.desc()))
    if activeOnly:
        query = query.filter(Device.revoked.is_(False))
    return paginate(query, page, pageSize, lambda r: {
            "id": r.id,
            "name": r.name,
            "revoked": r.revoked,
            "createdAt": aware(r.created_at).isoformat(),
            "lastSeen": aware(r.last_seen).isoformat(),
        })


class DeviceBody(BaseModel):
    name: str = Field(min_length=1, max_length=128)


@router.patch("/devices/{device_id}")
def rename_device(device_id: str, body: DeviceBody, user: Parent, db: DbSession):
    row = owned(db, Device, device_id, user.family_id)
    row.name = body.name.strip() or "MollyTime"
    db.commit()
    return {"ok": True}


@router.post("/devices/{device_id}/revoke")
def revoke_device(device_id: str, user: Parent, db: DbSession):
    row = owned(db, Device, device_id, user.family_id)
    row.revoked = True
    db.commit()
    return {"ok": True}


@router.get("/settings")
def settings(user: Parent, db: DbSession):
    row = db.get(FamilySettings, user.family_id)
    family = db.get(Family, user.family_id)
    path = get_settings().resolved_media_dir()
    with external_io(db):
        path.mkdir(parents=True, exist_ok=True)
        disk = shutil.disk_usage(path)
    usage = storage_totals(db, [user.family_id])[user.family_id]
    return {
        "familyName": family.name if family else "我的家庭",
        "timezone": row.timezone if row else "Asia/Shanghai",
        "defaultSubtitle": default_subtitle(db, user.family_id),
        "storage": {
            "total": disk.total,
            "free": disk.free,
            "backend": get_storage_settings().storage_backend,
            "usedBytes": usage["usedBytes"],
            "reservedBytes": usage["reservedBytes"],
            "limitBytes": get_settings().family_storage_limit_bytes,
        },
    }


class SettingsBody(BaseModel):
    familyName: str | None = Field(default=None, max_length=128)
    timezone: str | None = Field(default=None, max_length=64)
    defaultSubtitle: SubtitlePreference | None = None


@router.put("/settings")
def edit_settings(body: SettingsBody, user: Parent, db: DbSession):
    family_name = body.familyName.strip() if body.familyName is not None else None
    if family_name is not None and not family_name:
        raise HTTPException(422, "家庭名称不能为空")
    if body.timezone is not None:
        try:
            ZoneInfo(body.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise HTTPException(422, "时区无效，例如 Asia/Shanghai") from exc
    serialize_sqlite_write(db)
    if family_name is not None:
        family = db.get(Family, user.family_id)
        if family is None:
            raise HTTPException(404, "家庭不存在")
        family.name = family_name
    if body.timezone is not None:
        row = db.get(FamilySettings, user.family_id)
        if row is None:
            row = FamilySettings(family_id=user.family_id)
            db.add(row)
        row.timezone = body.timezone
    if body.defaultSubtitle is not None:
        save_default_subtitle(db, user.family_id, body.defaultSubtitle)
    db.commit()
    return settings(user, db)


class PasswordBody(BaseModel):
    currentPassword: str = Field(max_length=128)
    newPassword: str = Field(min_length=8, max_length=72)


@router.post("/password")
def password(body: PasswordBody, user: Parent, db: DbSession):
    if not verify_password(body.currentPassword, user.password_hash):
        raise HTTPException(403, "当前密码错误")
    if len(body.newPassword.encode()) > 72:
        raise HTTPException(422, "密码 UTF-8 长度不可超过 72 字节")
    user.password_hash = hash_password(body.newPassword)
    db.commit()
    return {"ok": True}


@router.get("/reports/watch-time")
def report(
    user: Parent, db: DbSession, start: dt.date, end: dt.date, childId: str | None = None,
    deviceId: str | None = Query(default=None, min_length=1),
    unassignedDevice: bool = False,
    sessionPage: int = Query(default=1, ge=1),
    contentPage: int = Query(default=1, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
):
    if childId:
        owned(db, ChildProfile, childId, user.family_id)
    if deviceId is not None and unassignedDevice:
        raise HTTPException(422, "请只指定一种设备范围")
    if end < start or (end - start).days > 365:
        raise HTTPException(422, "请查询不超过一年的日期范围")
    config = db.get(FamilySettings, user.family_id)
    zone = ZoneInfo(config.timezone if config else "Asia/Shanghai")
    lower = dt.datetime.combine(start, dt.time.min, zone).astimezone(dt.UTC)
    upper = dt.datetime.combine(end + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)
    # Earlier TV sessions without a child were incorrectly labeled as previews.
    # Only authenticated device sessions qualify; parent previews stay excluded.
    viewing = family_watch_clause()
    episode_item, parent_item, grandparent_item = aliased(Item), aliased(Item), aliased(Item)
    query = (
        db.query(
            WatchSession, WatchInterval,
            parent_item.id, parent_item.name, parent_item.type,
            grandparent_item.id, grandparent_item.name,
        )
        .join(WatchInterval, WatchInterval.session_id == WatchSession.id)
        .outerjoin(episode_item, episode_item.id == WatchSession.item_id)
        .outerjoin(parent_item, parent_item.id == episode_item.parent_id)
        .outerjoin(grandparent_item, grandparent_item.id == parent_item.parent_id)
        .filter(
            WatchSession.family_id == user.family_id,
            viewing,
            WatchSession.started_at < upper,
        )
    )
    if childId:
        query = query.filter(WatchSession.child_id == childId)
    if deviceId is not None:
        query = query.filter(WatchSession.device_id == deviceId)
    elif unassignedDevice:
        query = query.filter(WatchSession.device_id.is_(None))
    days = {(start + dt.timedelta(days=i)).isoformat(): 0 for i in range((end - start).days + 1)}
    hours = [0] * 24 if start == end else []
    day_devices = {day: {} for day in days}
    hour_devices = [{} for _ in hours]
    device_ids = set()
    contents, sessions, episodes = {}, {}, set()
    # Summary totals cover the whole range; stream intervals instead of loading
    # them all at once. Fetch catalog names in the same query: issuing another
    # query on a MySQL connection with an active streaming result truncates it.
    # Only paged details are sent to the browser.
    for (
        watch, interval, parent_id, parent_name, parent_type, series_id, series_name
    ) in query.yield_per(256):
        if not interval.played_ms:
            continue
        a = max(aware(watch.started_at) + dt.timedelta(milliseconds=interval.start_ms), lower)
        b = min(aware(watch.started_at) + dt.timedelta(milliseconds=interval.end_ms), upper)
        if b <= a:
            continue
        played = round((b - a).total_seconds() * 1000)
        device_ids.add(watch.device_id)
        episodes.add(watch.item_id)
        if parent_type == "Series":
            content_id, name = parent_id, parent_name
        elif series_id is not None:
            content_id, name = series_id, series_name
        else:
            content_id, name = watch.item_id, watch.item_name
        bucket = contents.setdefault(content_id, {"id": content_id, "name": name, "playedMs": 0})
        bucket["playedMs"] += played
        sessions.setdefault(watch.id, {"id": watch.id,
            "startedAt": aware(watch.started_at).isoformat(), "playedMs": 0})
        sessions[watch.id]["playedMs"] += played
        while a < b:
            local = a.astimezone(zone)
            midnight = dt.datetime.combine(
                local.date() + dt.timedelta(days=1), dt.time.min, zone
            ).astimezone(dt.UTC)
            edge = min(b, midnight)
            if hours:
                next_hour = a + dt.timedelta(
                    minutes=60 - local.minute, seconds=-local.second,
                    microseconds=-local.microsecond,
                )
                edge = min(edge, next_hour)
                part = round((edge - a).total_seconds() * 1000)
                hours[local.hour] += part
                bucket = hour_devices[local.hour]
                bucket[watch.device_id] = bucket.get(watch.device_id, 0) + part
            part = round((edge - a).total_seconds() * 1000)
            day = local.date().isoformat()
            days[day] += part
            bucket = day_devices[day]
            bucket[watch.device_id] = bucket.get(watch.device_id, 0) + part
            a = edge
    started_query = db.query(WatchSession).filter(
        WatchSession.family_id == user.family_id, viewing
    )
    # EXISTS uses the interval/session index without multiplying sessions by
    # every heartbeat and then materializing a DISTINCT temporary result.
    started_query = started_query.filter(db.query(WatchInterval.id).filter(
        WatchInterval.session_id == WatchSession.id, WatchInterval.played_ms > 0,
    ).exists())
    if childId:
        started_query = started_query.filter(WatchSession.child_id == childId)
    if deviceId is not None:
        started_query = started_query.filter(WatchSession.device_id == deviceId)
    elif unassignedDevice:
        started_query = started_query.filter(WatchSession.device_id.is_(None))
    first = started_query.order_by(WatchSession.started_at).first()
    latest = started_query.order_by(WatchSession.last_reported_at.desc()).first()
    selected = sorted(sessions.values(), key=lambda row: (row["startedAt"], row["id"]), reverse=True)[
        (sessionPage - 1) * pageSize : sessionPage * pageSize
    ]
    keys = [row["id"] for row in selected]
    watches = {row.id: row for row in db.query(WatchSession).filter(WatchSession.id.in_(keys)).all()}
    children = {row.id: row for row in db.query(ChildProfile).filter(ChildProfile.id.in_(
        [watch.child_id for watch in watches.values() if watch.child_id])).all()}
    devices = {row.id: row for row in db.query(Device).filter(Device.id.in_(
        [watch.device_id for watch in watches.values() if watch.device_id])).all()}
    positions = dict(db.query(WatchInterval.session_id, WatchInterval.position_ms)
        .join(WatchSession, WatchSession.id == WatchInterval.session_id)
        .filter(WatchSession.id.in_(keys), WatchInterval.seq == WatchSession.last_seq).all())
    for row in selected:
        watch = watches[row["id"]]
        child, device = children.get(watch.child_id), devices.get(watch.device_id)
        row.update({"name": watch.item_name, "childName": child.name if child else "家庭观看",
            "deviceName": device.name if device else "旧设备身份",
            "positionMs": positions.get(watch.id, 0), "ended": watch.ended,
            "lastSync": aware(watch.last_reported_at).isoformat() if watch.last_reported_at else None})
    chart_devices = {row.id: row.name for row in db.query(Device).filter(
        Device.family_id == user.family_id, Device.id.in_(device_ids - {None}),
    ).all()}

    def segments(bucket):
        return [{"deviceId": key, "playedMs": bucket[key]}
                for key in sorted(bucket, key=lambda key: key or "")]

    return {
        "devices": [{"id": key, "name": chart_devices.get(key, "旧设备身份")}
                    for key in sorted(device_ids, key=lambda key: key or "")],
        "timezone": str(zone),
        "totalPlayedMs": sum(days.values()),
        "episodeCount": len(episodes),
        "statisticsSince": aware(first.started_at).isoformat() if first else None,
        "lastSync": aware(latest.last_reported_at).isoformat()
        if latest and latest.last_reported_at
        else None,
        "days": [{"date": key, "playedMs": value, "devices": segments(day_devices[key])}
                 for key, value in days.items()],
        "hours": [{"hour": hour, "playedMs": played, "devices": segments(hour_devices[hour])}
                  for hour, played in enumerate(hours)],
        "contentTotal": len(contents),
        "sessionTotal": len(sessions),
        "pageSize": pageSize,
        "contents": sorted(contents.values(), key=lambda c: (-c["playedMs"], c["id"]))[
            (contentPage - 1) * pageSize : contentPage * pageSize
        ],
        "sessions": selected,
    }
