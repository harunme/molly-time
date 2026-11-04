"""One-time, parent-approved TV pairing with a four-digit public code."""

import datetime as dt
import hashlib
import hmac
import math
import re
import secrets
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..device_identity import IdentityProof, authenticate_identity, authorization_version, previous_device, revoke_binding
from ..accounts import account_dto
from ..auth import hash_refresh_token, issue_access_token, refresh_token_expiry
from ..config import get_settings
from ..deps import CurrentUser, DbSession
from ..manage_auth import Parent, aware
from ..management_models import Device, DevicePairing, DeviceRefresh, PairingRate, PairingIdentity, DeviceIdentityBinding
from ..models import Family, RefreshToken, User
from ..transactions import serialize_sqlite_write

router = APIRouter(tags=["device-pairing"])
CODE_SPACE = 10_000
INTERVAL = 3


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def limit(db, request, action, maximum, seconds, principal=None):
    now = dt.datetime.now(dt.UTC)
    # Authenticated lookups are limited by account, independent of proxy/IP headers.
    address = principal or (request.client.host if request.client else "unknown")
    key = hmac.new(get_settings().auth_secret.encode(), f"{action}:{address}".encode(), hashlib.sha256).hexdigest()
    row = db.get(PairingRate, key)
    if row is None:
        row = PairingRate(id=key, count=0, resets_at=now + dt.timedelta(seconds=seconds))
        db.add(row)
    elif aware(row.resets_at) <= now:
        row.count = 0
        row.resets_at = now + dt.timedelta(seconds=seconds)
    if row.count >= maximum:
        retry_after = max(1, math.ceil((aware(row.resets_at) - now).total_seconds()))
        raise HTTPException(429, "请求过于频繁，请稍后再试", headers={"Retry-After": str(retry_after)})
    row.count += 1
    # Persist unsuccessful lookup attempts as well as successful requests.
    db.commit()
    serialize_sqlite_write(db)


def public_origin(request):
    value = get_settings().public_base_url.strip().rstrip("/") or str(request.base_url).rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise HTTPException(503, "请配置正确的 MOLLYTIME_PUBLIC_BASE_URL")
    return value


class Start(BaseModel):
    identity: IdentityProof | None = None
    name: str = Field(default="MollyTime TV", min_length=1, max_length=128)


class Poll(BaseModel):
    deviceCode: str = Field(min_length=32, max_length=128)


class Confirm(BaseModel):
    code: str = Field(min_length=4, max_length=16)
    name: str = Field(default="MollyTime TV", min_length=1, max_length=128)


def find_code(db, code):
    normalized = code.strip()
    if re.fullmatch(r"[0-9]{4}", normalized) is None:
        raise HTTPException(404, "配对码不存在或已过期")
    row = db.query(DevicePairing).filter(DevicePairing.code_hash == digest(normalized)).with_for_update().first()
    if row is None or aware(row.expires_at) <= dt.datetime.now(dt.UTC) or row.status != "pending":
        raise HTTPException(404, "配对码不存在或已过期")
    return row


@router.post("/api/auth/pairing/start")
def start(body: Start, request: Request, response: Response, db: DbSession):
    response.headers["Cache-Control"] = "no-store"
    origin = public_origin(request)
    serialize_sqlite_write(db)
    limit(db, request, "start", 10, 600)
    now = dt.datetime.now(dt.UTC)
    expired_ids = db.query(DevicePairing.id).filter(DevicePairing.expires_at <= now)
    db.query(PairingIdentity).filter(PairingIdentity.pairing_id.in_(expired_ids)).delete(synchronize_session=False)
    db.query(DevicePairing).filter(DevicePairing.expires_at <= now).delete()
    db.query(PairingRate).filter(PairingRate.resets_at <= now).delete()
    # The write lock and unique code_hash keep concurrent starts distinct.
    # Reserve all unexpired codes, including approved/cancelled ones, so a code
    # still on a TV screen cannot accidentally select a different device.
    occupied = {value for (value,) in db.query(DevicePairing.code_hash).all()}
    offset = secrets.randbelow(CODE_SPACE)
    for step in range(CODE_SPACE):
        code = f"{(offset + step) % CODE_SPACE:04d}"
        if digest(code) not in occupied:
            break
    else:
        raise HTTPException(503, "配对码暂时已用完，请稍后重试")
    device_code = secrets.token_urlsafe(32)
    expires = now + dt.timedelta(minutes=10)
    name = body.name.strip() or "MollyTime TV"
    identity = authenticate_identity(db, body.identity) if body.identity else None
    db.add(DevicePairing(id=digest(device_code), code_hash=digest(code), name=name, expires_at=expires))
    db.flush()
    if identity:
        db.add(PairingIdentity(pairing_id=digest(device_code), identity_id=identity.id))
    db.commit()
    uri = f"{origin}/manage/?pair={code}"
    return {"deviceCode": device_code, "userCode": code, "verificationUri": uri,
            "verificationUriManual": f"{origin}/manage/", "expiresAt": expires.isoformat(),
            "interval": INTERVAL}


