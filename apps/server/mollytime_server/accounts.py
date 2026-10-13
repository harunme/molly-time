"""Email identities and stable, public numeric IDs; UUIDs remain internal foreign keys."""

import datetime as dt
import re
import secrets

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .models import User


class AccountIdentity(Base):
    __tablename__ = "account_identities"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    account_id: Mapped[str] = mapped_column(String(10))
    email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    __table_args__ = (
        Index("uq_account_id", "account_id", unique=True),
        Index("uq_account_email", func.lower(email), unique=True),
        CheckConstraint(
            "length(account_id) = 10 AND account_id NOT GLOB '*[^0-9]*' "
            "AND substr(account_id, 1, 1) != '0'",
            name="ck_account_numeric_id",
        ),
    )


class AccountInvitation(Base):
    __tablename__ = "account_invitations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # SHA-256 of secret
    email: Mapped[str] = mapped_column(String(254), index=True)
    family_name: Mapped[str] = mapped_column(String(128))
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, default=lambda: dt.datetime.now(dt.UTC)
    )
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    accepted_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class InvitationCode(Base):
    """Retrievable invitation codes; registration still verifies the original hash."""

    __tablename__ = "invitation_codes"
    invitation_id: Mapped[str] = mapped_column(
        ForeignKey("account_invitations.id", ondelete="CASCADE"), primary_key=True
    )
    ciphertext: Mapped[str] = mapped_column(String(256))


def normalize_email(value: str) -> str:
    value = value.strip().lower()
    if len(value) > 254 or value.count("@") != 1:
        raise ValueError("请输入有效邮箱，如 name@example.com")
    local, domain = value.split("@")
    if (
        not 1 <= len(local) <= 64
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
        or re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", local) is None
    ):
        raise ValueError("请输入有效邮箱，如 name@example.com")
    labels = domain.split(".")
    if len(labels) < 2 or any(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) is None for label in labels
    ):
        raise ValueError("请输入有效邮箱，如 name@example.com")
    return value


def ensure_identity(db, user: User) -> AccountIdentity:
    identity = db.get(AccountIdentity, user.id)
    if identity is not None:
        return identity
    for _ in range(20):
        number = str(1_000_000_000 + secrets.randbelow(9_000_000_000))
        # Reserve legacy numeric usernames so an existing login never resolves
        # to a different account while that user is still binding their email.
        if db.query(User.id).filter(User.name == number).first() is not None:
            continue
        # Code allocates the number; the unique index resolves even concurrent collisions.
        try:
            with db.begin_nested():
                identity = AccountIdentity(user_id=user.id, account_id=number)
                db.add(identity)
                db.flush()
            return identity
        except IntegrityError:
            identity = db.get(AccountIdentity, user.id)
            if identity is not None:
                return identity
    raise RuntimeError("无法分配账号 ID，请重试")


def find_login_user(db, value: str) -> User | None:
    value = value.strip()
    if re.fullmatch(r"[1-9][0-9]{9}", value):
        identity = (
            db.query(AccountIdentity).filter(AccountIdentity.account_id == value).one_or_none()
        )
        if identity is not None:
            return db.get(User, identity.user_id)
    elif "@" in value:
        try:
            email = normalize_email(value)
        except ValueError:
            return None
        identity = (
            db.query(AccountIdentity)
            .filter(func.lower(AccountIdentity.email) == email)
            .one_or_none()
        )
        if identity is not None:
            return db.get(User, identity.user_id)
    # Only pre-email accounts can use their legacy username during migration.
    user = db.query(User).filter(User.name == value).one_or_none()
    identity = db.get(AccountIdentity, user.id) if user else None
    return user if user and (identity is None or identity.email is None) else None


def account_dto(db, user: User, *, role: str | None = None):
    identity = ensure_identity(db, user)
    return {
        "id": user.id,
        "name": identity.email.split("@")[0] if identity.email else user.name,
        "role": role or user.role,
        "accountId": identity.account_id,
        "email": identity.email,
    }


def backfill_identities(db):
    for user in (
        db.query(User)
        .outerjoin(AccountIdentity, AccountIdentity.user_id == User.id)
        .filter(AccountIdentity.user_id.is_(None))
        .all()
    ):
        ensure_identity(db, user)
    db.commit()
