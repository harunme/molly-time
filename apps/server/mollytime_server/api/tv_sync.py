"""Versioned static catalogs, independent watch state, and bounded offline grants."""

import base64
import datetime as dt
import hashlib
import json
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..catalog_versions import version
from ..config import get_settings
from ..db import get_session_factory
from ..deps import CurrentUser, DbSession
from ..manage_auth import aware
from ..management_models import DeviceDownload, DeviceReminder, WatchSession
from ..models import Item, MediaFile
from ..resource_policy import require_visible, visible_item_ids
from .catalog_pagination import episode_dto, episode_query, ordered_playlist, paged_home
from .downloads import device_id
from .manage_home import effective_content
from .watch import Event, report

router = APIRouter(prefix="/api/tv", tags=["tv-sync"])
PAGE = 48


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def signing_key():
    order = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
    seed = hashlib.sha256((get_settings().auth_secret + ":offline-v1").encode()).digest()
    return ec.derive_private_key(int.from_bytes(seed, "big") % (order - 1) + 1, ec.SECP256R1())


def issue_grant(payload):
    data = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    key = signing_key()
    return {
        "token": b64(data) + "." + b64(key.sign(data, ec.ECDSA(hashes.SHA256()))),
        "publicKey": b64(
            key.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        ),
    }


def read_grant(token):
    try:
        data, signature = token.split(".")
        raw = unb64(data)
        signing_key().public_key().verify(unb64(signature), raw, ec.ECDSA(hashes.SHA256()))
        return json.loads(raw)
    except Exception as error:
        raise HTTPException(403, "离线授权无效") from error


