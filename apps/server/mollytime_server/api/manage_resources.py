"""Family resource CRUD and bounded, resumable local uploads."""

import datetime as dt
import hashlib
import logging
import os
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from sqlalchemy import case, func
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..deps import DbSession
from ..images import image_url
from ..manage_auth import Parent, aware
from ..management_models import (
    FamilyReminders,
    MediaOptions,
    MediaTask,
    ResourcePosition,
    ResourceState,
    UploadSession,
    UploadTarget,
)
from ..models import Family, Item, MediaFile
from ..remote_uploads import (
    PART_SIZE,
    check_target,
    cleanup_upload_files,
    ensure_capacity,
    transport,
    upload_lock,
    verified_parts,
)
from ..resource_tree import ancestors, descendant_ids
from ..share_models import SharedOrigin
from ..storage import build_storage
from ..storage.settings import get_storage_settings
from ..transactions import external_io, serialize_sqlite_write
from ..trash import archive, ensure_active
from ..upload_metadata import VideoMetadata, save_metadata
from .pagination import paginate

router = APIRouter(prefix="/api/manage", tags=["manage-resources"])


def owned(db, model, key, family):
    row = db.get(model, key)
    if row is None or row.family_id != family or (model is Item and row.type == "Deleted"):
        raise HTTPException(404, "内容不存在")
    return row


def state_for(db, item):
    row = db.get(ResourceState, item.id)
    if row is None:
        # Existing scan data was already visible. Preserve that behavior explicitly.
        row = ResourceState(item_id=item.id, status="published", ready=True)
        db.add(row)
        db.flush()
    return row


def prime_resources(db, items, summary=False):
    keys = [item.id for item in items]
    states = {row.item_id: row for row in db.query(ResourceState).filter(ResourceState.item_id.in_(keys)).all()}
    db.info["manage_states"] = {key: states.get(key) for key in keys}
    if summary:
        return
    files = db.query(MediaFile).filter(MediaFile.item_id.in_(keys), MediaFile.kind.in_(["video", "subtitle", "image"])).all()
    grouped = {key: [] for key in keys}
    for file in files:
        grouped[file.item_id].append(file)
    db.info["manage_files"] = grouped
    options = {row.media_id: row for row in db.query(MediaOptions).filter(MediaOptions.media_id.in_([file.id for file in files])).all()}
    db.info["manage_options"] = {file.id: options.get(file.id) for file in files}


def resource_state(db, item):
    cached = db.info.get("manage_states", {})
    return cached[item.id] if item.id in cached else db.get(ResourceState, item.id)


def dto(db, item, include_files=True):
    state = resource_state(db, item)
    media = db.info.get("manage_files", {}).get(item.id) if include_files else []
    if media is None:
        media = (
        db.query(MediaFile)
        .filter(MediaFile.item_id == item.id, MediaFile.kind.in_(["video", "subtitle", "image"]))
        .all()
        )
    options = db.info.get("manage_options", {})
    options = {file.id: options[file.id] if file.id in options else db.get(MediaOptions, file.id) for file in media}
    cover = image_url(db, item)
    return {
        "id": item.id,
        "name": item.name,
        "type": item.type,
        "parentId": item.parent_id,
        "overview": item.overview if include_files else "",
        "indexNumber": item.index_number,
        "status": state.status if state else "published",
        "legacy": state is None,
        "shared": db.get(SharedOrigin, item.id) is not None,
        "ready": state.ready if state else True,
        "runtimeMs": (item.runtime_ticks or 0) // 10000,
        "imageUrl": cover + ("&" if "?" in cover else "?") + "w=320",
        "files": [
            {
                "id": f.id,
                "name": (
                    options[f.id].label
                    if options[f.id] and options[f.id].label
                    else Path(f.path).name
                ),
                "kind": f.kind,
                "size": f.size_bytes,
                "language": f.language,
                "storage": f.storage,
                "version": f.sha256 or f.id,
                "isDefault": f.is_default,
                "offsetMs": (
                    options[f.id].offset_ms if options[f.id] else 0
                ),
            }
            for f in media
        ],
    }


def resource_filters(query, q, status):
    if q:
        query = query.filter(Item.name.icontains(q.strip(), autoescape=True))
    query = query.outerjoin(ResourceState, ResourceState.item_id == Item.id)
    effective_status = func.coalesce(ResourceState.status, "published")
    if status:
        query = query.filter(effective_status == status)
    else:
        # Hide archives before pagination/counting; explicit archive searches remain available.
        query = query.filter(effective_status.notin_(["archived", "deleted"]))
    return query


def resource_summary(db, item):
    state = resource_state(db, item)
    return {"id": item.id, "name": item.name, "type": item.type,
            "status": state.status if state else "published"}


