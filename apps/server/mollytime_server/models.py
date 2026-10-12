"""ORM models for MollyTime Server.

Family is the unit of isolation (P0). A Family owns Users (parents) and
later will own ChildProfiles (kids) + MediaItems.

We keep `View`, `Item`, `MediaFile`, `PlaybackEvent` from the previous
schema for catalog, uploaded media and playback history. The API layer never
exposes `View`; Items/MediaFiles/PlaybackEvents are accessed through our
own shape in `api/catalog.py` and `api/playback.py`.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------------------
# Family / User / ChildProfile / RefreshToken
# ---------------------------------------------------------------------------


class Family(Base):
    __tablename__ = "families"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)

    users: Mapped[list["User"]] = relationship(back_populates="family")
    children: Mapped[list["ChildProfile"]] = relationship(back_populates="family")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    family_id: Mapped[str] = mapped_column(String(36), ForeignKey("families.id"), index=True)
    name: Mapped[str] = mapped_column(String(64), index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(16), default="admin")  # 'superadmin' | 'admin' | 'member'
    is_disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)

    family: Mapped[Family] = relationship(back_populates="users")
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(back_populates="user")

    __table_args__ = (UniqueConstraint("family_id", "name", name="uq_user_family_name"),)


class ChildProfile(Base):
    """A kid profile. P0: data only, no per-child access enforcement."""

    __tablename__ = "child_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    family_id: Mapped[str] = mapped_column(String(36), ForeignKey("families.id"), index=True)
    name: Mapped[str] = mapped_column(String(64))
    avatar_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)

    family: Mapped[Family] = relationship(back_populates="children")

    __table_args__ = (UniqueConstraint("family_id", "name", name="uq_child_family_name"),)


class RefreshToken(Base):
    """Opaque refresh token. Stores SHA-256(token), not the token itself."""

    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 hex
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    issued_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    last_used_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime)
    user_agent: Mapped[str] = mapped_column(String(256), default="")
    client_name: Mapped[str] = mapped_column(String(64), default="")

    user: Mapped[User] = relationship(back_populates="refresh_tokens")

    __table_args__ = (Index("ix_refresh_user_expires", "user_id", "expires_at"),)


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


class View(Base):
    """Legacy default-view row. The new API exposes /api/home rows directly
    and does not surface this table. Kept for backwards compat with the
    scan script."""

    __tablename__ = "views"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    family_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("families.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(128))
    collection_type: Mapped[str] = mapped_column(String(32), default="tvshows")
    sort_index: Mapped[int] = mapped_column(Integer, default=0)


class Item(Base):
    """Series / Season / Episode / Movie — referenced by MediaFile + PlaybackEvent."""

    __tablename__ = "items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    family_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("families.id"), nullable=True)
    view_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("views.id"), nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("items.id"), nullable=True)
    type: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str] = mapped_column(String(256))
    sort_name: Mapped[str] = mapped_column(String(256), default="")
    overview: Mapped[str] = mapped_column(Text, default="")
    index_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parent_index_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    premiere_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    runtime_ticks: Mapped[int | None] = mapped_column(Integer, nullable=True)
    community_rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    primary_image_tag: Mapped[str] = mapped_column(String(32), default="")
    image_count: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        UniqueConstraint("family_id", "view_id", "parent_id", "name", "type", name="uq_item_family_parent_name_type"),
    )


class MediaFile(Base):
    __tablename__ = "media_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    family_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("families.id"), nullable=True)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("items.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # 'video' | 'subtitle' | 'image'
    storage: Mapped[str] = mapped_column(String(16))  # 'local' | 'oss'
    path: Mapped[str] = mapped_column(String(1024))
    mime: Mapped[str] = mapped_column(String(64), default="")
    language: Mapped[str] = mapped_column(String(16), default="")
    index: Mapped[int] = mapped_column(Integer, default=0)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")


class PlaybackEvent(Base):
    __tablename__ = "playback_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    family_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("families.id"), nullable=True)
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    child_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("child_profiles.id"), nullable=True)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("items.id"), index=True)
    position_ms: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    event: Mapped[str] = mapped_column(String(16), default="progress")  # start | progress | stop
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    reported_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)