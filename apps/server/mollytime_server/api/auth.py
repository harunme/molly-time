"""POST /api/auth/login, /refresh, /logout."""

from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, HTTPException, Request
from fastapi import status as http_status
from pydantic import BaseModel

from ..auth import (
    hash_password,
    hash_refresh_token,
    issue_access_token,
    issue_refresh_token,
    refresh_token_expiry,
    verify_password,
)
from ..deps import DbSession
from ..management_models import Device, DeviceRefresh
from ..models import RefreshToken, User

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class LoginBody(BaseModel):
    username: str
    password: str
    familyId: str | None = None
    deviceId: str | None = None


class RefreshBody(BaseModel):
    refreshToken: str


class UserDto(BaseModel):
    id: str
    name: str
    role: str
    familyId: str


class FamilyDto(BaseModel):
    id: str
    name: str


class AuthResult(BaseModel):
    accessToken: str
    refreshToken: str
    expiresAt: str  # ISO-8601
    user: UserDto
    family: FamilyDto
    deviceId: str | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/login", response_model=AuthResult)
def login(body: LoginBody, request: Request, db: DbSession):
    query = db.query(User).filter(User.name == body.username)
    if body.familyId:
        query = query.filter(User.family_id == body.familyId)
    matches = query.limit(2).all()
    user = matches[0] if len(matches) == 1 else None
    if user is None or user.is_disabled or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED)

    device = None
    if request.headers.get("x-molly-client", "").startswith("tv-shell/"):
        device = db.get(Device, body.deviceId) if body.deviceId else None
        if device is None or device.revoked or device.user_id != user.id:
            device = Device(family_id=user.family_id, user_id=user.id)
            db.add(device)
            db.flush()
    access, exp = issue_access_token(
        user_id=user.id,
        family_id=user.family_id,
        role="device" if device else user.role,
        device_id=device.id if device else None,
    )
    raw_refresh, hashed = issue_refresh_token()
    db.add(
        RefreshToken(
            id=hashed,
            user_id=user.id,
            expires_at=refresh_token_expiry(),
            user_agent=request.headers.get("user-agent", "")[:256],
            client_name=request.headers.get("x-molly-client", "")[:64],
        )
    )
    if device:
        db.add(DeviceRefresh(token_id=hashed, device_id=device.id))
    db.commit()

    return AuthResult(
        accessToken=access,
        refreshToken=raw_refresh,
        expiresAt=exp.isoformat(),
        user=UserDto(
            id=user.id,
            name=user.name,
            role="device" if device else user.role,
            familyId=user.family_id,
        ),
        family=FamilyDto(id=user.family_id, name=""),
        deviceId=device.id if device else None,
    )


def _aware(dt_obj: dt.datetime | None) -> dt.datetime | None:
    """SQLite returns naive datetimes. Promote naive UTC datetimes to aware."""
    if dt_obj is None:
        return None
    if dt_obj.tzinfo is None:
        return dt_obj.replace(tzinfo=dt.UTC)
    return dt_obj


@router.post("/refresh", response_model=AuthResult)
def refresh(body: RefreshBody, request: Request, db: DbSession):
    hashed = hash_refresh_token(body.refreshToken)
    row = db.get(RefreshToken, hashed)
    if row is None:
        raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED)
    user = db.get(User, row.user_id)
    if user is None or user.is_disabled:
        raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED)
    link = db.get(DeviceRefresh, hashed)
    device = db.get(Device, link.device_id) if link else None
    if link and (device is None or device.revoked or device.user_id != user.id
                 or device.family_id != user.family_id):
        raise HTTPException(status_code=401)

    if device:
        # A TV binding is durable until revoked by the parent. Its cached device
        # credential stays stable so a lost refresh response cannot unpair it.
        access, exp = issue_access_token(user_id=user.id, family_id=user.family_id,
                                         role="device", device_id=device.id)
        return AuthResult(accessToken=access, refreshToken=body.refreshToken,
                          expiresAt=exp.isoformat(), deviceId=device.id,
                          user=UserDto(id=user.id, name=user.name, role="device", familyId=user.family_id),
                          family=FamilyDto(id=user.family_id, name=""))
    if _aware(row.expires_at) < dt.datetime.now(dt.UTC):
        raise HTTPException(status_code=401)

    # Rotate: delete the old refresh token, issue a new pair.
    db.delete(row)

    access, exp = issue_access_token(
        user_id=user.id,
        family_id=user.family_id,
        role="device" if device else user.role,
        device_id=device.id if device else None,
    )
    raw_refresh, new_hashed = issue_refresh_token()
    db.add(
        RefreshToken(
            id=new_hashed,
            user_id=user.id,
            expires_at=refresh_token_expiry(),
            user_agent=row.user_agent or "",
            client_name=row.client_name or "",
        )
    )
    db.commit()

    return AuthResult(
        accessToken=access,
        refreshToken=raw_refresh,
        expiresAt=exp.isoformat(),
        user=UserDto(
            id=user.id,
            name=user.name,
            role="device" if device else user.role,
            familyId=user.family_id,
        ),
        family=FamilyDto(id=user.family_id, name=""),
        deviceId=device.id if device else None,
    )


@router.post("/logout")
def logout(body: RefreshBody, db: DbSession):
    hashed = hash_refresh_token(body.refreshToken)
    row = db.get(RefreshToken, hashed)
    if row is not None:
        link = db.get(DeviceRefresh, hashed)
        if link:
            raise HTTPException(403, "请在家长管理后台取消电视配对")
        db.delete(row)
        db.commit()
    return {"ok": True}


# Test-only helper used by the create_admin script + tests. Not exposed.
def _hash_for_init(plain: str) -> str:
    return hash_password(plain)


__all__ = [
    "_hash_for_init",
    "router",
]
