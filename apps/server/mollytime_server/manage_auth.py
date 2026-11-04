"""Same-origin parent sessions. Device credentials cannot enter management APIs."""

import base64
import binascii
import io
import datetime as dt
import logging
import secrets
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, ConfigDict, field_validator
from PIL import Image, ImageOps, UnidentifiedImageError

from .accounts import AccountProfile, account_dto, ensure_identity, find_login_user
from .auth import hash_refresh_token, verify_password
from .deps import DbSession
from .management_models import ParentSession
from .models import Family, User

router = APIRouter(prefix="/api/manage/auth", tags=["parent-auth"])
COOKIE = "molly_parent"


def aware(value):
    return value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value


def check_origin(request: Request):
    origin = request.headers.get("origin")
    host = request.headers.get("host", "")
    matches = not origin
    if origin:
        try:
            source = urlsplit(origin)
            target = urlsplit(f"{request.url.scheme}://{host}")
            referer = urlsplit(request.headers.get("referer", ""))
            matches = source.netloc == host and source.scheme == target.scheme
            # Some local browser/proxy setups strip a non-default Origin port.
            # Require independent browser metadata; never accept a different
            # explicit port, an opaque Origin, or a cross-site request.
            if not matches:
                matches = (
                    target.hostname in {"127.0.0.1", "localhost", "::1"}
                    and target.port is not None
                    and source.hostname == target.hostname
                    and source.scheme == target.scheme
                    and source.port is None
                    and source.username is None
                    and source.password is None
                    and not source.path
                    and not source.query
                    and not source.fragment
                    and request.headers.get("sec-fetch-site") == "same-origin"
                    and referer.scheme == target.scheme
                    and referer.netloc == host
                )
        except ValueError:
            matches = False
    if not matches:
        logging.getLogger(__name__).warning(
            "Parent origin rejected: origin=%r host=%r scheme=%r fetch_site=%r",
            origin,
            host,
            request.url.scheme,
            request.headers.get("sec-fetch-site"),
        )
        raise HTTPException(403, "请求来源不匹配")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "请从管理后台操作")


def parent_session(request: Request, db):
    token = request.cookies.get(COOKIE, "")
    row = db.get(ParentSession, hash_refresh_token(token)) if token else None
    if row is None or aware(row.expires_at) <= dt.datetime.now(dt.UTC):
        raise HTTPException(401, "请登录管理后台")
    user = db.get(User, row.user_id)
    if user is None or user.is_disabled or user.role not in ("superadmin", "admin", "member"):
        raise HTTPException(401, "账号不可用")
    return row, user


def get_parent(request: Request, db: DbSession):
    row, user = parent_session(request, db)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        check_origin(request)
        if not secrets.compare_digest(request.headers.get("x-csrf-token", ""), row.csrf):
            raise HTTPException(403, "页面已过期，请重新加载")
        if user.role not in ("superadmin", "admin") and request.url.path not in (
            "/api/manage/auth/logout",
            "/api/manage/auth/profile",
            "/api/manage/password",
            "/api/manage/home-config/preview",
            "/api/manage/account/email",
        ):
            raise HTTPException(403, "此操作需要家庭管理员")
    return user


Parent = Annotated[User, Depends(get_parent)]


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)


def session_dto(row, user, db):
    family = db.get(Family, user.family_id)
    profile = db.get(AccountProfile, user.id)
    user_data = account_dto(db, user)
    user_data.update(displayName=profile.display_name if profile else None,
                     avatarJPEGBase64=profile.avatar_jpeg_base64 if profile else None)
    return {
        "user": user_data,
        "family": {"id": user.family_id, "name": family.name if family else "我的家庭"},
        "csrfToken": row.csrf,
    }


@router.post("/login")
def login(body: Login, request: Request, response: Response, db: DbSession):
    check_origin(request)
    user = find_login_user(db, body.username)
    if (
        user is None
        or user.is_disabled
        or user.role not in ("superadmin", "admin", "member")
        or not verify_password(body.password, user.password_hash)
    ):
        raise HTTPException(401, "账号密码错误")
    old = request.cookies.get(COOKIE)
    if old:
        previous = db.get(ParentSession, hash_refresh_token(old))
        if previous:
            db.delete(previous)
    raw = secrets.token_urlsafe(32)
    row = ParentSession(
        id=hash_refresh_token(raw),
        user_id=user.id,
        csrf=secrets.token_urlsafe(32),
        expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=7),
    )
    db.add(row)
    ensure_identity(db, user)
    db.commit()
    response.set_cookie(
        COOKIE,
        raw,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        max_age=7 * 86400,
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return session_dto(row, user, db)


@router.get("/session")
def session(request: Request, response: Response, db: DbSession):
    row, user = parent_session(request, db)
    response.headers["Cache-Control"] = "no-store"
    return session_dto(row, user, db)


@router.post("/logout")
def logout(request: Request, response: Response, user: Parent, db: DbSession):
    row, _ = parent_session(request, db)
    db.delete(row)
    db.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    displayName: str = Field(min_length=1, max_length=64)
    avatarJPEGBase64: str | None = Field(default=None, max_length=200_000)

    @field_validator("displayName")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("请输入有效名称")
        return value


def normalize_avatar(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "JPEG" or not (0 < image.width <= 1024 and 0 < image.height <= 1024):
                raise ValueError("invalid image")
            image.load()
            avatar = ImageOps.fit(ImageOps.exif_transpose(image).convert("RGB"), (256, 256))
            output = io.BytesIO()
            # Re-encode to discard metadata, including location data.
            avatar.save(output, format="JPEG", quality=80, optimize=True)
        encoded = base64.b64encode(output.getvalue()).decode("ascii")
        if len(encoded) > 60_000:
            raise ValueError("image too large")
        return encoded
    except (ValueError, binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError):
        raise HTTPException(422, "头像格式无效，请重新选择图片") from None


@router.put("/profile")
def update_profile(body: ProfileUpdate, request: Request, response: Response, user: Parent, db: DbSession):
    avatar = normalize_avatar(body.avatarJPEGBase64)
    profile = db.get(AccountProfile, user.id)
    if profile is None:
        profile = AccountProfile(user_id=user.id)
        db.add(profile)
    profile.display_name = body.displayName
    profile.avatar_jpeg_base64 = avatar
    db.commit()
    row, _ = parent_session(request, db)
    response.headers["Cache-Control"] = "no-store"
    return session_dto(row, user, db)
