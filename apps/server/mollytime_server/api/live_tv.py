"""Operator-managed playlist and authenticated live playback outside watch statistics."""

import datetime as dt
import http.client
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..deps import CurrentUser, DbSession
from ..live_tv import MAX_BYTES, download_playlist, parse_playlist
from ..manage_auth import aware
from ..management_models import DeviceReminder, LiveTvSettings, WatchSession
from ..models import Item
from ..transactions import external_io, serialize_sqlite_write
from .operations import Operator

router = APIRouter(tags=["live-tv"])
LIMIT_MS = 30 * 60 * 1000


def settings_dto(db, operator=False):
    row = db.get(LiveTvSettings, "platform")
    enabled = bool(row and row.enabled)
    channels = row.channels if row and (operator or enabled) else []
    return {
        "enabled": enabled,
        "channels": [{k: v for k, v in c.items() if k != "url"} for c in channels],
        "updatedAt": aware(row.updated_at).isoformat() if row else None,
        **({"sourceUrl": row.source_url if row else ""} if operator else {}),
        "limitMinutes": 30,
    }


@router.get("/api/manage/operations/live-tv")
def operator_settings(user: Operator, db: DbSession):
    return settings_dto(db, True)


class ImportBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sourceUrl: str = Field(default="", max_length=4096)
    content: str = Field(default="", max_length=MAX_BYTES)


@router.post("/api/manage/operations/live-tv/import")
def import_playlist(body: ImportBody, user: Operator, db: DbSession):
    if bool(body.sourceUrl.strip()) == bool(body.content.strip()):
        raise HTTPException(422, "请提供订阅地址或列表内容中的一种")
    try:
        with external_io(db):
            text = body.content or download_playlist(body.sourceUrl.strip())
            channels, skipped = parse_playlist(text, "platform")
    except (ValueError, OSError, http.client.HTTPException) as exc:
        raise HTTPException(
            422, str(exc) if isinstance(exc, ValueError) else "订阅下载失败，请重试或上传列表文件"
        ) from exc
    serialize_sqlite_write(db)
    row = db.get(LiveTvSettings, "platform")
    if row is None:
        row = LiveTvSettings(id="platform")
        db.add(row)
    row.source_url, row.channels = body.sourceUrl.strip(), channels
    row.enabled, row.updated_at = True, dt.datetime.now(dt.UTC)
    db.commit()
    return {**settings_dto(db, True), "skipped": skipped}


class ToggleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


@router.put("/api/manage/operations/live-tv")
def toggle(body: ToggleBody, user: Operator, db: DbSession):
    serialize_sqlite_write(db)
    row = db.get(LiveTvSettings, "platform")
    if row is None or not row.channels:
        raise HTTPException(409, "请先导入频道列表")
    row.enabled = body.enabled
    db.commit()
    return settings_dto(db, True)


@router.get("/api/live-tv")
def channels(user: CurrentUser, db: DbSession):
    return settings_dto(db)


def require_live_access(request, db):
    if getattr(request.state, "parent_preview", False):
        raise HTTPException(403, "请在已绑定的电视端观看直播")
    device_id = getattr(request.state, "device_id", None)
    from ..watch_control import require_play
    require_play(db, device_id, live=True)
    reminder = db.get(DeviceReminder, device_id) if device_id else None
    if reminder and reminder.phase != "idle":
        raise HTTPException(403, "家长已安排休息，请先在后台恢复播放")
    row = db.get(LiveTvSettings, "platform")
    if not row or not row.enabled:
        raise HTTPException(403, "运营管理员尚未开启电视直播")
    return row


@router.post("/api/live-tv/channels/{channel_id}/sessions")
def start(channel_id: str, request: Request, user: CurrentUser, db: DbSession):
    serialize_sqlite_write(db)
    config = require_live_access(request, db)
    channel = next((c for c in config.channels if c["id"] == channel_id), None)
    if channel is None:
        raise HTTPException(404, "频道已下线，请刷新列表")
    # A distinct catalog type keeps watch accounting compatible without making a
    # live stream an Episode or exposing it among the library's Series / Seasons.
    item_id = str(uuid.uuid5(uuid.NAMESPACE_URL, user.family_id + ":live:" + channel_id))
    item = db.get(Item, item_id)
    if item is None:
        item = Item(id=item_id, family_id=user.family_id, type="LiveChannel", name=channel["name"])
        db.add(item)
        db.flush()
    row = WatchSession(
        family_id=user.family_id,
        user_id=user.id,
        device_id=getattr(request.state, "device_id", None),
        item_id=item_id,
        item_name=("直播 · " + channel["name"])[:256],
        purpose="live_tv",
    )
    db.add(row)
    db.flush()
    from ..watch_control import attach_session, require_play
    attach_session(db, require_play(db, row.device_id, live=True), row.id)
    db.commit()
    return {
        "sessionId": row.id,
        "url": channel["url"],
        "name": channel["name"],
        "limitMs": LIMIT_MS,
    }


@router.get("/api/live-tv/sessions/{session_id}")
def check_session(session_id: str, request: Request, user: CurrentUser, db: DbSession):
    config = require_live_access(request, db)
    row = db.get(WatchSession, session_id)
    if (
        not row
        or row.family_id != user.family_id
        or row.user_id != user.id
        or row.device_id != getattr(request.state, "device_id", None)
    ):
        raise HTTPException(404)
    item = db.get(Item, row.item_id)
    if not item or item.type != "LiveChannel":
        raise HTTPException(404)
    active_ids = {
        str(uuid.uuid5(uuid.NAMESPACE_URL, user.family_id + ":live:" + c["id"]))
        for c in config.channels
    }
    if (
        row.ended
        or row.item_id not in active_ids
        or (dt.datetime.now(dt.UTC) - aware(row.started_at)).total_seconds() * 1000 >= LIMIT_MS
    ):
        raise HTTPException(403, "本次直播已结束，请休息一下")
    return {"ok": True}
