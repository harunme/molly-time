"""Bounded diagnostics: authenticated ingestion, operator-only inspection, no messages."""

import datetime as dt
import re
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from ..deps import CurrentUser, DbSession
from ..manage_auth import Parent, aware
from ..management_models import ClientErrorLog, Device
from ..models import Family
from .pagination import paginate

router = APIRouter(tags=["client-diagnostics"])
Source = Literal["android-parent", "ios-parent", "web-parent", "tv-android", "tv-web"]


def redact(value: str) -> str:
    value = re.sub(r"https?://[^\s)\]<>]+", "[url]", value, flags=re.IGNORECASE)
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", value)
    value = re.sub(r"(?i)(bearer\s+)[^\s,;]+", r"\1[redacted]", value)
    value = re.sub(r"(?i)((?:cookie|authorization|pass(?:word)?|token|csrf|signature|secret)[\w-]*\s*[:=]\s*)[^\s,;]+", r"\1[redacted]", value)
    return value


class Breadcrumb(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:/-]+$")
    at: dt.datetime


class ClientErrorBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    installationId: uuid.UUID
    source: Source
    code: str = Field(min_length=1, max_length=80, pattern=r"^[A-Z0-9_]+$")
    fatal: bool = False
    errorType: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z_$][A-Za-z0-9_.$:-]*$")
    stack: list[str] = Field(default_factory=list, max_length=64)
    breadcrumbs: list[Breadcrumb] = Field(default_factory=list, max_length=20)
    screen: str = Field(default="", max_length=80, pattern=r"^[A-Za-z0-9_.:/-]*$")
    appVersion: str = Field(min_length=1, max_length=80)
    osVersion: str = Field(default="", max_length=128)
    deviceModel: str = Field(default="", max_length=128)
    occurredAt: dt.datetime

    @field_validator("stack")
    @classmethod
    def bounded_frames(cls, frames: list[str]) -> list[str]:
        if any(len(frame) > 300 or "\n" in frame or "\r" in frame for frame in frames):
            raise ValueError("invalid stack frame")
        return [redact(frame) for frame in frames]

    @field_validator("occurredAt")
    @classmethod
    def valid_time(cls, value: dt.datetime) -> dt.datetime:
        now = dt.datetime.now(dt.UTC)
        value = aware(value)
        if value < now - dt.timedelta(days=30) or value > now + dt.timedelta(minutes=5):
            raise ValueError("diagnostic timestamp outside retention window")
        return value


@router.post("/api/client/error-logs")
def report_error(body: ClientErrorBody, request: Request, user: CurrentUser, db: DbSession):
    device_id = getattr(request.state, "device_id", None)
    if device_id and body.source not in ("tv-android", "tv-web"):
        raise HTTPException(403, "电视凭证只能上报电视端日志")
    existing = db.get(ClientErrorLog, str(body.id))
    if existing:
        if (existing.user_id, existing.device_id) != (user.id, device_id):
            raise HTTPException(409, "日志编号已被使用")
        return {"ok": True}
    now = dt.datetime.now(dt.UTC)
    hourly = db.query(func.count(ClientErrorLog.id)).filter(
        ClientErrorLog.user_id == user.id,
        ClientErrorLog.device_id == device_id,
        ClientErrorLog.created_at >= now - dt.timedelta(hours=1),
    ).scalar()
    if hourly >= 120:
        raise HTTPException(429, "客户端日志上报过于频繁", headers={"Retry-After": "3600"})
    db.query(ClientErrorLog).filter(
        ClientErrorLog.created_at < now - dt.timedelta(days=30)
    ).delete(synchronize_session=False)
    db.add(ClientErrorLog(
        id=str(body.id), family_id=user.family_id, user_id=user.id, device_id=device_id,
        installation_id=str(body.installationId), source=body.source, code=body.code,
        fatal=body.fatal, error_type=body.errorType, stack=body.stack,
        breadcrumbs=[{"name": row.name, "at": aware(row.at).isoformat()} for row in body.breadcrumbs],
        screen=body.screen, app_version=redact(body.appVersion),
        os_version=redact(body.osVersion), device_model=redact(body.deviceModel),
        occurred_at=body.occurredAt, created_at=now,
    ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.get(ClientErrorLog, str(body.id))
        if existing and (existing.user_id, existing.device_id) == (user.id, device_id):
            return {"ok": True}
        if existing:
            raise HTTPException(409, "日志编号已被使用") from None
        raise
    return {"ok": True}


@router.get("/api/manage/client-error-logs")
def list_errors(
    user: Parent, db: DbSession,
    page: int = Query(default=1, ge=1), pageSize: int = Query(default=20, ge=1, le=100),
    source: Source | None = None, fatal: bool | None = None,
):
    if user.role != "superadmin":
        raise HTTPException(403, "此操作需要平台超管运营权限")
    query = db.query(ClientErrorLog).filter(
        ClientErrorLog.created_at >= dt.datetime.now(dt.UTC) - dt.timedelta(days=30)
    )
    if source:
        query = query.filter(ClientErrorLog.source == source)
    if fatal is not None:
        query = query.filter(ClientErrorLog.fatal == fatal)

    def dto(row):
        family = db.get(Family, row.family_id)
        device = db.get(Device, row.device_id) if row.device_id else None
        return {
            "id": row.id, "createdAt": aware(row.created_at).isoformat(),
            "occurredAt": aware(row.occurred_at).isoformat(), "source": row.source,
            "familyName": family.name if family else "已删除家庭",
            "deviceName": device.name if device else None,
            "code": row.code, "fatal": row.fatal, "errorType": row.error_type,
            "stack": row.stack, "breadcrumbs": row.breadcrumbs, "screen": row.screen,
            "appVersion": row.app_version, "osVersion": row.os_version,
            "deviceModel": row.device_model,
        }

    return paginate(query.order_by(ClientErrorLog.created_at.desc(), ClientErrorLog.id.desc()),
                    page, pageSize, dto)
