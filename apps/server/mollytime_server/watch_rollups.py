"""Transactional watch projections and resumable, generation-scoped backfills.

Raw intervals remain authoritative. Reads never rebuild history. New intervals
and their contributions commit together; backfills share the same family row
lock and contribution keys, so retries and concurrent arrivals cannot double count.
"""

import argparse
import datetime as dt
import logging
import threading
import uuid
from collections import defaultdict
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import BigInteger, DateTime, Index, String, case, event, func, inspect, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from .db import Base, get_session_factory
from .management_models import FamilySettings, WatchInterval, WatchSession
from .models import Family, Item
from .transactions import serialize_sqlite_write

DEFAULT_ZONE = "Asia/Shanghai"
log = logging.getLogger(__name__)


class WatchRollupState(Base):
    __tablename__ = "watch_rollup_states"
    family_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    active_generation: Mapped[str | None] = mapped_column(String(36), nullable=True)
    active_zone: Mapped[str] = mapped_column(String(64), default=DEFAULT_ZONE)
    building_generation: Mapped[str | None] = mapped_column(String(36), nullable=True)
    building_zone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    cursor: Mapped[int] = mapped_column(BigInteger, default=0)


class WatchContribution(Base):
    __tablename__ = "watch_contributions"
    generation: Mapped[str] = mapped_column(String(36), primary_key=True)
    interval_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    session_id: Mapped[str] = mapped_column(String(36))
    item_id: Mapped[str] = mapped_column(String(36))
    # Ineligible/paused intervals still receive an idempotency marker.
    start_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    __table_args__ = (Index("ix_watch_contribution_future", "generation", "end_at"),)


class WatchSessionTotal(Base):
    __tablename__ = "watch_session_totals"
    generation: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(36))
    started_at: Mapped[dt.datetime] = mapped_column(DateTime)
    first_at: Mapped[dt.datetime] = mapped_column(DateTime)
    played_ms: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (
        Index("ix_watch_total_started", "generation", "started_at"),
        Index("ix_watch_total_first", "generation", "first_at"),
    )


class WatchDayTotal(Base):
    __tablename__ = "watch_day_totals"
    generation: Mapped[str] = mapped_column(String(36), primary_key=True)
    day: Mapped[str] = mapped_column(String(10), primary_key=True)
    played_ms: Mapped[int] = mapped_column(BigInteger)


