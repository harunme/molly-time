"""Installation telemetry and superadmin-only usage overview."""

import datetime as dt
import hashlib
import hmac
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, case, func

from ..analytics import ZONE, bounds, metadata, record_device_day, watching
from ..analytics_models import DeviceDay, Installation, InstallationDay
from ..deps import DbSession, get_current_user
from ..device_presence import ONLINE_WINDOW, device_online
from ..manage_auth import aware
from ..management_models import Device
from ..models import Family
from ..transactions import serialize_sqlite_write
from .operations import Operator
from .pairing import limit

router = APIRouter(tags=["operations-analytics"])
PREFIX = "/api/manage/operations/analytics"


class Telemetry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    installationId: UUID
    # Client persists a random enrollment secret BEFORE the first request, so a
    # lost registration response can be retried without transferring ownership.
    installationToken: str = Field(pattern=r"^[a-f0-9]{64}$")
    version: str = Field(min_length=1, max_length=32, pattern=r"^[\w.()+-]+$")
    channel: Literal["release", "debug"] = "release"


@router.post("/api/client/telemetry")
def telemetry(body: Telemetry, request: Request, db: DbSession):
    device_id = None
    authorization = request.headers.get("authorization")
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(401, "无效的设备凭证")
        get_current_user(request, db, token)
        device_id = getattr(request.state, "device_id", None)
        if not device_id:
            raise HTTPException(403, "需要设备凭证")
    if body.channel == "debug":
        return {"ok": True, "ignored": True}
    serialize_sqlite_write(db)
    key = str(body.installationId)
    existing = db.get(Installation, key)
    if existing is None:
        limit(db, request, "installation-register", 120, 60)
    else:
        limit(db, request, "installation-heartbeat", 12, 60, principal=key)
    now = dt.datetime.now(dt.UTC)
    digest = hashlib.sha256(body.installationToken.encode()).hexdigest()
    # Upsert before row lock also serializes two initial requests on MySQL.
    values = {
        "id": key,
        "token_hash": digest,
        "version": body.version,
        "first_seen": now,
        "last_seen": now,
    }
    if db.bind.dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert

        statement = insert(Installation).values(**values).on_conflict_do_nothing()
    else:
        from sqlalchemy.dialects.mysql import insert

        statement = insert(Installation).values(**values).on_duplicate_key_update(id=key)
    db.execute(statement)
    row = db.query(Installation).filter_by(id=key).with_for_update().one()
    if not hmac.compare_digest(row.token_hash, digest):
        raise HTTPException(403, "安装凭证不匹配")
    row.version, row.last_seen, row.device_id = body.version, now, device_id
    day_values = {"installation_id": key, "day": now.astimezone(ZONE).date()}
    if db.bind.dialect.name == "sqlite":
        statement = insert(InstallationDay).values(**day_values).on_conflict_do_nothing()
    else:
        statement = (
            insert(InstallationDay)
            .values(**day_values)
            .on_duplicate_key_update(installation_id=key)
        )
    db.execute(statement)
    if device_id:
        device = db.get(Device, device_id)
        device.last_seen = now
        record_device_day(db, device_id, now)
    db.commit()
    return {"ok": True, "installationToken": body.installationToken}


def online_clause(now):
    return (
        Device.revoked.is_(False),
        Device.last_seen >= now - ONLINE_WINDOW,
        Device.last_seen <= now,
    )


@router.get(PREFIX + "/overview")
def overview(user: Operator, db: DbSession):
    now = dt.datetime.now(dt.UTC)
    buckets, _ = watching(db, 7, now)
    today = buckets[now.astimezone(ZONE).date().isoformat()]
    return {
        **metadata(db, now),
        "installationCount": db.query(Installation).count(),
        "familyCount": db.query(Family).count(),
        "boundDevices": db.query(Device).filter(Device.revoked.is_(False)).count(),
        "onlineDevices": db.query(Device).filter(*online_clause(now)).count(),
        "todayWatchingFamilies": len(today["families"]),
        "weekWatchingFamilies": len(set().union(*(b["families"] for b in buckets.values()))),
        "todayVodMs": today["vodMs"],
        "todayLiveMs": today["liveMs"],
    }