def resource_order(query, sort):
    # Keep ordering in SQL so pagination and filtering use the same full result set.
    names = (Item.sort_name, Item.name, Item.id)
    numbered = (case((Item.index_number.is_(None), 1), else_=0),)
    if sort == "manual":
        return query.outerjoin(ResourcePosition, ResourcePosition.item_id == Item.id).order_by(
            case((ResourcePosition.position.is_(None), 1), else_=0), ResourcePosition.position,
            case((Item.type == "Season", 0), else_=1), *numbered, Item.index_number, *names,
        )
    orders = {
        "index": (*numbered, Item.index_number, *names),
        "index-desc": (*numbered, Item.index_number.desc(), *names),
        "name": names,
        "name-desc": (Item.sort_name.desc(), Item.name.desc(), Item.id),
        "published": (case((ResourceState.published_at.is_(None), 1), else_=0), ResourceState.published_at.desc(), *names),
        "duration": (func.coalesce(Item.runtime_ticks, 0).desc(), *names),
    }
    return query.order_by(case((Item.type == "Season", 0), else_=1), *orders[sort])


def reminder_resource_ids(db, family_id):
    reminders = db.get(FamilyReminders, family_id)
    if reminders is None:
        return set()
    return {key for key in (reminders.folder_id, reminders.warning_id, reminders.farewell_id) if key}


