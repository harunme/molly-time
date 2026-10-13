"""Invite-only account activation. No public registration or client-selected roles."""

import datetime as dt
import secrets
import uuid

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from ..accounts import (
    AccountIdentity,
    AccountInvitation,
    account_dto,
    ensure_identity,
    normalize_email,
)
from ..auth import hash_password, hash_refresh_token, verify_password
from ..deps import DbSession
from ..manage_auth import Parent, aware, check_origin
from ..models import Family, User
from ..transactions import serialize_sqlite_write
from .operations import Operator
from .pagination import paginate
from .pairing import limit, public_origin

router = APIRouter(tags=["account-invitations"])


class EmailBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value):
        return normalize_email(value)


class InviteBody(EmailBody):
    familyName: str = Field(min_length=1, max_length=128)
    expiresInDays: int = Field(default=7, ge=1, le=14)

    @field_validator("familyName")
    @classmethod
    def valid_name(cls, value):
        if not value.strip():
            raise ValueError("请填写家庭名称")
        return value.strip()


class InvitationToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=32, max_length=128)


class ActivateBody(InvitationToken):
    password: str = Field(min_length=8, max_length=72)

    @field_validator("password")
    @classmethod
    def valid_password(cls, value):
        if len(value.encode()) > 72:
            raise ValueError("密码 UTF-8 长度不可超过 72 字节")
        return value


class BindEmailBody(EmailBody):
    currentPassword: str = Field(min_length=1, max_length=128)


def email_exists(db, email):
    return (
        db.query(AccountIdentity).filter(func.lower(AccountIdentity.email) == email).first()
        is not None
    )


def invitation_status(row):
    if row.accepted_at:
        return "accepted"
    if row.revoked_at:
        return "revoked"
    return "expired" if aware(row.expires_at) <= dt.datetime.now(dt.UTC) else "pending"


def invitation_dto(row):
    return {
        "id": row.id,
        "email": row.email,
        "familyName": row.family_name,
        "status": invitation_status(row),
        "expiresAt": aware(row.expires_at).isoformat(),
        "createdAt": aware(row.created_at).isoformat(),
    }


def pending_invitation(db, token):
    row = db.get(AccountInvitation, hash_refresh_token(token))
    inviter = db.get(User, row.created_by) if row else None
    if (
        row is None
        or invitation_status(row) != "pending"
        or inviter is None
        or inviter.is_disabled
        or inviter.role != "superadmin"
    ):
        raise HTTPException(404, "邀请无效、已使用或已过期，请联系邀请人")
    return row


@router.get("/api/manage/operations/invitations")
def invitations(
    user: Operator,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
):
    query = (
        db.query(AccountInvitation)
        .filter(AccountInvitation.created_by == user.id)
        .order_by(AccountInvitation.created_at.desc(), AccountInvitation.id)
    )
    return paginate(query, page, pageSize, invitation_dto)


@router.post("/api/manage/operations/invitations")
def create_invitation(body: InviteBody, request: Request, user: Operator, db: DbSession):
    user_id = user.id
    origin = public_origin(request)
    serialize_sqlite_write(db)
    limit(db, request, "account-invite-create", 30, 600, principal=user_id)
    user = db.get(User, user_id)
    if user is None or user.is_disabled or user.role != "superadmin":
        raise HTTPException(403, "邀请用户需要平台超管")
    if email_exists(db, body.email):
        raise HTTPException(409, "此邮箱已有账号")
    now = dt.datetime.now(dt.UTC)
    # Reissuing to an email invalidates older links, avoiding ambiguous active invitations.
    db.query(AccountInvitation).filter(
        AccountInvitation.email == body.email,
        AccountInvitation.accepted_at.is_(None),
        AccountInvitation.revoked_at.is_(None),
    ).update({"revoked_at": now})
    token = secrets.token_urlsafe(32)
    row = AccountInvitation(
        id=hash_refresh_token(token),
        email=body.email,
        family_name=body.familyName,
        created_by=user_id,
        expires_at=now + dt.timedelta(days=body.expiresInDays),
    )
    db.add(row)
    db.commit()
    return {**invitation_dto(row), "activationUrl": f"{origin}/manage/#invite={token}"}


@router.post("/api/manage/operations/invitations/{invitation_id}/revoke")
def revoke_invitation(invitation_id: str, user: Operator, db: DbSession):
    user_id = user.id
    serialize_sqlite_write(db)
    user = db.get(User, user_id)
    if user is None or user.is_disabled or user.role != "superadmin":
        raise HTTPException(403, "撤销邀请需要平台超管")
    row = db.get(AccountInvitation, invitation_id)
    if row is None or row.created_by != user_id:
        raise HTTPException(404, "邀请不存在")
    if row.accepted_at:
        raise HTTPException(409, "邀请已激活，不能撤销")
    row.revoked_at = dt.datetime.now(dt.UTC)
    db.commit()
    return {"ok": True}


@router.post("/api/manage/auth/invitation/preview")
def preview_invitation(body: InvitationToken, request: Request, db: DbSession):
    check_origin(request)
    serialize_sqlite_write(db)
    limit(db, request, "account-invite-preview", 30, 60)
    row = pending_invitation(db, body.token)
    return {
        "email": row.email,
        "familyName": row.family_name,
        "expiresAt": aware(row.expires_at).isoformat(),
    }


@router.post("/api/manage/auth/invitation/activate")
def activate_invitation(body: ActivateBody, request: Request, db: DbSession):
    check_origin(request)
    serialize_sqlite_write(db)
    limit(db, request, "account-invite-activate", 10, 600)
    pending_invitation(db, body.token)
    db.rollback()
    # Hash only after the rate/token checks, without holding the write lock.
    password_hash = hash_password(body.password)
    serialize_sqlite_write(db)
    row = pending_invitation(db, body.token)
    if email_exists(db, row.email):
        raise HTTPException(409, "此邮箱已有账号，请直接登录")
    family = Family(name=row.family_name)
    db.add(family)
    db.flush()
    user = User(
        family_id=family.id,
        name="invited-" + uuid.uuid4().hex,
        password_hash=password_hash,
        role="admin",
    )
    db.add(user)
    db.flush()
    identity = ensure_identity(db, user)
    identity.email = row.email
    row.user_id = user.id
    row.accepted_at = dt.datetime.now(dt.UTC)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "邮箱已被使用，请联系邀请人") from exc
    return {"email": identity.email, "accountId": identity.account_id, "familyName": family.name}


@router.patch("/api/manage/account/email")
def bind_email(body: BindEmailBody, user: Parent, db: DbSession):
    user_id = user.id
    serialize_sqlite_write(db)
    user = db.get(User, user_id)
    if user is None or user.is_disabled:
        raise HTTPException(401, "账号不可用")
    if not verify_password(body.currentPassword, user.password_hash):
        raise HTTPException(403, "当前密码错误")
    identity = ensure_identity(db, user)
    if identity.email is not None:
        raise HTTPException(409, "邮箱已绑定，本版本暂不支持修改")
    if email_exists(db, body.email):
        raise HTTPException(409, "此邮箱已有账号，请使用其他邮箱")
    identity.email = body.email
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "此邮箱已有账号，请使用其他邮箱") from exc
    return account_dto(db, user)
