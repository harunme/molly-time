"""Private parent recordings and device-specific last-episode requests."""

import datetime as dt
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func

from ..deps import CurrentUser, DbSession
from ..device_presence import device_online
from ..manage_auth import Parent, aware
from ..management_models import (
    Device,
    DeviceBootState,
    DeviceReminder,
    FamilyReminders,
    ResourceState,
    WatchInterval,
    WatchSession,
    uid,
)
from ..models import Item, MediaFile
from ..transactions import serialize_sqlite_write
from .playback import playback_info, stream_file
from .watch_filters import family_watch_clause

router = APIRouter(tags=["parent-reminders"])
ClipKind = Literal["warning", "farewell"]
LABELS = {"warning": "还剩最后一集", "farewell": "休息提醒"}


def clip_file(db, row, kind):
    item_id = getattr(row, f"{kind}_id") if row else None
    item = db.get(Item, item_id) if item_id else None
    state = db.get(ResourceState, item_id) if item_id else None
    if not item or item.family_id != row.family_id or (state and not state.ready):
        return None
    return (
        db.query(MediaFile)
        .filter(
            MediaFile.family_id == row.family_id,
            MediaFile.item_id == item_id,
            MediaFile.kind == "video",
        )
        .first()
    )


def settings_dto(db, family_id):
    row = db.get(FamilyReminders, family_id)
    clips = {}
    for kind, label in LABELS.items():
        file = clip_file(db, row, kind)
        clips[kind] = {
            "itemId": getattr(row, f"{kind}_id") if row else None,
            "ready": file is not None,
            "name": label,
            "previewUrl": f"/api/reminders/{kind}/play" if file else None,
        }
    return {"enabled": row.enabled if row else False, **clips}


@router.get("/api/manage/reminders")
def read_reminders(user: Parent, db: DbSession):
    return settings_dto(db, user.family_id)


@router.post("/api/manage/reminders/{kind}/upload-target")
def upload_target(kind: ClipKind, user: Parent, db: DbSession):
    # Reuse normal resumable uploads, validation, storage quotas and media processing.
    serialize_sqlite_write(db)
    row = db.get(FamilyReminders, user.family_id)
    if row is None:
        row = FamilyReminders(family_id=user.family_id, enabled=False)
        db.add(row)
    folder = db.get(Item, row.folder_id) if row.folder_id else None
    if folder is None:
        folder = Item(family_id=user.family_id, type="Series", name="家长提醒视频")
        db.add(folder)
        db.flush()
        row.folder_id = folder.id
        # The parent container remains private even when upload processing finishes.
        db.add(ResourceState(item_id=folder.id, status="draft", ready=True))
    item_id = getattr(row, f"{kind}_id")
    item = db.get(Item, item_id) if item_id else None
    if item is None:
        item = Item(
            family_id=user.family_id, type="Episode", parent_id=folder.id, name=LABELS[kind]
        )
        db.add(item)
        db.flush()
        db.add(ResourceState(item_id=item.id, status="draft", ready=False))
        setattr(row, f"{kind}_id", item.id)
    db.commit()
    return {"itemId": item.id}


def authorized_clip(db, user, kind, parent_preview=False):
    row = db.get(FamilyReminders, user.family_id)
    if not row or (not row.enabled and not parent_preview):
        raise HTTPException(404)
    file = clip_file(db, row, kind)
    if file is None:
        raise HTTPException(404)
    return file


@router.get("/api/reminders/{kind}/playback")
def clip_playback(kind: ClipKind, request: Request, user: CurrentUser, db: DbSession):
    file = authorized_clip(db, user, kind, getattr(request.state, "parent_preview", False))
    info = playback_info(db, file)
    if file.storage == "local":
        info["url"] = f"/api/reminders/{kind}/play"
    info["subtitles"] = []
    return info


@router.api_route("/api/reminders/{kind}/play", methods=["GET", "HEAD"])
def play_clip(kind: ClipKind, request: Request, user: CurrentUser, db: DbSession):
    file = authorized_clip(db, user, kind, getattr(request.state, "parent_preview", False))
    return stream_file(file, request, db=db)


def device_state(db, user, device_id):
    row = db.get(DeviceReminder, device_id) if device_id else None
    if not row or row.family_id != user.family_id:
        return {"requestId": None, "phase": "idle", "episodeId": None}
    return {
        "requestId": row.request_id,
        "phase": row.phase,
        "episodeId": row.episode_id,
        "warningPath": "/api/reminders/warning/playback",
        "farewellPath": "/api/reminders/farewell/playback",
    }


@router.get("/api/reminders/state")
def reminder_state(request: Request, user: CurrentUser, db: DbSession):
    return device_state(db, user, getattr(request.state, "device_id", None))


class RequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    deviceId: str


