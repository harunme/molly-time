"""Immutable share snapshots and household claims; no media bytes are copied."""

import datetime as dt
import uuid

from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .models import _now


class ContentShare(Base):
    __tablename__ = "content_shares"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, index=True)
    # Includes directory structure and metadata, never credentials or object URLs.
    snapshot: Mapped[dict] = mapped_column(JSON)


class ShareFile(Base):
    __tablename__ = "content_share_files"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    share_id: Mapped[str] = mapped_column(ForeignKey("content_shares.id"), index=True)
    source_media_id: Mapped[str] = mapped_column(String(36))
    source_item_id: Mapped[str] = mapped_column(String(36))
    storage: Mapped[str] = mapped_column(String(16))
    path: Mapped[str] = mapped_column(String(1024))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    metadata_: Mapped[dict] = mapped_column("metadata", JSON)


class ShareClaim(Base):
    __tablename__ = "content_share_claims"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    share_id: Mapped[str] = mapped_column(ForeignKey("content_shares.id"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"))
    claimed_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    resource_id: Mapped[str] = mapped_column(ForeignKey("items.id"))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
    __table_args__ = (UniqueConstraint("share_id", "family_id", name="uq_share_family_claim"),)


class SharedOrigin(Base):
    __tablename__ = "content_shared_origins"
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id"), primary_key=True)
    share_id: Mapped[str] = mapped_column(ForeignKey("content_shares.id"))
    source_item_id: Mapped[str] = mapped_column(String(36))


class ObjectCleanup(Base):
    __tablename__ = "shared_object_cleanup"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # canonical identity hash
    storage: Mapped[str] = mapped_column(String(16))
    path: Mapped[str] = mapped_column(String(1024))
    error: Mapped[str] = mapped_column(String(256), default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=_now)