@router.get("/resources")
def resources(
    user: Parent, db: DbSession, parentId: str | None = None,
    page: int | None = Query(default=None, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
    q: str = Query(default="", max_length=256),
    status: str = Query(default="", pattern="^(|draft|published|archived)$"),
    summary: bool = False, ids: str = Query(default="", max_length=4000),
    resourceType: str = Query(default="", pattern="^(|Season|Episode)$"),
    sort: str = Query(default="index", pattern="^(manual|index|index-desc|name|name-desc|published|duration)$"),
):
    query = db.query(Item).filter(Item.family_id == user.family_id)
    private_ids = reminder_resource_ids(db, user.family_id)
    if parentId and parentId in private_ids:
        raise HTTPException(404, "内容不存在")
    if parentId:
        ensure_active(db, owned(db, Item, parentId, user.family_id))
        query = query.filter(Item.parent_id == parentId)
    else:
        query = query.filter(Item.parent_id.is_(None), Item.type.in_(["Series", "Season"]))
    if private_ids:
        query = query.filter(Item.id.notin_(private_ids))
    if ids:
        keys = list(dict.fromkeys(ids.split(",")))
        if len(keys) > 100:
            raise HTTPException(422, "单次最多查询 100 个资源")
        query = query.filter(Item.id.in_(keys))
    if resourceType:
        query = query.filter(Item.type == resourceType)
    query = resource_filters(query, q, status)
    return paginate(resource_order(query, sort),
                    page, pageSize, lambda item: resource_summary(db, item) if summary else dto(db, item, page is None),
                    lambda rows: prime_resources(db, rows, summary or page is not None))


@router.get("/resources/stats")
def resource_stats(user: Parent, db: DbSession, folderId: str | None = None):
    query = (
        db.query(Item.id, Item.type, func.coalesce(ResourceState.status, "published"), func.coalesce(ResourceState.ready, True), Item.runtime_ticks)
        .outerjoin(ResourceState, ResourceState.item_id == Item.id)
        .filter(
            Item.family_id == user.family_id,
            func.coalesce(ResourceState.status, "published").notin_(["archived", "deleted"]),
        )
    )
    private_ids = reminder_resource_ids(db, user.family_id)
    if folderId is not None:
        folder = owned(db, Item, folderId, user.family_id)
        if folder.id in private_ids:
            raise HTTPException(404, "内容不存在")
        ensure_active(db, folder)
        if folder.type not in ("Series", "Season"):
            raise HTTPException(422, "请选择文件夹")
        query = query.filter(Item.id.in_(descendant_ids(user.family_id, folder.id)))
    if private_ids:
        query = query.filter(Item.id.notin_(private_ids))
    active = query.all()
    active_ids = [item_id for item_id, *_ in active]
    subtitle_count = 0
    if active_ids:
        subtitle_count = db.query(func.count(MediaFile.id)).filter(
            MediaFile.item_id.in_(active_ids), MediaFile.kind == "subtitle",
        ).scalar() or 0
    episode_ids = {item_id for item_id, item_type, *_ in active if item_type == "Episode"}
    subtitle_video_count = 0
    if episode_ids:
        subtitle_video_count = db.query(func.count(func.distinct(MediaFile.item_id))).filter(
            MediaFile.item_id.in_(episode_ids), MediaFile.kind == "subtitle",
        ).scalar() or 0
    return {
        "videoCount": sum(item_type == "Episode" for _, item_type, *_ in active),
        "folderCount": sum(item_type == "Series" for _, item_type, *_ in active),
        "subtitleCount": subtitle_count,
        "publishedVideoCount": sum(item_type == "Episode" and status == "published" for _, item_type, status, _, _ in active),
        "readyVideoCount": sum(item_type == "Episode" and ready for _, item_type, _, ready, _ in active),
        "subtitleVideoCount": subtitle_video_count,
        "durationMs": sum((runtime_ticks or 0) // 10000 for _, item_type, _, _, runtime_ticks in active if item_type == "Episode"),
    }


@router.get("/folders/{folder_id}/videos")
def folder_videos(
    folder_id: str, user: Parent, db: DbSession,
    page: int | None = Query(default=None, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
    q: str = Query(default="", max_length=256),
    status: str = Query(default="", pattern="^(|draft|published|archived)$"),
):
    folder = owned(db, Item, folder_id, user.family_id)
    if folder_id in reminder_resource_ids(db, user.family_id):
        raise HTTPException(404, "内容不存在")
    ensure_active(db, folder)
    if folder.type != "Series":
        raise HTTPException(422, "请选择文件夹")
    query = db.query(Item).filter(
        Item.family_id == user.family_id, Item.type == "Episode",
        Item.id.in_(descendant_ids(user.family_id, folder.id)),
    )
    query = resource_filters(query, q, status)
    return paginate(query.order_by(Item.index_number, Item.name, Item.id),
                    page, pageSize, lambda item: dto(db, item, page is None),
                    lambda rows: prime_resources(db, rows, page is not None))


class ResourceBody(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    type: str = Field(default="Series", pattern="^(Series|Season|Episode)$")
    parentId: str | None = None
    overview: str = Field(default="", max_length=10000)
    indexNumber: int | None = Field(default=None, ge=1, le=100000)
    autoName: bool = False


@router.post("/resources")
def create(body: ResourceBody, user: Parent, db: DbSession):
    lock_resource_family(db, user.family_id)
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "名称不能为空")
    parent = owned(db, Item, body.parentId, user.family_id) if body.parentId else None
    if parent:
        ensure_active(db, parent)
    expected = {"Season": ("Series",), "Episode": ("Series", "Season")}.get(body.type)
    if (expected and (parent is None or parent.type not in expected)) or (
        parent and parent.type not in ("Series", "Season")
    ):
        raise HTTPException(422, "请先选择正确的文件夹")
    if parent and len(ancestors(db, parent)) + 2 > 32:
        raise HTTPException(422, "文件夹最多支持 32 层，请选择更上层的文件夹")
    if body.autoName:
        if body.type != "Series":
            raise HTTPException(422, "自动命名仅适用于普通文件夹")
        names = {row[0] for row in db.query(Item.name).filter(
            Item.family_id == user.family_id, Item.parent_id == body.parentId,
            Item.type == "Series",
        ).all()}
        name, suffix = "新建文件夹", 2
        while name in names:
            name = f"新建文件夹 ({suffix})"
            suffix += 1
    duplicates = (
        db.query(Item)
        .filter(
            Item.family_id == user.family_id,
            Item.parent_id == body.parentId,
            Item.type == body.type,
            Item.name == name,
        )
        .first()
    )
    if duplicates:
        raise HTTPException(409, "同一目录已有这个名称")
    item = Item(
        family_id=user.family_id,
        type=body.type,
        name=name,
        sort_name=name,
        parent_id=body.parentId,
        overview=body.overview,
        index_number=body.indexNumber,
    )
    db.add(item)
    db.flush()
    # Containers become visible once they contain published, ready episodes.
    db.add(
        ResourceState(
            item_id=item.id,
            status="draft" if body.type == "Episode" else "published",
            ready=body.type != "Episode",
        )
    )
    db.commit()
    return dto(db, item)


@router.get("/resources/{item_id}")
def detail(item_id: str, user: Parent, db: DbSession):
    item = owned(db, Item, item_id, user.family_id)
    return {**dto(db, item), "ancestors": [
        {"id": row.id, "name": row.name, "type": row.type} for row in ancestors(db, item)
    ]}


class MoveBody(BaseModel):
    folderId: str | None


class PositionBody(BaseModel):
    beforeId: str | None = Field(default=None, min_length=1, max_length=64)
    afterId: str | None = Field(default=None, min_length=1, max_length=64)


def lock_resource_family(db, family_id):
    serialize_sqlite_write(db)
    if db.bind.dialect.name != "sqlite":
        # Discard authentication's read snapshot before waiting for the family
        # lock, so a second reorder sees the first one's committed positions.
        db.rollback()
    db.query(Family).filter(Family.id == family_id).with_for_update().one()


@router.put("/resources/{item_id}/position")
def position_resource(item_id: str, body: PositionBody, user: Parent, db: DbSession):
    # Serialize sibling reorders, including root collections, on both databases.
    lock_resource_family(db, user.family_id)
    item = owned(db, Item, item_id, user.family_id)
    ensure_active(db, item)
    private_ids = reminder_resource_ids(db, user.family_id)
    if item.id in private_ids or item.type not in ("Series", "Season", "Episode"):
        raise HTTPException(404, "内容不存在")
    query = db.query(Item).filter(
        Item.family_id == user.family_id, Item.parent_id == item.parent_id,
        Item.type.in_(["Series", "Season", "Episode"]),
    )
    if private_ids:
        query = query.filter(Item.id.notin_(private_ids))
    siblings = resource_order(resource_filters(query, "", ""), "manual").all()
    keys = [row.id for row in siblings if row.id != item.id]
    if body.beforeId and body.afterId:
        raise HTTPException(422, "请选择一个排列位置")
    if body.beforeId == item.id or body.afterId == item.id:
        return {"ok": True}
    anchor = body.beforeId or body.afterId
    if anchor is not None and anchor not in keys:
        raise HTTPException(422, "只能在同一目录中排列资源，请刷新后重试")
    index = keys.index(body.beforeId) if body.beforeId else keys.index(body.afterId) + 1 if body.afterId else len(keys)
    keys.insert(index, item.id)
    positions = {row.item_id: row for row in db.query(ResourcePosition).filter(ResourcePosition.item_id.in_(keys)).all()}
    for index, key in enumerate(keys):
        row = positions.get(key)
        if row is None:
            db.add(ResourcePosition(item_id=key, position=index))
        else:
            row.position = index
    db.commit()
    return {"ok": True}


@router.post("/resources/{item_id}/move")
def move_video(item_id: str, body: MoveBody, user: Parent, db: DbSession):
    lock_resource_family(db, user.family_id)
    item = owned(db, Item, item_id, user.family_id)
    folder = owned(db, Item, body.folderId, user.family_id) if body.folderId else None
    ensure_active(db, item)
    private_ids = reminder_resource_ids(db, user.family_id)
    if item.id in private_ids or (folder and folder.id in private_ids):
        raise HTTPException(404, "内容不存在")
    if item.type not in ("Series", "Season", "Episode"):
        raise HTTPException(422, "请选择视频或文件夹")
    if folder:
        ensure_active(db, folder)
        if folder.type not in ("Series", "Season"):
            raise HTTPException(422, "只能移入文件夹")
        parents = ancestors(db, folder)
        if any(row.id in private_ids for row in parents):
            raise HTTPException(404, "内容不存在")
        if item.id == folder.id or any(row.id == item.id for row in parents):
            raise HTTPException(422, "不能把文件夹移入自己或其子文件夹")
        # Bound both the destination chain and the source subtree, without
        # changing animation/season/episode identities or their numbering.
        source = db.query(Item.id, Item.parent_id).filter(
            Item.family_id == user.family_id, Item.id.in_(descendant_ids(user.family_id, item.id)),
        ).all()
        children = {}
        for key, parent_id in source:
            children.setdefault(parent_id, []).append(key)
        pending = [(item.id, 1)]
        while pending:
            key, depth = pending.pop()
            if len(parents) + 1 + depth > 32:
                raise HTTPException(422, "文件夹最多支持 32 层，请选择更上层的文件夹")
            pending.extend((child, depth + 1) for child in children.get(key, []))
    elif item.type != "Series":
        raise HTTPException(422, "季和视频需要放在动画片文件夹中")
    target_id = folder.id if folder else None
    duplicate = (
        db.query(Item)
        .filter(
            Item.family_id == user.family_id,
            Item.parent_id == target_id,
            Item.type == item.type,
            Item.name == item.name,
            Item.id != item.id,
        )
        .first()
    )
    if duplicate:
        raise HTTPException(409, "文件夹已有同名内容")
    if item.parent_id != target_id:
        position = db.get(ResourcePosition, item.id)
        if position:
            db.delete(position)
    item.parent_id = target_id
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "文件夹已有同名内容") from exc
    return dto(db, item)


class EditBody(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    overview: str | None = Field(default=None, max_length=10000)
    indexNumber: int | None = Field(default=None, ge=1, le=100000)


@router.patch("/resources/{item_id}")
def edit(item_id: str, body: EditBody, user: Parent, db: DbSession):
    lock_resource_family(db, user.family_id)
    item = owned(db, Item, item_id, user.family_id)
    ensure_active(db, item)
    if not body.name.strip():
        raise HTTPException(422, "名称不能为空")
    if db.query(Item.id).filter(
        Item.family_id == user.family_id, Item.parent_id == item.parent_id,
        Item.type == item.type, Item.name == body.name.strip(), Item.id != item.id,
    ).first():
        raise HTTPException(409, "同一目录已有这个名称")
    item.name = item.sort_name = body.name.strip()
    if "overview" in body.model_fields_set:
        item.overview = body.overview or ""
    if "indexNumber" in body.model_fields_set:
        item.index_number = body.indexNumber
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "名称与其他资源冲突") from exc
    return dto(db, item)


@router.post("/resources/{item_id}/{action}")
def transition(item_id: str, action: str, user: Parent, db: DbSession):
    if action not in ("publish", "unpublish", "archive"):
        raise HTTPException(404)
    serialize_sqlite_write(db)
    item = owned(db, Item, item_id, user.family_id)
    if action == "archive":
        archive(db, item)
        db.commit()
        return dto(db, item)
    ensure_active(db, item)
    state = state_for(db, item)
    if action == "publish":
        if not state.ready or (
            item.type == "Episode"
            and not db.query(MediaFile)
            .filter(MediaFile.item_id == item.id, MediaFile.kind == "video")
            .first()
        ):
            raise HTTPException(409, "文件检查完成后才能发布")
        state.status = "published"
        state.published_at = state.published_at or dt.datetime.now(dt.UTC)
        ancestor = db.get(Item, item.parent_id) if item.parent_id else None
        while ancestor and ancestor.family_id == user.family_id:
            parent_state = state_for(db, ancestor)
            parent_state.published_at = parent_state.published_at or state.published_at
            ancestor = db.get(Item, ancestor.parent_id) if ancestor.parent_id else None
    else:
        state.status = "draft"
    db.commit()
    return dto(db, item)


class UploadBody(BaseModel):
    itemId: str
    filename: str = Field(min_length=1, max_length=256)
    size: int = Field(gt=0)
    fingerprint: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern="^(video|subtitle|image)$")
    language: str = Field(default="und", max_length=32)


def upload_dto(db, row):
    tasks = db.info.get("manage_upload_tasks", {})
    targets = db.info.get("manage_upload_targets", {})
    task = tasks[row.id] if row.id in tasks else db.query(MediaTask).filter(MediaTask.upload_id == row.id).first()
    target = targets[row.id] if row.id in targets else transport(db, row)
    return {
        "id": row.id,
        "itemId": row.item_id,
        "filename": row.filename,
        "size": row.size,
        "offset": row.offset,
        "status": row.status,
        "fingerprint": row.fingerprint,
        "kind": row.kind,
        "error": row.error,
        "taskId": task.id if task else None,
        "taskStatus": task.status if task else None,
        "transport": target.backend if target else "local",
        "partSize": PART_SIZE,
        "expiresAt": aware(target.expires_at).isoformat() if target else None,
    }


def upload_limits():
    settings = get_settings()
    return {
        "video": min(settings.max_upload_bytes, settings.media_processing_max_bytes),
        "subtitle": 5 * 1024**2,
        "image": 20 * 1024**2,
    }


@router.get("/uploads/options")
def upload_options(user: Parent):
    return upload_limits()


@router.get("/uploads")
def uploads(
    user: Parent, db: DbSession,
    page: int | None = Query(default=None, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
    pending: bool = False,
):
    query = (
        db.query(UploadSession)
        .filter(UploadSession.family_id == user.family_id)
        .order_by(UploadSession.created_at.desc(), UploadSession.id.desc())
    )
    if pending:
        query = query.filter(
            UploadSession.status.in_(["uploading", "processing", "failed"]),
            UploadSession.kind != "image",
        )
    def preload(rows):
        keys = [row.id for row in rows]
        tasks = {row.upload_id: row for row in db.query(MediaTask).filter(MediaTask.upload_id.in_(keys)).all()}
        targets = {row.upload_id: row for row in db.query(UploadTarget).filter(UploadTarget.upload_id.in_(keys)).all()}
        db.info["manage_upload_tasks"] = {key: tasks.get(key) for key in keys}
        db.info["manage_upload_targets"] = {key: targets.get(key) for key in keys}
    return paginate(query, page, pageSize, lambda row: upload_dto(db, row), preload)


@router.post("/uploads")
def start_upload(body: UploadBody, user: Parent, db: DbSession):
    # All API processes on this host share the lock, including quota reservation.
    # Do not hold the authentication read transaction while waiting for it.
    with external_io(db):
        pass
    with upload_lock(f"family-{user.family_id}"):
        return create_upload(body, user, db)


def create_upload(body, user, db):
    serialize_sqlite_write(db)
    item = owned(db, Item, body.itemId, user.family_id)
    ensure_active(db, item)
    ext = Path(body.filename).suffix.lower()
    extensions = {
        "video": {".mp4"},
        "subtitle": {".srt", ".vtt"},
        "image": {".jpg", ".jpeg", ".png", ".webp"},
    }
    limit = upload_limits()[body.kind]
    if body.size > limit:
        label = {"video": "视频", "subtitle": "字幕", "image": "封面"}[body.kind]
        raise HTTPException(413, f"单个{label}不能超过 {limit / 1024**2:g} MB")
    if (
        ext not in extensions[body.kind]
        or (body.kind != "image" and item.type != "Episode")
    ):
        raise HTTPException(422, "请上传 MP4 视频、SRT/VTT 字幕或图片，并检查文件大小")
    if (
        db.query(UploadSession.id)
        .filter(
            UploadSession.item_id == item.id,
            UploadSession.kind == body.kind,
            UploadSession.status.in_(["uploading", "processing"]),
        )
        .first()
    ):
        raise HTTPException(409, "此资源已有同类文件正在上传或处理")
    ensure_capacity(db, user.family_id, body.size)
    remaining = db.query(func.coalesce(func.sum(UploadSession.size - UploadSession.offset), 0)).filter(
        UploadSession.status == "uploading",
    ).scalar()
    row = UploadSession(
        id=str(uuid.uuid4()),
        family_id=user.family_id,
        item_id=item.id,
        filename=Path(body.filename).name,
        size=body.size,
        fingerprint=body.fingerprint,
        kind=body.kind,
        language=body.language,
        offset=0,
        status="uploading",
        error="",
    )
    with external_io(db):
        directory = get_settings().data_dir / "uploads"
        directory.mkdir(parents=True, exist_ok=True)
        backend = get_storage_settings().storage_backend
        if backend not in ("local", "oss"):
            raise HTTPException(503, "上传存储配置错误")
        if backend == "local" and shutil.disk_usage(directory).free < body.size + remaining + 64 * 1024**2:
            raise HTTPException(507, "磁盘剩余空间不足")
        target = UploadTarget(
            upload_id=row.id, backend=backend,
            expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(hours=get_settings().upload_expiry_hours),
        )
        if backend == "oss":
            target.object_key = f"families/{user.family_id}/media/{row.id}{ext}"
            try:
                target.multipart_id = build_storage("oss").initiate(target.object_key)
            except Exception as exc:
                raise HTTPException(503, "云存储不可用，请联系管理员") from exc
    try:
        # Revalidate after external work; archives may have changed meanwhile.
        ensure_active(db, owned(db, Item, body.itemId, user.family_id))
        db.add(row)
        db.flush()
        db.add(target)
        db.commit()
    except Exception:
        db.rollback()
        if backend == "oss":
            build_storage("oss").abort(target.object_key, target.multipart_id)
        raise
    return upload_dto(db, row)


@router.get("/uploads/{upload_id}")
def upload_detail(upload_id: str, user: Parent, db: DbSession):
    return upload_dto(db, owned(db, UploadSession, upload_id, user.family_id))


@router.put("/uploads/{upload_id}/chunks")
async def upload_chunk(upload_id: str, request: Request, user: Parent, db: DbSession, offset: int):
    row = owned(db, UploadSession, upload_id, user.family_id)
    target = transport(db, row)
    if target and target.backend != "local":
        raise HTTPException(409, "请使用 OSS 分片直传")
    if row.status != "uploading":
        raise HTTPException(409, "上传已经结束")
    if target and aware(target.expires_at) <= dt.datetime.now(dt.UTC):
        raise HTTPException(410, "上传已过期")
    with external_io(db, row):
        data = bytearray()
        async for block in request.stream():
            data.extend(block)
            if len(data) > 8 * 1024**2:
                raise HTTPException(413, "上传块过大")
    if not data or offset < 0 or offset + len(data) > row.size:
        raise HTTPException(422, "上传范围错误")
    if hashlib.sha256(data).hexdigest() != request.headers.get("x-chunk-sha256"):
        raise HTTPException(422, "文件校验失败，请重新上传这一块")
    return await run_in_threadpool(write_chunk, db, row, offset, data)


def write_chunk(db, row, offset, data):
    path = get_settings().data_dir / "uploads" / f"{row.id}.part"
    # Shared with completion, cancellation and expiry across API processes.
    with external_io(db, row):
        pass
    with upload_lock(row.id):
        db.refresh(row)
        if row.status != "uploading":
            raise HTTPException(409, "上传已经结束")
        duplicate = offset < row.offset
        with external_io(db, row), open(path, "r+b" if path.exists() else "w+b") as target:
            if duplicate:
                target.seek(offset)
                if offset + len(data) > row.offset or target.read(len(data)) != data:
                    raise HTTPException(409, "上传块与已接收文件不一致")
            else:
                if offset != row.offset:
                    raise HTTPException(409, "上传偏移已变化，请刷新进度")
                target.truncate(row.offset)
                target.seek(row.offset)
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
        if not duplicate:
            row.offset += len(data)
            db.commit()
    return upload_dto(db, row)


def accept_video_metadata(row, body, *, required=False):
    if row.kind != "video":
        return
    if body is None:
        if required:
            raise HTTPException(422, "请重新选择原视频，由浏览器读取视频时长后继续上传")
        return
    try:
        save_metadata(row.id, body)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


def complete_cover(db, row, target):
    """Validate and publish a bounded image inline, under the upload lock."""
    remote = bool(target and target.backend == "oss")
    source = get_settings().data_dir / "uploads" / f"{row.id}.part"
    root = get_settings().resolved_media_dir().resolve()
    destination = root / "managed" / row.family_id / f"{row.id}{Path(row.filename).suffix.lower()}"
    try:
        with external_io(db, row, target):
            try:
                if remote:
                    source.parent.mkdir(parents=True, exist_ok=True)
                    build_storage("oss").download(target.object_key, source, row.size)
                if not source.is_file() or source.stat().st_size != row.size:
                    raise HTTPException(422, "封面文件缺失或大小不一致，请重新上传")
                try:
                    with Image.open(source) as image:
                        mime = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}.get(image.format)
                        if mime is None:
                            raise ValueError("unsupported image format")
                        image.verify()
                except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
                    raise HTTPException(422, "封面图片无效，请选择完整的 JPG、PNG 或 WebP 图片") from error
                with source.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if not remote:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    staging = destination.with_suffix(destination.suffix + ".tmp")
                    shutil.copyfile(source, staging)
                    staging.replace(destination)
            finally:
                if remote:
                    source.unlink(missing_ok=True)
        # The resource may have been archived while storage I/O was in progress.
        item = owned(db, Item, row.item_id, row.family_id)
        db.refresh(item)
        ensure_active(db, item)
        for old in db.query(MediaFile).filter_by(item_id=item.id, kind="image").all():
            old.kind = "retired_image"
        db.add(MediaFile(
            id=row.id, family_id=row.family_id, item_id=item.id, kind="image",
            storage="oss" if remote else "local",
            path=target.object_key if remote else str(destination.relative_to(root)),
            mime=mime, language=row.language, is_default=False, index=0,
            size_bytes=row.size, sha256=digest,
        ))
        db.flush()
        db.add(MediaOptions(media_id=row.id, retention="backup", label=row.filename))
        item.primary_image_tag = row.id
        row.offset, row.status, row.error = row.size, "ready", ""
        db.commit()
    except Exception:
        db.rollback()
        raise
    # Keep the upload source until the catalog transaction has committed.
    if not remote:
        try:
            source.unlink(missing_ok=True)
        except OSError:
            logging.getLogger(__name__).exception("Committed cover source cleanup failed for %s", row.id)
    return upload_dto(db, row)


@router.post("/uploads/{upload_id}/complete")
def complete_upload(upload_id: str, user: Parent, db: DbSession, body: VideoMetadata | None = None):
    row = owned(db, UploadSession, upload_id, user.family_id)
    if row.status == "processing" or row.status == "ready":
        return upload_dto(db, row)
    target = transport(db, row)
    if target and target.backend == "oss":
        with external_io(db, row):
            pass
        with upload_lock(row.id):
            db.refresh(row)
            if row.status in ("processing", "ready"):
                return upload_dto(db, row)
            target = check_target(db, row)
            with external_io(db, row):
                accept_video_metadata(row, body, required=True)
                store = build_storage("oss")
                # Recover an OSS completion whose database commit was interrupted.
                size = store.size_if_exists(target.object_key)
                if size is None:
                    parts = verified_parts(target, row)
                    if sum(p["size"] for p in parts) != row.size:
                        raise HTTPException(409, "文件尚未上传完整")
                    store.complete(target.object_key, target.multipart_id, parts)
                    size = store.size(target.object_key)
                if size != row.size:
                    raise HTTPException(409, "云端文件大小不一致")
            if row.kind == "image":
                return complete_cover(db, row, target)
            row.offset = row.size
            row.status = "processing"
            if not db.query(MediaTask).filter(MediaTask.upload_id == row.id).first():
                db.add(MediaTask(upload_id=row.id))
            db.commit()
            return upload_dto(db, row)
    with external_io(db, row):
        pass
    with upload_lock(row.id):
        db.refresh(row)
        if row.status in ("processing", "ready"):
            return upload_dto(db, row)
        target = transport(db, row)
        if target and aware(target.expires_at) <= dt.datetime.now(dt.UTC):
            raise HTTPException(410, "上传已过期")
        if row.status != "uploading" or row.offset != row.size:
            raise HTTPException(409, "文件尚未上传完整")
        if row.kind == "image":
            return complete_cover(db, row, target)
        with external_io(db, row):
            accept_video_metadata(row, body)
        row.status = "processing"
        if not db.query(MediaTask).filter(MediaTask.upload_id == row.id).first():
            db.add(MediaTask(upload_id=row.id))
        db.commit()
        return upload_dto(db, row)


@router.post("/uploads/{upload_id}/cancel")
def cancel_upload(upload_id: str, user: Parent, db: DbSession):
    row = owned(db, UploadSession, upload_id, user.family_id)
    if row.status not in ("uploading", "failed"):
        raise HTTPException(409, "仅可取消未完成或处理失败的上传")
    with external_io(db, row):
        pass
    with upload_lock(row.id):
        db.refresh(row)
        if row.status not in ("uploading", "failed"):
            raise HTTPException(409, "仅可取消未完成或处理失败的上传")
        if db.get(MediaFile, row.id) is not None:
            raise HTTPException(409, "文件已入库，不能作为失败上传删除")
        target = transport(db, row)
        if not cleanup_upload_files(db, row, target):
            raise HTTPException(409, "文件已入库，不能作为失败上传删除")
        task = db.query(MediaTask).filter(MediaTask.upload_id == row.id).first()
        if task:
            task.status = "cancelled"
        row.status = "cancelled"
        db.commit()
    return {"ok": True}


@router.post("/tasks/{task_id}/retry")
def retry_task(task_id: str, user: Parent, db: DbSession):
    task = db.get(MediaTask, task_id)
    if task is None:
        raise HTTPException(404)
    row = owned(db, UploadSession, task.upload_id, user.family_id)
    ensure_active(db, owned(db, Item, row.item_id, user.family_id))
    with external_io(db, row, task):
        pass
    with upload_lock(row.id):
        serialize_sqlite_write(db)
        db.refresh(row)
        db.refresh(task)
        if task.status != "failed" or row.status != "failed":
            raise HTTPException(409, "任务不可重试，文件可能已过期清理")
        task.status, task.error = "queued", ""
        row.status, row.error = "processing", ""
        target = transport(db, row)
        if target is None:
            target = UploadTarget(upload_id=row.id, backend="local")
            db.add(target)
        target.expires_at = dt.datetime.now(dt.UTC) + dt.timedelta(hours=get_settings().upload_expiry_hours)
        db.commit()
    return upload_dto(db, row)


@router.get("/uploads/{upload_id}/parts")
def upload_parts(upload_id: str, user: Parent, db: DbSession):
    row = owned(db, UploadSession, upload_id, user.family_id)
    target = check_target(db, row)
    with external_io(db):
        parts = verified_parts(target, row)
    return {"parts": parts, "partSize": PART_SIZE}


class PartBody(BaseModel):
    number: int = Field(ge=1, le=10000)
    md5: str = Field(pattern=r"^[A-Za-z0-9+/]{22}==$", min_length=24, max_length=24)


@router.post("/uploads/{upload_id}/part-url")
def part_url(upload_id: str, body: PartBody, user: Parent, db: DbSession):
    row = owned(db, UploadSession, upload_id, user.family_id)
    target = check_target(db, row)
    if body.number > (row.size + PART_SIZE - 1) // PART_SIZE:
        raise HTTPException(422, "分片编号超出文件范围")
    with external_io(db):
        ttl = min(
            get_storage_settings().oss_upload_ttl,
            max(1, int((aware(target.expires_at) - dt.datetime.now(dt.UTC)).total_seconds())),
        )
        return build_storage("oss").part_url(
            target.object_key, target.multipart_id, body.number, ttl, body.md5
        )


class SubtitleOptionsBody(BaseModel):
    language: str = Field(default="und", max_length=16)
    label: str = Field(default="", max_length=256)
    offsetMs: int = Field(default=0, ge=-600000, le=600000)


@router.patch("/resources/{item_id}/subtitles/{media_id}")
def subtitle_options(
    item_id: str, media_id: str, body: SubtitleOptionsBody, user: Parent, db: DbSession
):
    serialize_sqlite_write(db)
    ensure_active(db, owned(db, Item, item_id, user.family_id))
    media = owned(db, MediaFile, media_id, user.family_id)
    if media.item_id != item_id or media.kind != "subtitle":
        raise HTTPException(404)
    media.language = body.language
    options = db.get(MediaOptions, media_id) or MediaOptions(media_id=media_id)
    options.label, options.offset_ms = body.label.strip(), body.offsetMs
    db.add(options)
    db.commit()
    return {"ok": True}
