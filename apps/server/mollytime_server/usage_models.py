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
