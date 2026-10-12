"""Children, device revocation, timezone and real-time watch reports."""

import datetime as dt
import shutil
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from ..auth import hash_password, verify_password
from ..config import get_settings
from ..deps import DbSession
from ..manage_auth import Parent, aware
from ..management_models import Device, FamilySettings, WatchInterval, WatchSession
from ..models import ChildProfile, Item
from .manage_resources import owned

router = APIRouter(prefix="/api/manage", tags=["manage-family"])


@router.get("/children")
def children(user: Parent, db: DbSession):
    return [
        {"id": c.id, "name": c.name}
        for c in db.query(ChildProfile)
        .filter(ChildProfile.family_id == user.family_id)
        .order_by(ChildProfile.created_at)
        .all()
    ]


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
def devices(user: Parent, db: DbSession):
    return [
        {
            "id": r.id,
            "name": r.name,
            "revoked": r.revoked,
            "createdAt": aware(r.created_at).isoformat(),
            "lastSeen": aware(r.last_seen).isoformat(),
        }
        for r in db.query(Device)
        .filter(Device.family_id == user.family_id)
        .order_by(Device.created_at.desc())
        .all()
    ]


class DeviceBody(BaseModel):
    name: str = Field(min_length=1, max_length=128)


@router.patch("/devices/{device_id}")
def rename_device(device_id: str, body: DeviceBody, user: Parent, db: DbSession):
    row = owned(db, Device, device_id, user.family_id)
    row.name = body.name.strip() or "Molly TV"
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
    path = get_settings().resolved_media_dir()
    path.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(path)
    return {
        "timezone": row.timezone if row else "Asia/Shanghai",
        "storage": {"total": disk.total, "free": disk.free},
    }


class SettingsBody(BaseModel):
    timezone: str = Field(max_length=64)


@router.put("/settings")
def edit_settings(body: SettingsBody, user: Parent, db: DbSession):
    try:
        ZoneInfo(body.timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(422, "时区无效，例如 Asia/Shanghai") from exc
    row = db.get(FamilySettings, user.family_id)
    if row is None:
        row = FamilySettings(family_id=user.family_id)
        db.add(row)
    row.timezone = body.timezone
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
def report(user: Parent, db: DbSession, start: dt.date, end: dt.date, childId: str | None = None):
    if childId:
        owned(db, ChildProfile, childId, user.family_id)
    if end < start or (end - start).days > 365:
        raise HTTPException(422, "请查询不超过一年的日期范围")
    config = db.get(FamilySettings, user.family_id)
    zone = ZoneInfo(config.timezone if config else "Asia/Shanghai")
    lower = dt.datetime.combine(start, dt.time.min, zone).astimezone(dt.UTC)
    upper = dt.datetime.combine(end + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)
    query = (
        db.query(WatchSession, WatchInterval)
        .join(WatchInterval, WatchInterval.session_id == WatchSession.id)
        .filter(
            WatchSession.family_id == user.family_id,
            WatchSession.purpose == "child_watch",
            WatchSession.started_at < upper,
        )
    )
    if childId:
        query = query.filter(WatchSession.child_id == childId)
    days = {(start + dt.timedelta(days=i)).isoformat(): 0 for i in range((end - start).days + 1)}
    contents, sessions, episodes = {}, {}, set()
    for watch, interval in query.all():
        if not interval.played_ms:
            continue
        a = max(aware(watch.started_at) + dt.timedelta(milliseconds=interval.start_ms), lower)
        b = min(aware(watch.started_at) + dt.timedelta(milliseconds=interval.end_ms), upper)
        if b <= a:
            continue
        played = round((b - a).total_seconds() * 1000)
        episodes.add(watch.item_id)
        episode = db.get(Item, watch.item_id)
        season = db.get(Item, episode.parent_id) if episode and episode.parent_id else None
        series = db.get(Item, season.parent_id) if season and season.parent_id else None
        name = series.name if series else watch.item_name
        content_id = series.id if series else watch.item_id
        bucket = contents.setdefault(content_id, {"id": content_id, "name": name, "playedMs": 0})
        bucket["playedMs"] += played
        if watch.id not in sessions:
            child = db.get(ChildProfile, watch.child_id)
            device = db.get(Device, watch.device_id) if watch.device_id else None
            latest_event = (
                db.query(WatchInterval)
                .filter(WatchInterval.session_id == watch.id, WatchInterval.seq == watch.last_seq)
                .first()
            )
            sessions[watch.id] = {
                "id": watch.id,
                "name": watch.item_name,
                "childName": child.name if child else "未知儿童",
                "deviceName": device.name if device else "旧设备身份",
                "startedAt": aware(watch.started_at).isoformat(),
                "playedMs": 0,
                "positionMs": latest_event.position_ms if latest_event else 0,
                "ended": watch.ended,
                "lastSync": aware(watch.last_reported_at).isoformat()
                if watch.last_reported_at
                else None,
            }
        sessions[watch.id]["playedMs"] += played
        if interval.seq == watch.last_seq:
            sessions[watch.id]["positionMs"] = interval.position_ms
        while a < b:
            local = a.astimezone(zone)
            midnight = dt.datetime.combine(
                local.date() + dt.timedelta(days=1), dt.time.min, zone
            ).astimezone(dt.UTC)
            edge = min(b, midnight)
            days[local.date().isoformat()] += round((edge - a).total_seconds() * 1000)
            a = edge
    started_query = db.query(WatchSession).filter(
        WatchSession.family_id == user.family_id, WatchSession.purpose == "child_watch"
    )
    started_query = (
        started_query.join(WatchInterval, WatchInterval.session_id == WatchSession.id)
        .filter(WatchInterval.played_ms > 0)
        .distinct()
    )
    if childId:
        started_query = started_query.filter(WatchSession.child_id == childId)
    first = started_query.order_by(WatchSession.started_at).first()
    latest = started_query.order_by(WatchSession.last_reported_at.desc()).first()
    return {
        "timezone": str(zone),
        "totalPlayedMs": sum(days.values()),
        "episodeCount": len(episodes),
        "statisticsSince": aware(first.started_at).isoformat() if first else None,
        "lastSync": aware(latest.last_reported_at).isoformat()
        if latest and latest.last_reported_at
        else None,
        "days": [{"date": key, "playedMs": value} for key, value in days.items()],
        "contents": sorted(contents.values(), key=lambda c: -c["playedMs"]),
        "sessions": sorted(sessions.values(), key=lambda r: r["startedAt"], reverse=True)[:200],
    }
