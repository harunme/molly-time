"""Multipart upload policy. Exact validation and side effects remain server owned."""

import datetime as dt
import fcntl
import logging
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import and_, func, or_

from .config import get_settings
from .manage_auth import aware
from .management_models import MediaTask, UploadSession, UploadTarget
from .models import MediaFile
from .share_models import ContentShare, ShareFile
from .storage import build_storage
from .storage.local import LocalStorage
from .upload_metadata import metadata_path

PART_SIZE = 8 * 1024**2
logger = logging.getLogger(__name__)


@contextmanager
def upload_lock(upload_id):
    folder = get_settings().data_dir / "upload-locks"
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / f"{upload_id}.lock").open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def transport(db, row):
    return db.get(UploadTarget, row.id)


def check_target(db, row):
    target = transport(db, row)
    if not target or target.backend != "oss":
        raise HTTPException(409, "此上传不是 OSS 直传")
    if row.status != "uploading":
        raise HTTPException(409, "上传已经结束")
    if aware(target.expires_at) <= dt.datetime.now(dt.UTC):
        raise HTTPException(410, "上传已过期，请重新上传")
    return target


def verified_parts(target, row):
    parts = sorted(
        build_storage("oss").parts(target.object_key, target.multipart_id),
        key=lambda p: p["number"],
    )
    count = (row.size + PART_SIZE - 1) // PART_SIZE
    for part in parts:
        number = part["number"]
        expected = min(PART_SIZE, row.size - (number - 1) * PART_SIZE)
        if number < 1 or number > count or part["size"] != expected:
            raise HTTPException(409, "云端分片大小或编号错误，请取消后重新上传")
    if len({p["number"] for p in parts}) != len(parts):
        raise HTTPException(409, "云端分片编号重复")
    return parts


def ensure_capacity(db, family, size):
    limit = get_settings().family_storage_limit_bytes
    if not limit:
        return
    from .usage import family_objects

    used = sum(obj["size"] for obj in family_objects(db, family).values())
    reserved = (
        db.query(func.coalesce(func.sum(UploadSession.size), 0))
        .filter(
            UploadSession.family_id == family,
            UploadSession.status.in_(["uploading", "processing", "failed"]),
        )
        .scalar()
    )
    if used + reserved + size > limit:
        raise HTTPException(507, "家庭存储空间不足，请清理资源或联系管理员")


def referenced_upload_object(db, backend, keys) -> bool:
    return bool(db.query(MediaFile.id).filter(
        MediaFile.storage == backend, MediaFile.path.in_(keys),
    ).first() or db.query(ShareFile.id).join(ContentShare).filter(
        ShareFile.storage == backend, ShareFile.path.in_(keys),
        ContentShare.expires_at > dt.datetime.now(dt.UTC),
    ).first())


def cleanup_upload_files(db, row, target) -> bool:
    """Delete only unregistered upload artifacts. Caller holds this upload's lock."""
    if db.get(MediaFile, row.id) is not None:
        return False
    remote = target is not None and target.backend == "oss"
    if remote:
        if referenced_upload_object(db, "oss", [target.object_key]):
            return False
        store = build_storage("oss")
        store.abort(target.object_key, target.multipart_id)
        store.delete(target.object_key)
        if row.kind == "video":
            cover_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "molly-cover:" + row.id))
            cover_key = f"families/{row.family_id}/media/{cover_id}.jpg"
            if not referenced_upload_object(db, "oss", [cover_key]):
                store.delete(cover_key)
    directory = get_settings().data_dir / "uploads"
    (directory / f"{row.id}.part").unlink(missing_ok=True)
    metadata_path(row.id).unlink(missing_ok=True)
    root = get_settings().resolved_media_dir().resolve()
    base = f"managed/{row.family_id}/{row.id}"
    suffix = Path(row.filename).suffix.lower()
    local = LocalStorage(root)
    for key in (base + suffix, base + suffix + ".tmp", base + "-cover.jpg"):
        if not referenced_upload_object(db, "local", [key, str(root / key)]):
            local.delete(key)
    return True


def expire_uploads():
    """Expire abandoned/failed uploads; registered media and active tasks are protected."""
    from .db import get_session_factory

    factory = get_session_factory()
    now = dt.datetime.now(dt.UTC)
    cutoff = now - dt.timedelta(hours=get_settings().upload_expiry_hours)
    # Share the processing/deletion lock so a cleanup can never overlap a worker.
    folder = get_settings().data_dir
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "media-worker.lock").open("a+b") as processing_lock:
        try:
            fcntl.flock(processing_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        with factory() as db:
            keys = [key for (key,) in db.query(UploadSession.id).outerjoin(UploadTarget).filter(
                UploadSession.status.in_(["uploading", "failed"]),
                or_(UploadTarget.expires_at <= now,
                    and_(UploadTarget.upload_id.is_(None), UploadSession.created_at <= cutoff)),
            ).order_by(UploadSession.created_at, UploadSession.id).limit(100)]
        cleaned = 0
        for key in keys:
            with upload_lock(key), factory() as db:
                row = db.get(UploadSession, key)
                target = db.get(UploadTarget, key)
                if row is None or row.status not in ("uploading", "failed"):
                    continue
                if aware(target.expires_at if target else row.created_at) > (now if target else cutoff):
                    continue
                task = db.query(MediaTask).filter_by(upload_id=key).first()
                if task and task.status in ("queued", "running"):
                    continue
                try:
                    if not cleanup_upload_files(db, row, target):
                        continue
                    if task:
                        task.status, task.error, task.lease_until = "cancelled", "上传已过期", None
                    row.status, row.error = "cancelled", "上传或失败文件已过期清理，请重新上传"
                    db.commit()
                    cleaned += 1
                except Exception as error:  # noqa: BLE001 -- one failed deletion must not block others
                    db.rollback()
                    logger.warning("Upload cleanup failed for %s: %s", key, type(error).__name__)
                    row = db.get(UploadSession, key)
                    row.error = "自动清理失败，将稍后重试"
                    db.commit()
        return cleaned
