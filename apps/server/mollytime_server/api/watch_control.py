"""Parent controls and PIN-authorized, device-scoped TV operations."""

import datetime as dt
import hashlib
import json
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import hash_password, verify_password
from ..deps import CurrentUser, DbSession
from ..device_presence import device_online
from ..manage_auth import Parent, aware
from ..management_models import (
    Device,
    WatchControl,
    WatchControlCommand,
    WatchControlPin,
)
from ..transactions import serialize_sqlite_write
from ..watch_control import current_round, dto, normalize, refresh_daily

router = APIRouter(tags=["watch-control"])


def owned(db, user, device_id, create=False):
    device = db.get(Device, device_id)
    if not device or device.family_id != user.family_id or device.revoked:
        raise HTTPException(404)
    row = db.query(WatchControl).filter_by(device_id=device_id).with_for_update().first()
    if row is None and create:
        row = WatchControl(device_id=device_id, family_id=user.family_id)
        db.add(row)
        db.flush()
    return row


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9-]+$")
    version: int = Field(ge=0)
    action: Literal["settings", "allow", "add", "stop", "finish-current", "reselect", "start"]
    enabled: bool | None = None
    mode: Literal["episodes", "minutes"] | None = None
    amount: int | None = Field(default=None, ge=1, le=600)
    pin: str | None = Field(default=None, pattern=r"^[0-9]{4}$")


class PinBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pin: str = Field(pattern=r"^[0-9]{4}$")


