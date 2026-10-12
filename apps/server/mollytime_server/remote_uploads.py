"""Multipart upload policy. Exact validation and side effects remain server owned."""

import datetime as dt
import fcntl
from contextlib import contextmanager

from fastapi import HTTPException
from sqlalchemy import func

from .config import get_settings
from .manage_auth import aware
from .management_models import UploadSession, UploadTarget
from .models import MediaFile
from .storage import build_storage

PART_SIZE = 8 * 1024**2


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
    used = (
        db.query(func.coalesce(func.sum(MediaFile.size_bytes), 0))
        .filter(MediaFile.family_id == family)
        .scalar()
    )
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


def expire_uploads():
    """Only unfinished uploads expire. Published cloud media is never deleted."""
    from .db import get_session_factory

    with get_session_factory()() as db:
        keys = [
            r.upload_id
            for r in db.query(UploadTarget)
            .filter(UploadTarget.expires_at < dt.datetime.now(dt.UTC))
            .all()
        ]
        for key in keys:
            with upload_lock(key):
                row = db.get(UploadSession, key)
                target = db.get(UploadTarget, key)
                db.refresh(row)
                if row.status != "uploading":
                    continue
                if target.backend == "oss":
                    store = build_storage("oss")
                    store.abort(target.object_key, target.multipart_id)
                    store.delete(target.object_key)
                else:
                    (get_settings().data_dir / "uploads" / f"{key}.part").unlink(missing_ok=True)
                row.status, row.error = "cancelled", "上传已过期，请重新上传"
                db.commit()
