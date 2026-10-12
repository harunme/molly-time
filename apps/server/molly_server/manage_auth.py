"""Same-origin parent sessions. Device credentials cannot enter management APIs."""

import datetime as dt
import logging
import secrets
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

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
    if user is None or user.is_disabled or user.role not in ("admin", "member"):
        raise HTTPException(401, "账号不可用")
    return row, user


def get_parent(request: Request, db: DbSession):
    row, user = parent_session(request, db)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        check_origin(request)
        if not secrets.compare_digest(request.headers.get("x-csrf-token", ""), row.csrf):
            raise HTTPException(403, "页面已过期，请重新加载")
        if user.role != "admin" and request.url.path not in (
            "/api/manage/auth/logout",
            "/api/manage/home-config/preview",
        ):
            raise HTTPException(403, "此操作需要家庭管理员")
    return user


Parent = Annotated[User, Depends(get_parent)]


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    familyId: str | None = None


def session_dto(row, user, db):
    family = db.get(Family, user.family_id)
    return {
        "user": {"id": user.id, "name": user.name, "role": user.role},
        "family": {"id": user.family_id, "name": family.name if family else "我的家庭"},
        "csrfToken": row.csrf,
    }


@router.post("/login")
def login(body: Login, request: Request, response: Response, db: DbSession):
    check_origin(request)
    query = db.query(User).filter(User.name == body.username)
    if body.familyId:
        query = query.filter(User.family_id == body.familyId)
    users = query.limit(2).all()
    if len(users) != 1:
        raise HTTPException(401, "账号密码错误，或需要指定家庭 ID")
    user = users[0]
    if (
        user.is_disabled
        or user.role not in ("admin", "member")
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