@router.put("/api/manage/watch-control/pin")
def set_pin(body: PinBody, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    row = db.get(WatchControlPin, user.family_id)
    if row is None:
        row = WatchControlPin(family_id=user.family_id)
        db.add(row)
    row.password_hash, row.failures, row.locked_until = hash_password(body.pin), 0, None
    db.commit()
    return {"ok": True}


@router.get("/api/manage/watch-control")
def devices(user: Parent, db: DbSession):
    serialize_sqlite_write(db)

    def device_state(device):
        row = owned(db, user, device.id)
        refresh_daily(db, row)
        return dto(db, row)

    pin = db.get(WatchControlPin, user.family_id)
    result = [
        {
            "deviceId": device.id,
            "name": device.name,
            "online": device_online(device),
            **device_state(device),
        }
        for device in db.query(Device).filter_by(family_id=user.family_id, revoked=False).all()
    ]
    db.commit()
    return {"pinSet": pin is not None, "devices": result}


def verify_pin(db, family_id, pin):
    row = db.query(WatchControlPin).filter_by(family_id=family_id).with_for_update().first()
    if row is None:
        # First-use setup is explicit; a paired device cannot silently replace a PIN.
        raise HTTPException(409, "请先在后台设置家长密码")
    now = dt.datetime.now(dt.UTC)
    if row.locked_until and aware(row.locked_until) > now:
        raise HTTPException(429, "密码连续输错，请 5 分钟后重试")
    if not pin or not verify_password(pin, row.password_hash):
        row.failures = (row.failures if row.locked_until is None else 0) + 1
        row.locked_until = now + dt.timedelta(minutes=5) if row.failures >= 5 else None
        db.commit()  # Failed attempts must survive the rejected request.
        raise HTTPException(
            429 if row.failures >= 5 else 403,
            "密码连续输错，请 5 分钟后重试" if row.failures >= 5 else "家长密码不正确",
        )
    row.failures, row.locked_until = 0, None


def perform(db, user, device_id, body):
    row = owned(db, user, device_id, True)
    fingerprint = hashlib.sha256(
        json.dumps(body.model_dump(exclude={"pin"}), sort_keys=True).encode()
    ).hexdigest()
    key = device_id + ":" + body.requestId
    previous = db.get(WatchControlCommand, key)
    if previous:
        if previous.fingerprint != fingerprint:
            raise HTTPException(409, "重复请求内容不一致")
        refresh_daily(db, row)
        result = dto(db, row)
        db.commit()
        return result
    refresh_daily(db, row)
    if row.version != body.version:
        db.commit()  # Keep a midnight rollover even when the old command is rejected.
        raise HTTPException(409, "电视的安排已更新，请重新操作")
    round = current_round(db, row)
    normalize(db, round)
    if body.action in ("settings", "start"):
        mode = body.mode or row.mode
        amount = (
            body.amount
            if body.amount is not None
            else (row.amount if mode == row.mode else (2 if mode == "episodes" else 30))
        )
        if mode == "episodes" and amount > 99:
            raise HTTPException(422, "集数应在 1～99 之间")
        enabled = (
            True
            if body.action == "start"
            else (row.enabled if body.enabled is None else body.enabled)
        )
        if enabled and not db.get(WatchControlPin, user.family_id):
            raise HTTPException(409, "请先设置家长密码")
        if enabled != row.enabled and round:
            round.ended = True
        row.enabled, row.mode, row.amount = enabled, mode, amount
    if body.action in ("settings", "start"):
        refresh_daily(db, row)
    elif not row.enabled:
        raise HTTPException(409, "请先开启观看管理")
    elif body.action in ("allow", "reselect"):
        raise HTTPException(409, "每日额度自动恢复，今天需要更多额度请使用加看")
    elif body.action == "add":
        if not round:
            raise HTTPException(409, "请先设置每日额度")
        if round.stop_after:
            round.stop_after = False
        if round.mode == "minutes":
            round.amount += 10
            round.limit_ms = max(round.limit_ms, round.played_ms, round.client_played_ms) + 600000
            # Manual rest discards unused minutes; add always grants ten from now.
            round.ended = False
        else:
            # Finished episodes consume one slot, regardless of folder or video.
            round.amount = (round.cursor if round.ended else round.amount) + 1
            round.ended = False
    elif body.action == "stop":
        if round:
            if round.mode == "minutes":
                round.limit_ms = max(round.played_ms, round.client_played_ms)
            elif round.cursor < len(round.playlist) and round.playlist[round.cursor]:
                round.cursor += 1
            round.ended = True
    elif body.action == "finish-current":
        if not round or round.ended or round.mode != "episodes":
            raise HTTPException(409, "当前没有按集数观看的安排")
        round.amount = round.cursor + 1
        round.stop_after = True
    row.version += 1
    db.add(WatchControlCommand(id=key, device_id=device_id, fingerprint=fingerprint))
    db.flush()
    result = dto(db, row)
    db.commit()
    logging.getLogger(__name__).info(
        "watch_control action=%s device=%s user=%s version=%s",
        body.action,
        device_id,
        user.id,
        row.version,
    )
    return result


@router.post("/api/manage/watch-control/{device_id}/commands")
def parent_command(device_id: str, body: Command, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    return perform(db, user, device_id, body)


class Sync(BaseModel):
    model_config = ConfigDict(extra="forbid")
    supported: bool = True
    acknowledged: int = Field(default=0, ge=0)
    roundId: str | None = None
    playedMs: int = Field(default=0, ge=0, le=365 * 86400000)
    cursor: int = Field(default=0, ge=0, le=10000)
    episodeId: str | None = Field(default=None, max_length=128)


@router.post("/api/watch-control/sync")
def sync(body: Sync, request: Request, user: CurrentUser, db: DbSession):
    serialize_sqlite_write(db)
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(403)
    row = owned(db, user, device_id, True)
    row.supported = body.supported
    row.acknowledged = (
        max(row.acknowledged, min(body.acknowledged, row.version)) if body.supported else 0
    )
    refresh_daily(db, row)
    round = current_round(db, row)
    if round and round.id == body.roundId:
        round.client_played_ms = max(round.client_played_ms, body.playedMs)
        if round.mode == "episodes":
            previous_cursor = round.cursor
            round.cursor = max(round.cursor, min(body.cursor, round.amount))
            if body.episodeId and body.cursor == round.cursor and round.cursor < round.amount:
                from ..models import Item
                from ..resource_policy import visible

                item = db.get(Item, body.episodeId)
                active = (
                    round.playlist[round.cursor] if round.cursor < len(round.playlist) else None
                )
                if (
                    item
                    and item.family_id == user.family_id
                    and item.type == "Episode"
                    and visible(db, item)
                    and (not active or active == body.episodeId or body.cursor > previous_cursor)
                ):
                    prefix = round.playlist[: round.cursor]
                    round.playlist = [
                        *prefix,
                        *([""] * (round.cursor - len(prefix))),
                        body.episodeId,
                    ]
            if round.cursor >= round.amount:
                round.ended = True
        normalize(db, round)
    result = {"pinSet": db.get(WatchControlPin, user.family_id) is not None, **dto(db, row)}
    db.commit()
    return result


@router.get("/api/watch-control")
def read(request: Request, user: CurrentUser, db: DbSession):
    serialize_sqlite_write(db)
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(403)
    row = owned(db, user, device_id)
    refresh_daily(db, row)
    result = {
        "pinSet": db.get(WatchControlPin, user.family_id) is not None,
        **dto(db, row),
    }
    db.commit()
    return result


@router.post("/api/watch-control/commands")
def tv_command(body: Command, request: Request, user: CurrentUser, db: DbSession):
    serialize_sqlite_write(db)
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(403)
    verify_pin(db, user.family_id, body.pin)
    return perform(db, user, device_id, body)


@router.post("/api/watch-control/pin")
def initialize_pin(body: PinBody, request: Request, user: CurrentUser, db: DbSession):
    serialize_sqlite_write(db)
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(403)
    owned(db, user, device_id)
    if db.get(WatchControlPin, user.family_id):
        raise HTTPException(409, "家长密码已设置，请在后台重设")
    db.add(WatchControlPin(family_id=user.family_id, password_hash=hash_password(body.pin)))
    db.commit()
    return {"ok": True}