@router.get("/api/manage/pairing/{code}")
def preview(code: str, request: Request, response: Response, user: Parent, db: DbSession):
    response.headers["Cache-Control"] = "no-store"
    if user.role not in ("superadmin", "admin"):
        raise HTTPException(403, "绑定电视需要家庭管理员")
    serialize_sqlite_write(db)
    limit(db, request, "confirm", 30, 60, principal=user.id)
    row = find_code(db, code)
    link = db.get(PairingIdentity, row.id)
    previous = previous_device(db, link.identity_id, user.family_id) if link else None
    return {"name": previous.name if previous else row.name,
            "returningDevice": previous is not None,
            "expiresAt": aware(row.expires_at).isoformat()}


@router.post("/api/manage/pairing/confirm")
def confirm(body: Confirm, request: Request, response: Response, user: Parent, db: DbSession):
    response.headers["Cache-Control"] = "no-store"
    user_id = user.id
    serialize_sqlite_write(db)
    limit(db, request, "confirm", 30, 60, principal=user.id)
    # Recheck after acquiring the write lock; never bind from stale session state.
    user = db.get(User, user_id)
    if user is None or user.is_disabled or user.role not in ("superadmin", "admin"):
        raise HTTPException(403, "绑定电视需要家庭管理员")
    row = find_code(db, body.code)
    row.user_id = user.id
    row.name = body.name.strip() or row.name
    row.status = "approved"
    db.commit()
    return {"ok": True, "name": row.name}


