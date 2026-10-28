"""Idempotent real-playing intervals, independent of media position/duration."""

import datetime as dt

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from ..deps import CurrentUser, DbSession
from ..manage_auth import aware
from ..management_models import Device, DeviceReminder, WatchInterval, WatchProgress, WatchSession
from ..models import Item
from ..resource_policy import require_visible
from ..transactions import serialize_sqlite_write
from .playback import _child, _episode

router = APIRouter(prefix="/api/playback/sessions", tags=["watch"])


class Start(BaseModel):
    episodeId: str
    childId: str | None = None
    previousSessionId: str | None = Field(default=None, max_length=36)


@router.post("")
def start(body: Start, request: Request, user: CurrentUser, db: DbSession):
    if getattr(request.state, "parent_preview", False):
        raise HTTPException(403, "家长预览不写入儿童播放记录")
    serialize_sqlite_write(db)
    episode = _episode(db, body.episodeId, user.family_id)
    require_visible(db, episode, request)
    _child(db, body.childId, user.family_id)
    device_id = getattr(request.state, "device_id", None)
    reminder = db.get(DeviceReminder, device_id) if device_id else None
    # Only an explicit player continuation carries a reminder forward. A new
    # selection/reopened app starts a fresh viewing session, with the same quota.
    continuing_reminder = bool(
        reminder and reminder.phase in ("pending", "watching")
        and body.previousSessionId and reminder.session_id == body.previousSessionId
        and reminder.episode_id == episode.id
    )
    from ..watch_control import attach_session, require_play
    arrangement = require_play(db, device_id, episode.id, bind=True)
    row = WatchSession(
        family_id=user.family_id,
        user_id=user.id,
        child_id=None if device_id else body.childId,
        device_id=getattr(request.state, "device_id", None),
        item_id=episode.id,
        item_name=episode.name,
        purpose="child_watch" if body.childId and not device_id else (
            "family_watch" if getattr(request.state, "device_id", None) else "parent_preview"
        ),
    )
    db.add(row)
    db.flush()
    attach_session(db, arrangement, row.id)
    if reminder:
        if continuing_reminder:
            reminder.session_id = row.id
        else:
            db.delete(reminder)
    if row.device_id:
        device = db.get(Device, row.device_id)
        device.last_seen = dt.datetime.now(dt.UTC)
    db.commit()
    return {"sessionId": row.id, "serverTime": aware(row.started_at).isoformat()}


class Event(BaseModel):
    seq: int = Field(ge=0)
    startMs: int = Field(ge=0)
    endMs: int = Field(ge=0)
    playedMs: int = Field(ge=0)
    positionMs: int = Field(ge=0)
    completed: bool = False
    stopped: bool = False


@router.post("/{session_id}/events")
def report(session_id: str, body: Event, request: Request, user: CurrentUser, db: DbSession):
    # SQLite serializes writers before reading interval neighbors/progress projections.
    # This protects overlap validation from concurrent uploads with different seq values.
    serialize_sqlite_write(db)
    # MySQL must serialize validation and insertion for a session. SQLite's
    # BEGIN IMMEDIATE already does this. Current/locking reads also avoid an
    # older authentication snapshot under MySQL REPEATABLE READ.
    row = db.query(WatchSession).filter(WatchSession.id == session_id).with_for_update().first()
    if (
        row is None
        or row.family_id != user.family_id
        or row.user_id != user.id
        or row.device_id != getattr(request.state, "device_id", None)
    ):
        raise HTTPException(404)
    if getattr(request.state, "parent_preview", False):
        raise HTTPException(403)
    values = {
        "seq": body.seq,
        "start_ms": body.startMs,
        "end_ms": body.endMs,
        "played_ms": body.playedMs,
        "position_ms": body.positionMs,
        "completed": body.completed,
        "stopped": body.stopped,
    }
    previous = (
        db.query(WatchInterval)
        .filter(WatchInterval.session_id == row.id, WatchInterval.seq == body.seq)
        .with_for_update()
        .first()
    )
    if previous:
        if any(getattr(previous, key) != value for key, value in values.items()):
            raise HTTPException(409, "相同序号的播放记录内容不一致")
        return {"ok": True, "duplicate": True}
    elapsed = int((dt.datetime.now(dt.UTC) - aware(row.started_at)).total_seconds() * 1000)
    interval = body.endMs - body.startMs
    if (
        interval < 0
        or interval > 60000
        or body.playedMs not in (0, interval)
        or body.endMs > elapsed + 2000
    ):
        raise HTTPException(422, "播放时间区间无效")
    # Validate neighbors as well as overlap: reordered uploads retain their sequence timeline.
    lower = (
        db.query(WatchInterval)
        .filter(WatchInterval.session_id == row.id, WatchInterval.seq < body.seq)
        .order_by(WatchInterval.seq.desc())
        .with_for_update()
        .first()
    )
    upper = (
        db.query(WatchInterval)
        .filter(WatchInterval.session_id == row.id, WatchInterval.seq > body.seq)
        .order_by(WatchInterval.seq)
        .with_for_update()
        .first()
    )
    if (
        (lower and lower.end_ms > body.startMs)
        or (upper and body.endMs > upper.start_ms)
        or (lower and lower.stopped)
    ):
        raise HTTPException(422, "播放区间重叠或会话已结束")
    if body.stopped and upper:
        raise HTTPException(422, "结束记录不是最后一条")
    db.add(WatchInterval(session_id=row.id, **values))
    from ..watch_control import report as report_control
    report_control(db, row.id, body)
    if body.seq > row.last_seq:
        row.last_seq, row.ended = body.seq, body.stopped
        row.last_reported_at = dt.datetime.now(dt.UTC)
        if row.device_id:
            db.get(Device, row.device_id).last_seen = row.last_reported_at
            reminder = db.get(DeviceReminder, row.device_id)
            if reminder and reminder.session_id == row.id and body.completed and body.stopped:
                reminder.phase = "done"
        scope = row.child_id or ("family" if row.device_id else user.id)
        key = f"{user.family_id}:{scope}:{row.item_id}"
        progress = db.get(WatchProgress, key)
        # Newer session wins. Late events from old sessions cannot roll progress back.
        is_live = db.get(Item, row.item_id).type == "LiveChannel"
        if is_live:
            pass  # Live control events never contribute episode resume progress or watch statistics.
        elif progress is None:
            progress = WatchProgress(
                id=key,
                family_id=user.family_id,
                child_id=row.child_id,
                item_id=row.item_id,
                session_id=row.id,
                session_started_at=row.started_at,
                seq=body.seq,
                position_ms=body.positionMs,
                completed=body.completed,
            )
            db.add(progress)
        elif (aware(progress.session_started_at), progress.session_id) <= (
            aware(row.started_at),
            row.id,
        ):
            progress.session_id, progress.session_started_at = row.id, row.started_at
            progress.seq, progress.position_ms, progress.completed = (
                body.seq,
                body.positionMs,
                body.completed,
            )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        # A concurrently committed duplicate is retried through the equality check above.
        raise HTTPException(409, "记录同时提交，请重试") from exc
    return {"ok": True, "duplicate": False}
