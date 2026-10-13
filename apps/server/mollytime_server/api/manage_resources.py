"""Family resource CRUD and bounded, resumable local uploads."""

import datetime as dt
import hashlib
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..deps import DbSession
from ..images import image_url
from ..manage_auth import Parent, aware
from ..management_models import MediaOptions, MediaTask, ResourceState, UploadSession, UploadTarget
from ..models import Item, MediaFile
from ..remote_uploads import (
    PART_SIZE,
    check_target,
    ensure_capacity,
    transport,
    upload_lock,
    verified_parts,
)
from ..storage import build_storage
from ..storage.settings import get_storage_settings
from ..transactions import serialize_sqlite_write
from ..trash import archive, ensure_active
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


@router.get("/resources")
def resources(
    user: Parent, db: DbSession, parentId: str | None = None,
    page: int | None = Query(default=None, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
    q: str = Query(default="", max_length=256),
    status: str = Query(default="", pattern="^(|draft|published|archived)$"),
    summary: bool = False, ids: str = Query(default="", max_length=4000),
):
    query = db.query(Item).filter(Item.family_id == user.family_id)
    if parentId:
        ensure_active(db, owned(db, Item, parentId, user.family_id))
        query = query.filter(Item.parent_id == parentId)
    else:
        query = query.filter(Item.type == "Series")
    if ids:
        keys = list(dict.fromkeys(ids.split(",")))
        if len(keys) > 100:
            raise HTTPException(422, "单次最多查询 100 个资源")
        query = query.filter(Item.id.in_(keys))
    query = resource_filters(query, q, status)
    return paginate(query.order_by(Item.index_number, Item.sort_name, Item.name, Item.id),
                    page, pageSize, lambda item: resource_summary(db, item) if summary else dto(db, item, page is None),
                    lambda rows: prime_resources(db, rows, summary or page is not None))


@router.get("/resources/stats")
def resource_stats(user: Parent, db: DbSession):
    active = (
        db.query(Item.id, Item.type, func.coalesce(ResourceState.status, "published"), func.coalesce(ResourceState.ready, True), Item.runtime_ticks)
        .outerjoin(ResourceState, ResourceState.item_id == Item.id)
        .filter(
            Item.family_id == user.family_id,
            func.coalesce(ResourceState.status, "published").notin_(["archived", "deleted"]),
        )
        .all()
    )
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
    ensure_active(db, folder)
    if folder.type != "Series":
        raise HTTPException(422, "请选择文件夹")
    seasons = db.query(Item.id).filter(
        Item.family_id == user.family_id, Item.parent_id == folder.id, Item.type == "Season"
    )
    query = db.query(Item).filter(
        Item.family_id == user.family_id, Item.type == "Episode",
        or_(Item.parent_id == folder.id, Item.parent_id.in_(seasons)),
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


@router.post("/resources")
def create(body: ResourceBody, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "名称不能为空")
    parent = owned(db, Item, body.parentId, user.family_id) if body.parentId else None
    if parent:
        ensure_active(db, parent)
    expected = {"Season": ("Series",), "Episode": ("Series", "Season")}.get(body.type)
    if (expected and (parent is None or parent.type not in expected)) or (
        body.type == "Series" and parent
    ):
        raise HTTPException(422, "请先选择正确的文件夹")
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
    return dto(db, owned(db, Item, item_id, user.family_id))


class MoveBody(BaseModel):
    folderId: str


@router.post("/resources/{item_id}/move")
def move_video(item_id: str, body: MoveBody, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    item = owned(db, Item, item_id, user.family_id)
    folder = owned(db, Item, body.folderId, user.family_id)
    ensure_active(db, item)
    ensure_active(db, folder)
    if item.type != "Episode" or folder.type != "Series":
        raise HTTPException(422, "只能把视频移到文件夹")
    duplicate = (
        db.query(Item)
        .filter(
            Item.family_id == user.family_id,
            Item.parent_id == folder.id,
            Item.type == "Episode",
            Item.name == item.name,
            Item.id != item.id,
        )
        .first()
    )
    if duplicate:
        raise HTTPException(409, "文件夹已有同名视频")
    item.parent_id = folder.id
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "文件夹已有同名视频") from exc
    return dto(db, item)


class EditBody(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    overview: str = Field(default="", max_length=10000)
    indexNumber: int | None = Field(default=None, ge=1, le=100000)


@router.patch("/resources/{item_id}")
def edit(item_id: str, body: EditBody, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    item = owned(db, Item, item_id, user.family_id)
    ensure_active(db, item)
    if not body.name.strip():
        raise HTTPException(422, "名称不能为空")
    item.name = item.sort_name = body.name.strip()
    item.overview, item.index_number = body.overview, body.indexNumber
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
):
    query = (
        db.query(UploadSession)
        .filter(UploadSession.family_id == user.family_id)
        .order_by(UploadSession.created_at.desc(), UploadSession.id.desc())
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
    directory = get_settings().data_dir / "uploads"
    directory.mkdir(parents=True, exist_ok=True)
    remaining = sum(
        r.size - r.offset
        for r in db.query(UploadSession).filter(UploadSession.status == "uploading").all()
    )
    if (
        get_storage_settings().storage_backend == "local"
        and shutil.disk_usage(directory).free < body.size + remaining + 64 * 1024**2
    ):
        raise HTTPException(507, "磁盘剩余空间不足")
    row = UploadSession(
        family_id=user.family_id,
        item_id=item.id,
        filename=Path(body.filename).name,
        size=body.size,
        fingerprint=body.fingerprint,
        kind=body.kind,
        language=body.language,
    )
    db.add(row)
    db.flush()
    backend = get_storage_settings().storage_backend
    if backend not in ("local", "oss"):
        raise HTTPException(503, "上传存储配置错误")
    target = UploadTarget(
        upload_id=row.id,
        backend=backend,
        expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(hours=get_settings().upload_expiry_hours),
    )
    if backend == "oss":
        target.object_key = f"families/{user.family_id}/media/{row.id}{ext}"
        try:
            target.multipart_id = build_storage("oss").initiate(target.object_key)
        except Exception as exc:
            raise HTTPException(503, "云存储不可用，请联系管理员") from exc
    db.add(target)
    try:
        db.commit()
    except Exception:
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
    with upload_lock(row.id):
        db.refresh(row)
        if row.status != "uploading":
            raise HTTPException(409, "上传已经结束")
        with open(path, "r+b" if path.exists() else "w+b") as target:
            if offset < row.offset:
                target.seek(offset)
                if offset + len(data) > row.offset or target.read(len(data)) != data:
                    raise HTTPException(409, "上传块与已接收文件不一致")
                return upload_dto(db, row)
            if offset != row.offset:
                raise HTTPException(409, "上传偏移已变化，请刷新进度")
            target.truncate(row.offset)
            target.seek(row.offset)
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
            row.offset += len(data)
            db.commit()
    return upload_dto(db, row)


@router.post("/uploads/{upload_id}/complete")
def complete_upload(upload_id: str, user: Parent, db: DbSession):
    row = owned(db, UploadSession, upload_id, user.family_id)
    if row.status == "processing" or row.status == "ready":
        return upload_dto(db, row)
    target = transport(db, row)
    if target and target.backend == "oss":
        with upload_lock(row.id):
            db.refresh(row)
            if row.status in ("processing", "ready"):
                return upload_dto(db, row)
            target = check_target(db, row)
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
            row.offset = row.size
            row.status = "processing"
            if not db.query(MediaTask).filter(MediaTask.upload_id == row.id).first():
                db.add(MediaTask(upload_id=row.id))
            db.commit()
            return upload_dto(db, row)
    with upload_lock(row.id):
        db.refresh(row)
        if row.status in ("processing", "ready"):
            return upload_dto(db, row)
        target = transport(db, row)
        if target and aware(target.expires_at) <= dt.datetime.now(dt.UTC):
            raise HTTPException(410, "上传已过期")
        if row.status != "uploading" or row.offset != row.size:
            raise HTTPException(409, "文件尚未上传完整")
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
    with upload_lock(row.id):
        db.refresh(row)
        if row.status not in ("uploading", "failed"):
            raise HTTPException(409, "仅可取消未完成或处理失败的上传")
        if db.get(MediaFile, row.id) is not None:
            raise HTTPException(409, "文件已入库，不能作为失败上传删除")
        target = transport(db, row)
        if target and target.backend == "oss":
            store = build_storage("oss")
            store.abort(target.object_key, target.multipart_id)
            store.delete(target.object_key)
        else:
            (get_settings().data_dir / "uploads" / f"{row.id}.part").unlink(missing_ok=True)
        task = db.query(MediaTask).filter(MediaTask.upload_id == row.id).first()
        if task:
            task.status = "cancelled"
        row.status = "cancelled"
        db.commit()
    return {"ok": True}


@router.post("/tasks/{task_id}/retry")
def retry_task(task_id: str, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    task = db.get(MediaTask, task_id)
    if task is None:
        raise HTTPException(404)
    row = owned(db, UploadSession, task.upload_id, user.family_id)
    ensure_active(db, owned(db, Item, row.item_id, user.family_id))
    if task.status != "failed":
        raise HTTPException(409, "任务没有失败")
    task.status, task.error = "queued", ""
    row.status, row.error = "processing", ""
    db.commit()
    return upload_dto(db, row)


@router.get("/uploads/{upload_id}/parts")
def upload_parts(upload_id: str, user: Parent, db: DbSession):
    row = owned(db, UploadSession, upload_id, user.family_id)
    target = check_target(db, row)
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
