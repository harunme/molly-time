"""Additive, auditable family media egress ledger. Never stores signed URLs."""

import datetime as dt
import uuid

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class TrafficEvent(Base):
    __tablename__ = "family_traffic_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id"))
    source: Mapped[str] = mapped_column(String(16))  # local | oss
    bytes_sent: Mapped[int] = mapped_column(BigInteger)
    occurred_at: Mapped[dt.datetime] = mapped_column(DateTime)
    recorded_at: Mapped[dt.datetime] = mapped_column(DateTime,
                                                   default=lambda: dt.datetime.now(dt.UTC))
    __table_args__ = (
        CheckConstraint("bytes_sent > 0", name="ck_traffic_positive_bytes"),
        CheckConstraint("source IN ('local', 'oss')", name="ck_traffic_source"),
        Index("ix_family_traffic_period", "family_id", "occurred_at"),
    )


class OssLogRequest(Base):
    """Public GetObject bytes, including traffic that cannot be assigned safely."""
    __tablename__ = "oss_log_requests"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    family_id: Mapped[str | None] = mapped_column(ForeignKey("families.id"))
    bytes_sent: Mapped[int] = mapped_column(BigInteger)
    occurred_at: Mapped[dt.datetime] = mapped_column(DateTime, index=True)


class OssLogImport(Base):
    __tablename__ = "oss_log_imports"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    imported_at: Mapped[dt.datetime] = mapped_column(DateTime,
                                                  default=lambda: dt.datetime.now(dt.UTC))


class OssLogSync(Base):
    __tablename__ = "oss_log_sync"
    id: Mapped[str] = mapped_column(String(16), primary_key=True, default="oss")
    last_success_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    last_attempt_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    error: Mapped[str | None] = mapped_column(String(160))