@router.get("/api/manage/reminders/devices")
def reminder_devices(user: Parent, db: DbSession):
    at = dt.datetime.now(dt.UTC)
    devices = (
        db.query(Device).filter(Device.family_id == user.family_id, Device.revoked.is_(False)).all()
    )
    devices.sort(
        key=lambda device: (
            not device_online(device, at),
            -aware(device.last_seen).timestamp(),
            device.id,
        )
    )
    # Only the latest session on each device can still be current. Selecting
    # before filtering ended sessions prevents an older session resurfacing.
    boots = {boot.device_id: boot for boot in db.query(DeviceBootState)
             .filter(DeviceBootState.device_id.in_([device.id for device in devices])).all()}
    current = {}
    for device in devices:
        if not device_online(device, at):
            continue
        watch = db.query(WatchSession).filter(
            WatchSession.family_id == user.family_id,
            WatchSession.device_id == device.id,
            family_watch_clause(),
        ).order_by(WatchSession.started_at.desc(), WatchSession.id.desc()).first()
        if (device_online(device, at) and watch and not watch.ended
                and (device.id not in boots
                     or aware(watch.started_at) >= aware(boots[device.id].started_at))
                and aware(watch.last_reported_at or watch.started_at)
                >= at - dt.timedelta(seconds=45)):
            current[device.id] = watch
    totals = dict(db.query(WatchInterval.session_id, func.sum(WatchInterval.played_ms))
        .filter(WatchInterval.session_id.in_([watch.id for watch in current.values()]))
        .group_by(WatchInterval.session_id).all())
    boot_totals = dict(db.query(WatchSession.device_id, func.sum(WatchInterval.played_ms))
        .join(WatchInterval, WatchInterval.session_id == WatchSession.id)
        .join(DeviceBootState, DeviceBootState.device_id == WatchSession.device_id)
        .filter(WatchSession.family_id == user.family_id, family_watch_clause(),
                WatchSession.started_at >= DeviceBootState.started_at)
        .group_by(WatchSession.device_id).all())
    return [
        {
            "id": device.id,
            "name": device.name,
            "online": device_online(device, at),
            "lastSeen": aware(device.last_seen).isoformat(),
            "bootPlayedMs": boot_totals.get(device.id, 0) if device.id in boots else None,
            "bootId": boots[device.id].boot_id if device.id in boots else None,
            **device_state(db, user, device.id),
            "currentWatch": {
                "sessionId": current[device.id].id,
                "name": current[device.id].item_name,
                "playedMs": totals.get(current[device.id].id, 0),
            } if device.id in current else None,
        }
        for device in devices
    ]


@router.post("/api/manage/reminders/requests")
def request_reminder(body: RequestBody, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    device = db.get(Device, body.deviceId)
    if not device or device.family_id != user.family_id or device.revoked:
        raise HTTPException(404)
    if not device_online(device):
        raise HTTPException(409, "电视当前离线，请先打开电视上的 MollyTime，连接后再发起提醒")
    settings = db.get(FamilyReminders, user.family_id)
    if not settings or not all(clip_file(db, settings, kind) for kind in LABELS):
        raise HTTPException(422, "请先上传并处理好两段家长视频")
    row = db.get(DeviceReminder, device.id)
    if row and row.phase != "idle":
        raise HTTPException(409, "这台电视已有提醒，请先恢复播放")
    # A stale or already ended session does not consume the next episode allowance.
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=45)
    watch = (
        db.query(WatchSession)
        .filter(
            WatchSession.family_id == user.family_id,
            WatchSession.device_id == device.id,
            WatchSession.ended.is_(False),
            ((WatchSession.last_reported_at >= cutoff) | (WatchSession.started_at >= cutoff)),
        )
        .order_by(WatchSession.started_at.desc())
        .first()
    )
    if row is None:
        row = DeviceReminder(device_id=device.id, family_id=user.family_id)
        db.add(row)
    row.request_id = uid()
    row.episode_id = watch.item_id if watch else None
    row.session_id = watch.id if watch else None
    row.phase = "pending"
    settings.enabled = True
    db.commit()
    return device_state(db, user, device.id)


@router.delete("/api/manage/reminders/devices/{device_id}")
def restore_playback(device_id: str, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    row = db.get(DeviceReminder, device_id)
    if not row or row.family_id != user.family_id:
        raise HTTPException(404)
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/api/reminders/requests/{request_id}/ack")
def acknowledge(request_id: str, request: Request, user: CurrentUser, db: DbSession):
    serialize_sqlite_write(db)
    device_id = getattr(request.state, "device_id", None)
    row = db.get(DeviceReminder, device_id) if device_id else None
    if not row or row.family_id != user.family_id or row.request_id != request_id:
        raise HTTPException(404)
    if row.phase == "pending":
        row.phase = "watching"
    db.commit()
    return device_state(db, user, device_id)
