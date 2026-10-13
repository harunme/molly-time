"""Parent download commands and device-owned status reports (no cloud deletion)."""

import datetime as dt

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..deps import CurrentUser, DbSession
from ..manage_auth import Parent, aware
from ..management_models import Device, DeviceDownload
from ..models import Item, MediaFile
from ..resource_policy import require_visible
from ..storage import build_storage
from ..transactions import serialize_sqlite_write
from ..trash import ensure_active
from .manage_resources import owned
from .pagination import paginate
from .playback import playback_info

router = APIRouter(tags=["downloads"])


def download_dto(row, db):
    file = db.get(MediaFile, row.media_id)
    device = db.get(Device, row.device_id)
    return {
        "id": row.id,
        "deviceId": row.device_id,
        "deviceName": device.name,
        "mediaId": row.media_id,
        "episodeId": file.item_id,
        "version": file.sha256 or file.id,
        "size": file.size_bytes,
        "desired": row.desired,
        "status": row.status,
        "downloadedBytes": row.downloaded_bytes,
        "error": row.error,
        "updatedAt": aware(row.updated_at).isoformat(),
        "deviceLastSeen": aware(device.last_seen).isoformat(),
        "deviceRevoked": device.revoked,
    }


@router.get("/api/manage/resources/{item_id}/downloads")
def list_downloads(
    item_id: str, user: Parent, db: DbSession,
    page: int | None = Query(default=None, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
    deviceIds: str = Query(default="", max_length=4000),
    mediaId: str | None = None,
):
    owned(db, Item, item_id, user.family_id)
    query = (
        db.query(DeviceDownload)
        .join(MediaFile)
        .filter(DeviceDownload.family_id == user.family_id, MediaFile.item_id == item_id)
    )
    if deviceIds:
        keys = list(dict.fromkeys(deviceIds.split(",")))
        if len(keys) > 100:
            raise HTTPException(422, "单次最多查询 100 个设备")
        query = query.filter(DeviceDownload.device_id.in_(keys))
    if mediaId:
        query = query.filter(DeviceDownload.media_id == mediaId)
    return paginate(query.order_by(DeviceDownload.updated_at.desc(), DeviceDownload.id),
                    page, pageSize, lambda row: download_dto(row, db))


class CommandBody(BaseModel):
    deviceId: str
    desired: str = Field(default="saved", pattern="^(saved|removed)$")


@router.post("/api/manage/resources/{item_id}/downloads")
def command(item_id: str, body: CommandBody, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    item = owned(db, Item, item_id, user.family_id)
    ensure_active(db, item)
    device = owned(db, Device, body.deviceId, user.family_id)
    if device.revoked:
        raise HTTPException(409, "设备已取消配对")
    media = (
        db.query(MediaFile).filter(MediaFile.item_id == item.id, MediaFile.kind == "video").first()
    )
    if not media:
        raise HTTPException(409, "暂无处理完成的视频")
    if not media.size_bytes:
        media.size_bytes = build_storage(media.storage).size(media.path)
    row = (
        db.query(DeviceDownload)
        .filter(DeviceDownload.device_id == device.id, DeviceDownload.media_id == media.id)
        .first()
    )
    if row is None:
        row = DeviceDownload(family_id=user.family_id, device_id=device.id, media_id=media.id)
        db.add(row)
    row.desired, row.status, row.error = body.desired, "queued", ""
    row.updated_at = dt.datetime.now(dt.UTC)
    db.commit()
    return download_dto(row, db)


def device_id(request):
    value = getattr(request.state, "device_id", None)
    if not value:
        raise HTTPException(403, "请使用已配对电视")
    return value


@router.get("/api/device/downloads")
def pending(request: Request, user: CurrentUser, db: DbSession):
    device = device_id(request)
    rows = (
        db.query(DeviceDownload)
        .filter(DeviceDownload.family_id == user.family_id, DeviceDownload.device_id == device)
        .all()
    )
    result = []
    for row in rows:
        file = db.get(MediaFile, row.media_id)
        episode = db.get(Item, file.item_id)
        entry = download_dto(row, db)
        entry["desired"] = row.desired if file.kind == "video" else "removed"
        # Deleted/retired versions are purged even when an old request said saved.
        if entry["desired"] == "saved" and row.status != "saved":
            try:
                require_visible(db, episode, request)
            except HTTPException:
                continue
            entry["playback"] = playback_info(db, file)
        result.append(entry)
    return result


class StatusBody(BaseModel):
    status: str = Field(pattern="^(downloading|saved|failed|removed)$")
    downloadedBytes: int = Field(default=0, ge=0)
    error: str = Field(default="", max_length=256)
    version: str = Field(max_length=128)


@router.post("/api/device/downloads/{download_id}/status")
def report(download_id: str, body: StatusBody, request: Request, user: CurrentUser, db: DbSession):
    row = owned(db, DeviceDownload, download_id, user.family_id)
    if row.device_id != device_id(request):
        raise HTTPException(404)
    file = db.get(MediaFile, row.media_id)
    if body.version != (file.sha256 or file.id) or body.downloadedBytes > file.size_bytes:
        raise HTTPException(409, "文件版本或下载大小不一致")
    desired = row.desired if file.kind == "video" else "removed"
    if body.status == "saved" and (desired != "saved" or body.downloadedBytes != file.size_bytes):
        raise HTTPException(409, "保存状态与下载任务不一致")
    row.status, row.downloaded_bytes, row.error = body.status, body.downloadedBytes, body.error
    row.updated_at = dt.datetime.now(dt.UTC)
    db.commit()
    return {"ok": True}


@router.get("/api/device/downloads/{download_id}/playback")
def download_playback(download_id: str, request: Request, user: CurrentUser, db: DbSession):
    row = owned(db, DeviceDownload, download_id, user.family_id)
    if row.device_id != device_id(request) or row.desired != "saved":
        raise HTTPException(404)
    file = db.get(MediaFile, row.media_id)
    if file.kind != "video":
        raise HTTPException(409, "视频版本已更新")
    require_visible(db, db.get(Item, file.item_id), request)
    return playback_info(db, file)