@router.post("/api/auth/pairing/poll")
def poll(body: Poll, request: Request, response: Response, db: DbSession):
    response.headers["Cache-Control"] = "no-store"
    serialize_sqlite_write(db)
    row = db.query(DevicePairing).filter_by(id=digest(body.deviceCode)).with_for_update().first()
    now = dt.datetime.now(dt.UTC)
    if row is None or aware(row.expires_at) <= now or row.status == "cancelled":
        return {"status": "expired"}
    if row.last_polled_at and (now - aware(row.last_polled_at)).total_seconds() < INTERVAL:
        raise HTTPException(429, "请稍后查询", headers={"Retry-After": str(INTERVAL)})
    row.last_polled_at = now
    if row.status == "pending":
        db.commit()
        return {"status": "pending"}
    user = db.get(User, row.user_id)
    if user is None or user.is_disabled or user.role not in ("superadmin", "admin"):
        return {"status": "expired"}
    # A stable secret-derived refresh token makes lost responses retryable without
    # storing raw credentials or issuing duplicate devices. Rotation ends this grace period.
    raw = hmac.new(get_settings().auth_secret.encode(),
                   ("pairing-refresh:" + body.deviceCode).encode(), hashlib.sha256).hexdigest()
    token_id = hash_refresh_token(raw)
    device = db.query(Device).filter_by(id=row.device_id).with_for_update().first() if row.device_id else None
    if row.status == "delivered":
        if (device is None or device.revoked or device.user_id != user.id
                or device.family_id != user.family_id or db.query(RefreshToken).filter_by(id=token_id).with_for_update().first() is None):
            return {"status": "expired"}
    else:
        link = db.get(PairingIdentity, row.id)
        if link:
            # Serialize all binding changes for this installation, including cross-family switches.
            from ..management_models import DeviceIdentity
            db.query(DeviceIdentity).filter_by(id=link.identity_id).with_for_update().one()
            device = previous_device(db, link.identity_id, user.family_id)
            for binding in db.query(DeviceIdentityBinding).filter_by(identity_id=link.identity_id).with_for_update().all():
                previous = db.query(Device).filter_by(id=binding.device_id).with_for_update().one()
                if not previous.revoked or previous.id == (device.id if device else None):
                    revoke_binding(db, previous)
        if device is None:
            device = Device(family_id=user.family_id, user_id=user.id, name=row.name)
            db.add(device)
            db.flush()
            if link:
                db.add(DeviceIdentityBinding(device_id=device.id, identity_id=link.identity_id, family_id=user.family_id))
        device.revoked = False
        device.user_id = user.id
        device.name = row.name
        row.device_id = device.id
        row.status = "delivered"
        db.add(RefreshToken(id=token_id, user_id=user.id, expires_at=refresh_token_expiry(),
                            client_name="tv-pairing/1", user_agent=request.headers.get("user-agent", "")[:256]))
        db.flush()
        db.add(DeviceRefresh(token_id=token_id, device_id=device.id))
    access, expires = issue_access_token(user_id=user.id, family_id=user.family_id,
                                         role="device", device_id=device.id, device_version=authorization_version(db, device.id, locked=True))
    family = db.get(Family, user.family_id)
    identity = account_dto(db, user, role="device")
    db.commit()
    return {"status": "authorized", "auth": {"accessToken": access, "refreshToken": raw,
            "expiresAt": expires.isoformat(), "deviceId": device.id,
            "user": {**identity, "familyId": user.family_id},
            "family": {"id": user.family_id, "name": family.name if family else ""}}}


@router.post("/api/auth/pairing/cancel")
def cancel(body: Poll, response: Response, db: DbSession):
    response.headers["Cache-Control"] = "no-store"
    serialize_sqlite_write(db)
    row = db.query(DevicePairing).filter_by(id=digest(body.deviceCode)).with_for_update().first()
    if row and row.status in ("pending", "approved"):
        row.status = "cancelled"
        db.commit()
    return {"ok": True}


@router.post("/api/auth/pairing/reset")
def reset(request: Request, response: Response, user: CurrentUser, db: DbSession):
    """An authenticated TV may revoke only its own binding, never another TV."""
    response.headers["Cache-Control"] = "no-store"
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(403, "只允许电视重新配对自身")
    user_id, family_id = user.id, user.family_id
    serialize_sqlite_write(db)
    device = db.query(Device).filter_by(id=device_id).with_for_update().first()
    if device is None or device.user_id != user_id or device.family_id != family_id:
        raise HTTPException(401, "电视绑定已失效")
    if device.revoked or authorization_version(db, device.id) != request.state.device_version:
        raise HTTPException(401, "电视绑定已失效")
    revoke_binding(db, device)
    db.commit()
    return {"ok": True}


@router.post("/api/auth/device-identity")
def register_identity(body: IdentityProof, request: Request, response: Response, user: CurrentUser, db: DbSession):
    """Adopt an existing authenticated TV without rewriting history or its credentials."""
    response.headers["Cache-Control"] = "no-store"
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(403, "只允许已绑定电视登记身份")
    family_id, user_id = user.family_id, user.id
    serialize_sqlite_write(db)
    identity = authenticate_identity(db, body)
    device = db.query(Device).filter_by(id=device_id).with_for_update().first()
    if (device is None or device.revoked or device.family_id != family_id or device.user_id != user_id
            or authorization_version(db, device.id) != request.state.device_version):
        raise HTTPException(401, "电视绑定已失效")
    existing = db.get(DeviceIdentityBinding, device.id)
    previous = previous_device(db, identity.id, family_id)
    if (existing and existing.identity_id != identity.id) or (previous and previous.id != device.id):
        raise HTTPException(409, "设备已有不同身份关联，请重新配对")
    if existing is None:
        db.add(DeviceIdentityBinding(device_id=device.id, identity_id=identity.id, family_id=family_id))
    db.commit()
    return {"ok": True}
