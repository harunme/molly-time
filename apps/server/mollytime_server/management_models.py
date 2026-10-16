"""Additive management schema; existing catalog IDs and scan tables stay intact."""

import datetime as dt
import uuid

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def now():
    return dt.datetime.now(dt.UTC)


def uid():
    return str(uuid.uuid4())


class SchemaRevision(Base):
    __tablename__ = "schema_revisions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    applied_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class ParentSession(Base):
    __tablename__ = "parent_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    csrf: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime)


class FamilySettings(Base):
    __tablename__ = "family_settings"
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), primary_key=True)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Shanghai")


class PlaybackSettings(Base):
    """Shared family playback preferences; additive for existing databases."""

    __tablename__ = "playback_settings"
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), primary_key=True)
    default_subtitle: Mapped[str] = mapped_column(String(16), default="zh")


class FamilyReminders(Base):
    """Private parent clips; a separate table keeps existing databases additive."""

    __tablename__ = "family_reminders"
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("items.id"), nullable=True)
    warning_id: Mapped[str | None] = mapped_column(ForeignKey("items.id"), nullable=True)
    farewell_id: Mapped[str | None] = mapped_column(ForeignKey("items.id"), nullable=True)


class DeviceReminder(Base):
    """A parent grants one last episode to one paired TV, then blocks replay."""

    __tablename__ = "device_reminders"
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    request_id: Mapped[str] = mapped_column(String(36), default=uid)
    episode_id: Mapped[str | None] = mapped_column(ForeignKey("items.id"), nullable=True)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("watch_sessions.id"), nullable=True)
    phase: Mapped[str] = mapped_column(String(16), default="pending")


class ResourceState(Base):
    __tablename__ = "resource_states"
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id"), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)
    ready: Mapped[bool] = mapped_column(Boolean, default=False)
    published_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class TrashEntry(Base):
    __tablename__ = "trash_entries"
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id"), primary_key=True)
    archived_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now, index=True)
    previous_status: Mapped[str] = mapped_column(String(16), default="draft")
    deleting: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str] = mapped_column(String(256), default="")
    deleted_objects: Mapped[list] = mapped_column(JSON, default=list)


class TrashSettings(Base):
    __tablename__ = "trash_settings"
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), primary_key=True)
    retention_days: Mapped[int] = mapped_column(Integer, default=7)  # 0 disables expiry.


class UploadSession(Base):
    __tablename__ = "upload_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id"))
    filename: Mapped[str] = mapped_column(String(256))
    kind: Mapped[str] = mapped_column(String(16))
    size: Mapped[int] = mapped_column(BigInteger)
    fingerprint: Mapped[str] = mapped_column(String(128))
    offset: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(16), default="uploading")
    error: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String(32), default="und")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)

    __table_args__ = (
        Index("ix_upload_family_status", "family_id", "status"),
        Index("ix_upload_item_kind_status", "item_id", "kind", "status"),
    )


class MediaTask(Base):
    __tablename__ = "media_tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    upload_id: Mapped[str] = mapped_column(ForeignKey("upload_sessions.id"), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_until: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class HomeConfig(Base):
    __tablename__ = "home_configs"
    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    child_id: Mapped[str | None] = mapped_column(ForeignKey("child_profiles.id"), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    draft: Mapped[dict] = mapped_column(JSON)
    published_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class HomeRevision(Base):
    __tablename__ = "home_revisions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    config_id: Mapped[str] = mapped_column(ForeignKey("home_configs.id"), index=True)
    content: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(128), default="MollyTime")
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class DeviceErrorLog(Base):
    """Bounded, structured device diagnostics. Never store request URLs or credentials."""

    __tablename__ = "device_error_logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    category: Mapped[str] = mapped_column(String(24))
    code: Mapped[str] = mapped_column(String(80))
    cause_types: Mapped[list] = mapped_column(JSON, default=list)
    episode_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    media_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    position_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    available_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    app_version: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now, index=True)


class DeviceRefresh(Base):
    __tablename__ = "device_refreshes"
    token_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)


class DevicePairing(Base):
    __tablename__ = "device_pairings"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="pending")
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, index=True)
    last_polled_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)


class PairingRate(Base):
    __tablename__ = "pairing_rates"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, default=0)
    resets_at: Mapped[dt.datetime] = mapped_column(DateTime, index=True)


class WatchSession(Base):
    __tablename__ = "watch_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    child_id: Mapped[str | None] = mapped_column(ForeignKey("child_profiles.id"), nullable=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id"))
    item_name: Mapped[str] = mapped_column(String(256))
    purpose: Mapped[str] = mapped_column(String(32))
    started_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
    last_reported_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    last_seq: Mapped[int] = mapped_column(Integer, default=-1)
    ended: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (
        Index("ix_watch_family_started", "family_id", "started_at"),
        Index("ix_watch_device_started", "device_id", "started_at"),
    )


class WatchInterval(Base):
    __tablename__ = "watch_intervals"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("watch_sessions.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(BigInteger)
    end_ms: Mapped[int] = mapped_column(BigInteger)
    played_ms: Mapped[int] = mapped_column(BigInteger)
    position_ms: Mapped[int] = mapped_column(BigInteger)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    stopped: Mapped[bool] = mapped_column(Boolean, default=False)
    __table_args__ = (
        UniqueConstraint("session_id", "seq"),
        Index("ix_watch_session_interval", "session_id", "start_ms", "end_ms"),
    )


class WatchProgress(Base):
    __tablename__ = "watch_progress"
    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"))
    child_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id"))
    session_id: Mapped[str] = mapped_column(ForeignKey("watch_sessions.id"))
    session_started_at: Mapped[dt.datetime] = mapped_column(DateTime)
    seq: Mapped[int] = mapped_column(Integer)
    position_ms: Mapped[int] = mapped_column(BigInteger)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)


class UploadTarget(Base):
    """Additive upload transport data; legacy sessions remain local."""

    __tablename__ = "upload_targets"
    upload_id: Mapped[str] = mapped_column(ForeignKey("upload_sessions.id"), primary_key=True)
    backend: Mapped[str] = mapped_column(String(16), default="local")
    object_key: Mapped[str] = mapped_column(String(1024), default="")
    multipart_id: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime)


class MediaOptions(Base):
    __tablename__ = "media_options"
    media_id: Mapped[str] = mapped_column(ForeignKey("media_files.id"), primary_key=True)
    retention: Mapped[str] = mapped_column(String(16), default="backup")
    label: Mapped[str] = mapped_column(String(256), default="")
    offset_ms: Mapped[int] = mapped_column(Integer, default=0)


class DeviceDownload(Base):
    __tablename__ = "device_downloads"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    media_id: Mapped[str] = mapped_column(ForeignKey("media_files.id"), index=True)
    desired: Mapped[str] = mapped_column(String(16), default="saved")
    status: Mapped[str] = mapped_column(String(16), default="queued")
    downloaded_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    error: Mapped[str] = mapped_column(String(256), default="")
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (UniqueConstraint("device_id", "media_id"),)


class OperationsStorage(Base):
    __tablename__ = "operations_storage"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    config: Mapped[dict] = mapped_column(JSON)
    updated_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