class WatchItemTotal(Base):
    __tablename__ = "watch_item_totals"
    generation: Mapped[str] = mapped_column(String(36), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    item_name: Mapped[str] = mapped_column(String(256))
    played_ms: Mapped[int] = mapped_column(BigInteger)
    play_count: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (
        Index("ix_watch_item_duration", "generation", "played_ms", "item_id"),
        Index("ix_watch_item_count", "generation", "play_count", "item_id"),
    )


def utc(value):
    return value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value.astimezone(dt.UTC)


def naive(value):
    return utc(value).replace(tzinfo=None)


def milliseconds(start, end):
    return max(0, round((end - start).total_seconds() * 1000))


def day_parts(start, end, zone):
    result = {}
    while start < end:
        local = start.astimezone(zone)
        midnight = dt.datetime.combine(local.date() + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)
        edge = min(end, midnight)
        result[local.date().isoformat()] = milliseconds(start, edge)
        start = edge
    return result


def upsert(db, model, values, changes):
    table = model.__table__
    if db.get_bind().dialect.name == "sqlite":
        statement = sqlite_insert(table).values(**values)
        statement = statement.on_conflict_do_update(index_elements=list(table.primary_key), set_=changes)
    else:
        statement = mysql_insert(table).values(**values).on_duplicate_key_update(**changes)
    db.execute(statement)


def source_rows(db):
    return select(
        WatchInterval.id.label("interval_id"), WatchInterval.start_ms, WatchInterval.end_ms, WatchInterval.played_ms,
        WatchSession.id.label("session_id"), WatchSession.family_id, WatchSession.item_id,
        WatchSession.item_name, WatchSession.started_at, WatchSession.purpose, WatchSession.device_id,
        Item.type.label("item_type"),
    ).select_from(WatchInterval).join(WatchSession, WatchSession.id == WatchInterval.session_id).outerjoin(Item, Item.id == WatchSession.item_id)


def eligible(row):
    return (row["item_type"] != "LiveChannel" and (
        row["purpose"] in ("child_watch", "family_watch")
        or (row["purpose"] == "parent_preview" and row["device_id"] is not None)
    ) and row["played_ms"] > 0 and row["end_ms"] > row["start_ms"])


def family_state(db, family, *, new=False):
    table = WatchRollupState.__table__
    row = db.execute(select(table).where(table.c.family_id == family).with_for_update()).mappings().first()
    if row is None:
        zone = db.scalar(select(FamilySettings.timezone).where(FamilySettings.family_id == family)) or DEFAULT_ZONE
        history = None if new else db.scalar(select(WatchInterval.id).join(WatchSession).where(WatchSession.family_id == family).limit(1))
        generation = str(uuid.uuid4())
        values = {"family_id": family, "active_generation": None if history else generation,
                  "active_zone": zone, "building_generation": generation if history else None,
                  "building_zone": zone if history else None, "cursor": 0}
        # A no-op conflict update serializes concurrent initialization too.
        upsert(db, WatchRollupState, values, {"family_id": table.c.family_id})
        row = db.execute(select(table).where(table.c.family_id == family).with_for_update()).mappings().one()
    return dict(row)


def queue_rebuild(db, family, *, zone=None):
    state = family_state(db, family)
    zone = zone or db.scalar(select(FamilySettings.timezone).where(FamilySettings.family_id == family)) or DEFAULT_ZONE
    # Empty families can adopt a timezone immediately without a background job.
    has_history = db.scalar(select(WatchInterval.id).join(WatchSession).where(WatchSession.family_id == family).limit(1))
    values = ({"active_zone": zone, "active_generation": str(uuid.uuid4()),
               "building_generation": None, "building_zone": None, "cursor": 0} if not has_history else
              {"building_generation": str(uuid.uuid4()), "building_zone": zone, "cursor": 0})
    db.execute(WatchRollupState.__table__.update().where(WatchRollupState.family_id == state["family_id"]).values(**values))


def project_batch(db, generation, zone_name, records):
    if not records:
        return
    applied = set(db.scalars(select(WatchContribution.interval_id).where(
        WatchContribution.generation == generation,
        WatchContribution.interval_id.in_([row["interval_id"] for row in records]),
    )))
    records = [row for row in records if row["interval_id"] not in applied]
    if not records:
        return
    zone = ZoneInfo(zone_name)
    sessions = {row["session_id"]: dict(row) for row in db.execute(select(WatchSessionTotal.__table__).where(
        WatchSessionTotal.generation == generation,
        WatchSessionTotal.session_id.in_({row["session_id"] for row in records}),
    )).mappings()}
    changed_sessions = set()
    days, items, markers = defaultdict(int), {}, []
    for row in records:
        start = utc(row["started_at"]) + dt.timedelta(milliseconds=row["start_ms"])
        end = utc(row["started_at"]) + dt.timedelta(milliseconds=row["end_ms"])
        included = eligible(row)
        markers.append({"generation": generation, "interval_id": row["interval_id"],
                        "session_id": row["session_id"], "item_id": row["item_id"],
                        "start_at": naive(start) if included else None, "end_at": naive(end) if included else None})
        if not included:
            continue
        amount = milliseconds(start, end)
        for day, value in day_parts(start, end, zone).items():
            days[day] += value
        content = items.setdefault(row["item_id"], {"item_name": row["item_name"], "played_ms": 0, "play_count": 0})
        content["played_ms"] += amount
        previous = sessions.get(row["session_id"])
        if previous is None:
            content["play_count"] += 1
            previous = {"generation": generation, "session_id": row["session_id"], "item_id": row["item_id"],
                        "started_at": naive(row["started_at"]), "first_at": naive(start), "played_ms": 0}
            sessions[row["session_id"]] = previous
        previous["first_at"] = min(previous["first_at"], naive(start))
        previous["played_ms"] += amount
        changed_sessions.add(row["session_id"])
    db.execute(WatchContribution.__table__.insert(), markers)
    for key in sorted(changed_sessions):
        values = sessions[key]
        upsert(db, WatchSessionTotal, values, {name: values[name] for name in ("first_at", "played_ms")})
    for day, amount in sorted(days.items()):
        upsert(db, WatchDayTotal, {"generation": generation, "day": day, "played_ms": amount},
               {"played_ms": WatchDayTotal.played_ms + amount})
    for key, value in sorted(items.items()):
        upsert(db, WatchItemTotal, {"generation": generation, "item_id": key, **value},
               {"played_ms": WatchItemTotal.played_ms + value["played_ms"],
                "play_count": WatchItemTotal.play_count + value["play_count"]})


@event.listens_for(Session, "before_flush")
def collect_changes(db, _context, _instances):
    pending = db.info.setdefault("watch_rollup_pending", {"families": set(), "zones": set(), "rebuild": set(), "intervals": []})
    for obj in list(db.new) + list(db.dirty) + list(db.deleted):
        if isinstance(obj, Family) and obj in db.new:
            pending["families"].add(obj)
        elif isinstance(obj, FamilySettings) and (obj in db.new or obj in db.deleted or inspect(obj).attrs.timezone.history.has_changes()):
            pending["zones"].add(obj.family_id)
        elif isinstance(obj, WatchInterval):
            if obj in db.new:
                pending["intervals"].append(obj)
            elif obj in db.deleted or db.is_modified(obj):
                session = db.get(WatchSession, obj.session_id)
                if session:
                    pending["rebuild"].add(session.family_id)
        elif isinstance(obj, WatchSession) and obj not in db.new and (obj in db.deleted or any(
            inspect(obj).attrs[key].history.has_changes() for key in ("family_id", "item_id", "started_at", "purpose", "device_id")
        )):
            if db.scalar(select(WatchInterval.id).where(WatchInterval.session_id == obj.id).limit(1)):
                pending["rebuild"].update({obj.family_id, *inspect(obj).attrs.family_id.history.deleted})
        elif (isinstance(obj, Item) and obj in db.dirty and inspect(obj).attrs.type.history.has_changes()
              and "LiveChannel" in {obj.type, *inspect(obj).attrs.type.history.deleted}):
            pending["rebuild"].add(obj.family_id)


@event.listens_for(Session, "after_flush_postexec")
def apply_changes(db, _context):
    pending = db.info.pop("watch_rollup_pending", None)
    if not pending:
        return
    for family in sorted(obj.id for obj in pending["families"]):
        family_state(db, family, new=True)
    for family in sorted(pending["zones"] | pending["rebuild"]):
        queue_rebuild(db, family)
    keys = [obj.id for obj in pending["intervals"]]
    grouped = defaultdict(list)
    if keys:
        for row in db.execute(source_rows(db).where(WatchInterval.id.in_(keys))).mappings():
            grouped[row["family_id"]].append(row)
    for family, records in sorted(grouped.items()):
        state = family_state(db, family)
        if state["active_generation"]:
            project_batch(db, state["active_generation"], state["active_zone"], records)
        if state["building_generation"]:
            project_batch(db, state["building_generation"], state["building_zone"], records)


@event.listens_for(Session, "after_rollback")
def rollback_changes(db):
    db.info.pop("watch_rollup_pending", None)


def initialize(db):
    """Queue legacy households without scanning their interval bodies."""
    families = db.scalars(select(Family.id).outerjoin(
        WatchRollupState, WatchRollupState.family_id == Family.id,
    ).where(WatchRollupState.family_id.is_(None)).order_by(Family.id)).all()
    for family in families:
        family_state(db, family)
        db.commit()


def backfill_once(batch_size=200, *, family_id=None):
    with get_session_factory()() as db:
        serialize_sqlite_write(db)
        query = select(WatchRollupState.__table__).where(
            WatchRollupState.building_generation.is_not(None),
        )
        if family_id is not None:
            query = query.where(WatchRollupState.family_id == family_id)
        state = db.execute(query.order_by(WatchRollupState.family_id).limit(1).with_for_update()).mappings().first()
        if state is None:
            return False
        records = db.execute(source_rows(db).where(
            WatchSession.family_id == state["family_id"], WatchInterval.id > state["cursor"],
        ).order_by(WatchInterval.id).limit(batch_size)).mappings().all()
        generation = state["building_generation"]
        project_batch(db, generation, state["building_zone"], records)
        changes = {"cursor": records[-1]["interval_id"]} if records else {}
        if len(records) < batch_size:
            expected = db.scalar(select(func.count()).select_from(WatchInterval).join(WatchSession).where(
                WatchSession.family_id == state["family_id"],
            ))
            actual = db.scalar(select(func.count()).select_from(WatchContribution).where(WatchContribution.generation == generation))
            if actual != expected:
                raise RuntimeError("Watch backfill contribution count does not match source history")
            from .api.watch_filters import family_watch_clause
            source_total, source_plays = db.execute(select(
                func.coalesce(func.sum(WatchInterval.end_ms - WatchInterval.start_ms), 0),
                func.count(func.distinct(WatchSession.id)),
            ).select_from(WatchInterval).join(WatchSession).where(
                WatchSession.family_id == state["family_id"], family_watch_clause(),
                WatchInterval.played_ms > 0, WatchInterval.end_ms > WatchInterval.start_ms,
            )).one()
            total, plays = db.execute(select(
                func.coalesce(func.sum(WatchItemTotal.played_ms), 0),
                func.coalesce(func.sum(WatchItemTotal.play_count), 0),
            ).where(WatchItemTotal.generation == generation)).one()
            if (total, plays) != (source_total, source_plays):
                raise RuntimeError("Watch backfill totals do not match source history")
            changes.update(active_generation=generation, active_zone=state["building_zone"],
                           building_generation=None, building_zone=None, cursor=0)
        db.execute(WatchRollupState.__table__.update().where(WatchRollupState.family_id == state["family_id"]).values(**changes))
        db.commit()
        return True


def start_worker():
    stop = threading.Event()
    def run():
        last_family = ""
        while not stop.is_set():
            try:
                # Round-robin families: a large or corrupt history must not
                # prevent other households from preparing their summaries.
                with get_session_factory()() as db:
                    family = db.scalar(select(WatchRollupState.family_id).where(
                        WatchRollupState.building_generation.is_not(None),
                    ).order_by(case((WatchRollupState.family_id > last_family, 0), else_=1),
                               WatchRollupState.family_id).limit(1))
                if family is not None:
                    last_family = family
                more = family is not None and backfill_once(family_id=family)
            except Exception:
                log.exception("Watch projection backfill failed; retained prior generation")
                more = False
            stop.wait(.05 if more else 2)
    thread = threading.Thread(target=run, name="watch-rollups", daemon=True)
    thread.start()
    return stop, thread


def read_summary(db, family, now):
    state = db.execute(select(WatchRollupState.__table__).where(WatchRollupState.family_id == family)).mappings().first()
    if not state or not state["active_generation"]:
        raise HTTPException(503, "观看统计正在准备，请稍后重试", headers={"Retry-After": "2"})
    generation, zone = state["active_generation"], ZoneInfo(state["active_zone"])
    today = now.astimezone(zone).date()
    first = today - dt.timedelta(days=364)
    week = today - dt.timedelta(days=today.weekday())
    days = {(first + dt.timedelta(days=i)).isoformat(): 0 for i in range(365)}
    for day, amount in db.execute(select(WatchDayTotal.day, WatchDayTotal.played_ms).where(
        WatchDayTotal.generation == generation, WatchDayTotal.day >= first.isoformat(), WatchDayTotal.day <= today.isoformat(),
    )):
        days[day] = amount
    duration_adjustments = defaultdict(int)
    # Only still-future tails are read, using the (generation, end_at) index.
    for row in db.execute(select(WatchContribution.__table__).where(
        WatchContribution.generation == generation, WatchContribution.end_at > naive(now),
    )).mappings():
        start, end = utc(row["start_at"]), utc(row["end_at"])
        clipped = min(end, max(start, now))
        duration_adjustments[row["item_id"]] += milliseconds(start, end) - milliseconds(start, clipped)
        full, partial = day_parts(start, end, zone), day_parts(start, clipped, zone)
        for day, amount in full.items():
            if day in days:
                days[day] -= amount - partial.get(day, 0)
    play_adjustments = dict(db.execute(select(WatchSessionTotal.item_id, func.count()).where(
        WatchSessionTotal.generation == generation, WatchSessionTotal.first_at >= naive(now),
    ).group_by(WatchSessionTotal.item_id)).all())
    contents = {}
    for column, count in [(WatchItemTotal.played_ms, 1 + len(duration_adjustments)),
                          (WatchItemTotal.play_count, 7 + len(play_adjustments))]:
        for row in db.execute(select(WatchItemTotal.__table__).where(WatchItemTotal.generation == generation)
                              .order_by(column.desc(), WatchItemTotal.item_id).limit(count)).mappings():
            contents[row["item_id"]] = {"id": row["item_id"], "name": row["item_name"],
                "playedMs": row["played_ms"] - duration_adjustments[row["item_id"]],
                "playCount": row["play_count"] - play_adjustments.get(row["item_id"], 0)}
    contents = {key: row for key, row in contents.items() if row["playedMs"] > 0 and row["playCount"] > 0}
    favorite = min(contents.values(), key=lambda row: (-row["playedMs"], row["id"])) if contents else None
    ranked = sorted(contents.values(), key=lambda row: (-row["playCount"], row["id"]))[:7]
    start = dt.datetime.combine(today - dt.timedelta(days=6), dt.time.min, zone).astimezone(dt.UTC)
    end = dt.datetime.combine(today + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)
    sessions = db.scalar(select(func.count()).select_from(WatchSessionTotal).where(
        WatchSessionTotal.generation == generation, WatchSessionTotal.started_at >= naive(start), WatchSessionTotal.started_at < naive(end),
    ))
    return {"timezone": str(zone), "summaryUpdating": state["building_generation"] is not None,
            "todayPlayedMs": days[today.isoformat()], "weekPlayedMs": sum(value for day, value in days.items() if day >= week.isoformat()),
            "weekStart": week.isoformat(), "days": [{"date": day, "playedMs": value} for day, value in days.items()],
            "last7DaysSessions": sessions}, favorite, ranked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild-family", help="Rebuild projections for one existing family")
    parser.add_argument("--batch-size", type=int, default=200)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000:
        parser.error("batch-size must be between 1 and 1000")
    from .db import init_db
    init_db()
    if args.rebuild_family:
        with get_session_factory()() as db:
            if db.get(Family, args.rebuild_family) is None:
                parser.error("family does not exist")
            queue_rebuild(db, args.rebuild_family)
            db.commit()
    batches = 0
    while backfill_once(args.batch_size):
        batches += 1
    print(f"Watch projections ready; processed {batches} batches")