def static_images(db, value):
    if isinstance(value, list):
        return [static_images(db, item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: static_images(db, item) for key, item in value.items() if key != "directUrl"}
    image = result.get("image")
    if image and image.get("url"):
        path = image["url"].split("?")[0]
        item_id = path.split("/")[3]
        visited = set()
        item = db.get(Item, item_id)
        while item and item.id not in visited:
            visited.add(item.id)
            file = db.query(MediaFile).filter_by(item_id=item.id, kind="image").first()
            if file:
                tag = hashlib.sha256(f"{file.id}:{file.sha256}:{file.path}".encode()).hexdigest()
                image.update(url=path + "?v=" + tag, version=tag)
                break
            item = db.get(Item, item.parent_id) if item.parent_id else None
    return result


def begin_snapshot(db):
    # Authentication uses a separate dependency session. This transaction keeps
    # returned clocks, permissions, and rows at the same database snapshot.
    connection = db.connection()
    if connection.dialect.name == "sqlite":
        connection.exec_driver_sql("BEGIN")
    else:
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")


def snapshot(db, family, collection, expected):
    begin_snapshot(db)
    if version(db, family, collection) != expected:
        raise HTTPException(409, "catalog_version_changed")


@router.get("/sync-state")
def sync_state(request: Request, user: CurrentUser, db: DbSession):
    device = device_id(request)
    with get_session_factory()() as read:
        begin_snapshot(read)
        return sync_state_data(user, read, device)


def sync_state_data(user, db, device):
    now = int(dt.datetime.now(dt.UTC).timestamp() * 1000)
    reminder = db.get(DeviceReminder, device)
    blocked = reminder is not None and reminder.phase != "idle"
    permissions = []
    if not blocked:
        rows = (
            db.query(DeviceDownload, MediaFile, Item)
            .join(MediaFile, MediaFile.id == DeviceDownload.media_id)
            .join(Item, Item.id == MediaFile.item_id)
            .filter(
                DeviceDownload.device_id == device,
                DeviceDownload.family_id == user.family_id,
                DeviceDownload.desired == "saved",
                MediaFile.kind == "video",
                Item.id.in_(visible_item_ids(user.family_id)),
            )
            .all()
        )
        permissions = [
            {
                "episodeId": item.id,
                "mediaId": file.id,
                "version": file.sha256 or file.id,
                "size": file.size_bytes,
                "sha256": file.sha256,
            }
            for _, file, item in rows
        ]
    grant = issue_grant(
        {
            "schema": 1,
            "id": str(uuid.uuid4()),
            "deviceId": device,
            "familyId": user.family_id,
            "userId": user.id,
            "issuedAt": now,
            "expiresAt": now + 7 * 86400000,
            "permissions": permissions,
        }
    )
    return {
        "schemaVersion": 1,
        "scope": f"{user.family_id}:{device}",
        "serverTime": now,
        "catalogVersion": version(db, user.family_id, "catalog"),
        "homeVersion": version(db, user.family_id, "home"),
        "playbackVersion": version(db, user.family_id, "playback"),
        "policyVersion": version(db, user.family_id, "policy"),
        "offlineBlocked": blocked,
        "offlineGrant": grant,
    }


@router.get("/catalog/manifest")
def manifest(
    request: Request,
    user: CurrentUser,
    db: DbSession,
    version_: str = Query(alias="version", max_length=128),
):
    device_id(request)
    with get_session_factory()() as read:
        snapshot(read, user.family_id, "catalog", version_)
        query, _, folder = episode_query(read, user.family_id)
        counts = dict(query.with_entities(folder, func.count(Item.id)).group_by(folder).all())
        ids = list(counts)
        folders = read.scalars(
            select(Item).where(Item.id.in_(ids), Item.family_id == user.family_id).order_by(Item.id)
        ).all()
        return {
            "version": version_,
            "homeVersion": version(read, user.family_id, "home"),
            "folders": [
                {
                    "id": item.id,
                    "version": version(read, user.family_id, "folder:" + item.id),
                    "total": counts[item.id],
                }
                for item in folders
            ],
        }


@router.get("/catalog/home")
def home(
    request: Request,
    user: CurrentUser,
    db: DbSession,
    version_: str = Query(alias="version", max_length=128),
    page: int = Query(1, ge=1, le=2147483647),
    pageSize: int = Query(PAGE, ge=1, le=48),
    rowId: str | None = Query(None, pattern="^[A-Za-z0-9-]{1,64}$"),
):
    device_id(request)
    with get_session_factory()() as read:
        snapshot(read, user.family_id, "home", version_)
        content, _ = effective_content(read, user.family_id)
        content = {
            "rows": [
                row
                for row in content["rows"]
                if row["source"] not in ("continue", "recently-played")
            ]
        }
        return dict(
            static_images(
                read, paged_home(content, read, user.family_id, None, page, pageSize, rowId)
            ),
            version=version_,
        )


@router.get("/catalog/folders/{folder_id}")
def folder(
    folder_id: str,
    request: Request,
    user: CurrentUser,
    db: DbSession,
    version_: str = Query(alias="version", max_length=128),
    page: int = Query(1, ge=1, le=2147483647),
    pageSize: int = Query(PAGE, ge=1, le=48),
):
    device_id(request)
    with get_session_factory()() as read:
        snapshot(read, user.family_id, "folder:" + folder_id, version_)
        item = read.get(Item, folder_id)
        if not item or item.family_id != user.family_id or item.type != "Series":
            raise HTTPException(404)
        require_visible(read, item, request)
        query, _ = ordered_playlist(read, user.family_id, folder_id)
        total = query.count()
        episodes = query.offset((page - 1) * pageSize).limit(pageSize).all()
        return static_images(
            read,
            {
                "version": version_,
                "episodes": [episode_dto(read, e) for e in episodes],
                "total": total,
                "page": page,
                "pageSize": pageSize,
                "hasMore": page * pageSize < total,
            },
        )


@router.get("/playback-state")
def playback_state(request: Request, user: CurrentUser, db: DbSession):
    device_id(request)
    with get_session_factory()() as read:
        begin_snapshot(read)
        return playback_state_data(user, read)


def playback_state_data(user, db):
    from .manage_home import render_home

    rows = render_home(
        {
            "rows": [
                {
                    "id": "recently-played",
                    "title": "最近播放",
                    "source": "recently-played",
                    "enabled": True,
                    "limit": 10,
                }
            ]
        },
        db,
        user.family_id,
    )
    from .watch_progress import scoped_progress

    progress = scoped_progress(db, user.family_id, None).all()
    return {
        "version": version(db, user.family_id, "playback"),
        "recent": static_images(db, rows),
        "progress": [
            {
                "episodeId": p.item_id,
                "positionMs": p.position_ms,
                "completed": p.completed,
                "sessionId": p.session_id,
                "seq": p.seq,
                "startedAt": int(aware(p.session_started_at).timestamp() * 1000),
            }
            for p in progress
        ],
    }


class OfflineSession(BaseModel):
    id: uuid.UUID
    episodeId: str = Field(pattern="^[A-Za-z0-9-]{1,64}$")
    mediaId: str = Field(pattern="^[A-Za-z0-9-]{1,64}$")
    version: str = Field(max_length=128)
    startedAt: int = Field(ge=0)
    grant: str = Field(max_length=2000000)
    events: list[Event] = Field(min_length=1, max_length=100)


class OfflineBatch(BaseModel):
    sessions: list[OfflineSession] = Field(min_length=1, max_length=20)


@router.post("/offline-events")
def offline_events(body: OfflineBatch, request: Request, user: CurrentUser, db: DbSession):
    device = device_id(request)
    acknowledged = []
    for entry in body.sessions:
        grant = read_grant(entry.grant)
        if (
            grant.get("deviceId") != device
            or grant.get("familyId") != user.family_id
            or grant.get("userId") != user.id
            or not grant.get("issuedAt", 0) <= entry.startedAt <= grant.get("expiresAt", 0)
        ):
            raise HTTPException(403, "离线记录授权不匹配")
        allowed = any(
            p["episodeId"] == entry.episodeId
            and p["mediaId"] == entry.mediaId
            and p["version"] == entry.version
            for p in grant.get("permissions", [])
        )
        if not allowed or any(entry.startedAt + e.endMs > grant["expiresAt"] for e in entry.events):
            raise HTTPException(403, "离线记录超出授权")
        sid = str(entry.id)
        row = db.get(WatchSession, sid)
        if row is None:
            item = db.get(Item, entry.episodeId)
            if not item or item.family_id != user.family_id:
                raise HTTPException(404)
            row = WatchSession(
                id=sid,
                family_id=user.family_id,
                user_id=user.id,
                device_id=device,
                item_id=item.id,
                item_name=item.name,
                purpose="family_watch",
                started_at=dt.datetime.fromtimestamp(entry.startedAt / 1000, dt.UTC),
            )
            db.add(row)
            db.commit()
        elif (
            row.device_id != device
            or row.item_id != entry.episodeId
            or int(aware(row.started_at).timestamp() * 1000) != entry.startedAt
        ):
            raise HTTPException(409, "离线会话冲突")
        for e in entry.events:
            report(sid, e, request, user, db)
            acknowledged.append({"id": sid, "seq": e.seq})
    return {"acknowledged": acknowledged}
