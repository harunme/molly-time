"""Private, structured diagnostics from paired TVs."""

import datetime as dt
import re
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func

from ..deps import CurrentUser, DbSession
from ..manage_auth import Parent, aware
from ..management_models import Device, DeviceErrorLog
from ..models import Family, Item
from .pagination import paginate

device_router = APIRouter(prefix="/api/device", tags=["device-diagnostics"])
manage_router = APIRouter(prefix="/api/manage", tags=["device-diagnostics"])


class ErrorLogBody(BaseModel):
    id: uuid.UUID
    category: Literal["playback", "download", "app"]
    code: str = Field(min_length=1, max_length=80, pattern=r"^[A-Z0-9_]+$")
    causeTypes: list[str] = Field(default_factory=list, max_length=6)
    episodeId: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    mediaId: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    positionMs: int | None = Field(default=None, ge=0, le=2**63 - 1)
    availableBytes: int | None = Field(default=None, ge=0, le=2**63 - 1)
    httpStatus: int | None = Field(default=None, ge=100, le=599)
    appVersion: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9._+-]+$")

    @field_validator("causeTypes")
    @classmethod
    def valid_cause_types(cls, values: list[str]) -> list[str]:
        if any(not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_.$]{0,95}", value) for value in values):
            raise ValueError("invalid exception type")
        return values


@device_router.post("/error-logs")
def report_error(body: ErrorLogBody, request: Request, user: CurrentUser, db: DbSession):
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(403, "仅限已绑定电视上报")
    log_id = str(body.id)
    existing = db.get(DeviceErrorLog, log_id)
    if existing:
        if existing.device_id != device_id:
            raise HTTPException(409, "日志编号已被使用")
        return {"ok": True}
    now = dt.datetime.now(dt.UTC)
    hourly = (db.query(func.count(DeviceErrorLog.id))
              .filter(DeviceErrorLog.device_id == device_id,
                      DeviceErrorLog.created_at >= now - dt.timedelta(hours=1)).scalar())
    if hourly >= 60:
        raise HTTPException(429, "设备日志上报过于频繁")
    db.query(DeviceErrorLog).filter(
        DeviceErrorLog.created_at < now - dt.timedelta(days=30)
    ).delete(synchronize_session=False)
    db.add(DeviceErrorLog(
        id=log_id, family_id=user.family_id, device_id=device_id,
        category=body.category, code=body.code, cause_types=body.causeTypes,
        episode_id=body.episodeId, media_id=body.mediaId,
        position_ms=body.positionMs, available_bytes=body.availableBytes,
        http_status=body.httpStatus, app_version=body.appVersion, created_at=now,
    ))
    db.commit()
    return {"ok": True}


@manage_router.get("/device-error-logs")
def list_errors(
    user: Parent, db: DbSession,
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
    deviceId: str | None = None,
):
    if user.role != "superadmin":
        raise HTTPException(403, "此操作需要平台超管运营权限")
    query = db.query(DeviceErrorLog).filter(
        DeviceErrorLog.created_at >= dt.datetime.now(dt.UTC) - dt.timedelta(days=30),
    )
    if deviceId:
        device = db.get(Device, deviceId)
        if device is None:
            raise HTTPException(404, "设备不存在")
        query = query.filter(DeviceErrorLog.device_id == deviceId)
    query = query.order_by(DeviceErrorLog.created_at.desc(), DeviceErrorLog.id.desc())

    def dto(row):
        device = db.get(Device, row.device_id)
        family = db.get(Family, row.family_id)
        episode = db.get(Item, row.episode_id) if row.episode_id else None
        return {
            "id": row.id, "createdAt": aware(row.created_at).isoformat(),
            "familyName": family.name if family else "已删除家庭",
            "deviceId": row.device_id, "deviceName": device.name if device else "已删除设备",
            "category": row.category, "code": row.code, "causeTypes": row.cause_types,
            "episodeId": row.episode_id,
            "episodeName": episode.name if episode and episode.family_id == row.family_id else None,
            "mediaId": row.media_id, "positionMs": row.position_ms,
            "availableBytes": row.available_bytes, "httpStatus": row.http_status,
            "appVersion": row.app_version,
        }

    return paginate(query, page, pageSize, dto)