@router.get(PREFIX + "/daily")
def daily(user: Operator, db: DbSession, days: int = Query(default=30, ge=7, le=90)):
    now = dt.datetime.now(dt.UTC)
    if days not in (7, 30, 90):
        raise HTTPException(422, "统计范围应为 7、30 或 90 天")
    first, lower = bounds(days, now)
    buckets, _ = watching(db, days, now)
    meta = metadata(db, now)
    since = (
        dt.datetime.fromisoformat(meta["collectionStartedAt"]).astimezone(ZONE).date()
        if meta["collectionStartedAt"]
        else now.astimezone(ZONE).date()
    )
    visits = dict(
        db.query(DeviceDay.day, func.count(DeviceDay.device_id))
        .filter(DeviceDay.day >= first)
        .group_by(DeviceDay.day)
        .all()
    )
    activations = {}
    for (seen,) in (
        db.query(Installation.first_seen)
        .filter(Installation.first_seen >= lower, Installation.first_seen <= now)
        .yield_per(512)
    ):
        day = aware(seen).astimezone(ZONE).date()
        activations[day] = activations.get(day, 0) + 1
    return {
        **meta,
        "days": days,
        "items": [
            {
                "date": day,
                "newInstallations": activations.get(dt.date.fromisoformat(day), 0)
                if dt.date.fromisoformat(day) >= since
                else None,
                "visitingDevices": visits.get(dt.date.fromisoformat(day), 0)
                if dt.date.fromisoformat(day) >= since
                else None,
                "watchingFamilies": len(b["families"]),
                "watchingDevices": len(b["devices"]),
                "vodMs": b["vodMs"],
                "liveMs": b["liveMs"],
            }
            for day, b in buckets.items()
        ],
    }


@router.get(PREFIX + "/families")
def families(
    user: Operator,
    db: DbSession,
    q: str = Query(default="", max_length=128),
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
):
    now = dt.datetime.now(dt.UTC)
    devices = (
        db.query(
            Device.family_id.label("family"),
            func.max(Device.last_seen).label("seen"),
            func.sum(case((Device.revoked.is_(False), 1), else_=0)).label("bound"),
            func.sum(case((and_(*online_clause(now)), 1), else_=0)).label("online"),
        )
        .group_by(Device.family_id)
        .subquery()
    )
    query = db.query(Family, devices.c.seen, devices.c.bound, devices.c.online).outerjoin(
        devices, devices.c.family == Family.id
    )
    if q.strip():
        pattern = (
            "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )
        query = query.filter(Family.name.ilike(pattern, escape="\\"))
    total = query.count()
    rows = (
        query.order_by(devices.c.seen.desc(), Family.id)
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .all()
    )
    _, durations = watching(db, 7, now, [f.id for f, *_ in rows]) if rows else ({}, {})
    return {
        **metadata(db, now),
        "total": total,
        "page": page,
        "pageSize": pageSize,
        "items": [
            {
                "id": f.id,
                "name": f.name,
                "lastSeen": aware(seen).isoformat() if seen else None,
                "boundDevices": bound or 0,
                "onlineDevices": online or 0,
                "weekPlayedMs": durations.get(f.id, 0),
            }
            for f, seen, bound, online in rows
        ],
    }


@router.get(PREFIX + "/devices")
def devices(
    user: Operator,
    db: DbSession,
    familyId: str = Query(max_length=36),
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
):
    now = dt.datetime.now(dt.UTC)
    query = db.query(Device).filter(Device.family_id == familyId)
    total = query.count()
    rows = (
        query.order_by(Device.last_seen.desc(), Device.id)
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .all()
    )
    versions = {}
    for installation in (
        db.query(Installation)
        .filter(Installation.device_id.in_([r.id for r in rows]))
        .order_by(Installation.last_seen, Installation.id)
    ):
        versions[installation.device_id] = installation.version
    return {
        **metadata(db, now),
        "total": total,
        "page": page,
        "pageSize": pageSize,
        "items": [
            {
                "id": r.id,
                "name": r.name,
                "revoked": r.revoked,
                "online": device_online(r, now),
                "lastSeen": aware(r.last_seen).isoformat(),
                "version": versions.get(r.id),
            }
            for r in rows
        ],
    }


@router.get(PREFIX + "/versions")
def versions(user: Operator, db: DbSession):
    now = dt.datetime.now(dt.UTC)
    _, lower = bounds(30, now)
    rows = (
        db.query(Installation.version, func.count(Installation.id))
        .filter(
            Installation.last_seen >= lower,
            Installation.last_seen <= now,
        )
        .group_by(Installation.version)
        .order_by(func.count(Installation.id).desc(), Installation.version)
        .all()
    )
    return {
        **metadata(db, now),
        "items": [{"version": version, "count": count} for version, count in rows],
    }
