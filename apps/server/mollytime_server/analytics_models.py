"""Additive operational metrics; no hardware identifiers or raw heartbeat history."""

import datetime as dt

from sqlalchemy import Date, DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .management_models import now


class Installation(Base):
    __tablename__ = "analytics_installations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64))
    version: Mapped[str] = mapped_column(String(32))
    first_seen: Mapped[dt.datetime] = mapped_column(DateTime, default=now, index=True)
    last_seen: Mapped[dt.datetime] = mapped_column(DateTime, default=now, index=True)
    device_id: Mapped[str | None] = mapped_column(
        ForeignKey("devices.id"), nullable=True, index=True
    )


class InstallationDay(Base):
    __tablename__ = "analytics_installation_days"
    installation_id: Mapped[str] = mapped_column(
        ForeignKey("analytics_installations.id"), primary_key=True
    )
    day: Mapped[dt.date] = mapped_column(Date, primary_key=True, index=True)


class DeviceDay(Base):
    __tablename__ = "analytics_device_days"
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)
    day: Mapped[dt.date] = mapped_column(Date, primary_key=True, index=True)
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"), index=True)
    __table_args__ = (Index("ix_analytics_family_day", "family_id", "day"),)
