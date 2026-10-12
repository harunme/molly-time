"""Platform operations; family admins and device credentials cannot access these endpoints."""

import datetime as dt
import re
import uuid
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from ..client_releases import inventory, publication_lock
from ..deps import DbSession
from ..manage_auth import Parent
from ..management_models import OperationsStorage, UploadSession, UploadTarget
from ..models import MediaFile
from ..storage.oss import OssStorage
from ..storage.settings import FIELDS, encode, get_storage_settings
from ..transactions import serialize_sqlite_write

router = APIRouter(prefix="/api/manage/operations", tags=["operations"])


def superadmin(user: Parent):
    if user.role != "superadmin":
        raise HTTPException(403, "此操作需要平台超管运营权限")
    return user


Operator = Annotated[object, Depends(superadmin)]


class StorageBody(BaseModel):
    revision: int = Field(ge=0)
    storage_backend: Literal["local", "oss"]
    oss_endpoint: str = Field(default="", max_length=256)
    oss_bucket: str = Field(default="", max_length=63)
    oss_access_key_id: str = Field(default="", max_length=256)
    oss_access_key_secret: str = Field(default="", max_length=256)
    oss_internal_endpoint: str = Field(default="", max_length=256)
    oss_upload_ttl: int = Field(default=900, ge=60, le=3600)
    oss_signed_url_ttl: int = Field(default=3600, ge=60, le=14400)


def public_settings():
    s = get_storage_settings()
    result = {
        field: getattr(s, field) or ""
        for field in FIELDS
        if field not in ("oss_access_key_id", "oss_access_key_secret")
    }
    result.update(
        revision=s.revision,
        credentialsConfigured=bool(s.oss_access_key_id and s.oss_access_key_secret),
    )
    return result


def candidate(body):
    current = get_storage_settings()
    if body.revision != current.revision:
        raise HTTPException(409, "配置已被更新，请刷新页面")
    values = body.model_dump(exclude={"revision"})
    for field in ("oss_access_key_id", "oss_access_key_secret"):
        values[field] = values[field].strip() or getattr(current, field)
    for field in ("oss_endpoint", "oss_internal_endpoint", "oss_bucket"):
        values[field] = values[field].strip().rstrip("/")
    for field in ("oss_endpoint", "oss_internal_endpoint"):
        if not values[field]:
            continue
        try:
            url = urlsplit(values[field])
            port = url.port
        except ValueError as exc:
            raise HTTPException(422, "Endpoint 格式无效") from exc
        host = url.hostname or ""
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or port is not None
            or url.path
            or url.query
            or url.fragment
            or not re.fullmatch(r"oss-[a-z0-9-]+\.aliyuncs\.com", host)
        ):
            raise HTTPException(422, "Endpoint 请使用阿里云 OSS 的 HTTPS 地域域名")
    if values["oss_bucket"] and not re.fullmatch(
        r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", values["oss_bucket"]
    ):
        raise HTTPException(422, "Bucket 名称无效")
    if values["storage_backend"] == "oss" and not all(
        values[field]
        for field in ("oss_endpoint", "oss_bucket", "oss_access_key_id", "oss_access_key_secret")
    ):
        raise HTTPException(422, "请填写 Endpoint、Bucket 和访问密钥")
    return values, current


def test_connection(values):
    if not all(
        values[field]
        for field in ("oss_endpoint", "oss_bucket", "oss_access_key_id", "oss_access_key_secret")
    ):
        raise HTTPException(422, "测试连接前请填写完整 OSS 配置")
    store = OssStorage(
        endpoint=values["oss_endpoint"],
        bucket=values["oss_bucket"],
        access_key_id=values["oss_access_key_id"],
        access_key_secret=values["oss_access_key_secret"],
        internal_endpoint=values["oss_internal_endpoint"],
    )
    key = f"families/.operations-check/{uuid.uuid4()}"
    payload = b"MollyTime OSS connection check"
    clients = [store._client()]
    if values["oss_internal_endpoint"]:
        clients.append(store._client(True))
    for client in clients:
        written = False
        try:
            client.put_object(key, payload)
            written = True
            response = client.get_object(key)
            try:
                if response.read() != payload:
                    raise ValueError("content mismatch")
            finally:
                response.close()
        except Exception as exc:
            # SDK exceptions may contain signed URLs or credentials; never expose them.
            raise HTTPException(
                422, "OSS 读写测试失败，请检查密钥、Bucket、地域及 RAM 权限"
            ) from exc
        finally:
            if written:
                try:
                    client.delete_object(key)
                except Exception as exc:
                    raise HTTPException(
                        422, "测试对象清理失败，请检查删除权限并清理 families/.operations-check/"
                    ) from exc


@router.get("/storage")
def storage(user: Operator):
    return public_settings()


@router.post("/storage/test")
def check_storage(body: StorageBody, user: Operator):
    values, _ = candidate(body)
    test_connection(values)
    return {"ok": True, "message": "OSS 服务端读写及删除测试通过；浏览器跨域需在 Bucket 配置"}


def check_destination(db, values, current):
    has_files = db.query(MediaFile.id).filter(MediaFile.storage == "oss").first()
    pending = (
        db.query(UploadSession.id)
        .join(UploadTarget, UploadTarget.upload_id == UploadSession.id)
        .filter(
            UploadTarget.backend == "oss",
            UploadSession.status.in_(["uploading", "processing", "failed"]),
        )
        .first()
    )
    releases, _, invalid = inventory()
    if invalid:
        raise HTTPException(409, "客户端版本记录损坏，请先修复后修改存储配置")
    referenced = bool(has_files or pending or any(record.storage == "oss" for record in releases))
    changed = any(
        values[field] != (getattr(current, field) or "") for field in ("oss_endpoint", "oss_bucket")
    )
    if referenced and changed:
        raise HTTPException(
            409, "已有 OSS 文件、客户端安装包或未结束上传，请先迁移资源，不能直接切换 Bucket 或地域"
        )
    return referenced


@router.put("/storage")
def save_storage(body: StorageBody, user: Operator, db: DbSession):
    # Keep a release upload's selected bucket stable until its reference is recorded.
    with publication_lock():
        return persist_storage(body, user, db)


def persist_storage(body, user, db):
    values, current = candidate(body)
    referenced = check_destination(db, values, current)
    connection_changed = any(
        values[field] != (getattr(current, field) or "")
        for field in ("oss_access_key_id", "oss_access_key_secret", "oss_internal_endpoint")
    )
    if values["storage_backend"] == "oss" or (referenced and connection_changed):
        test_connection(values)
    serialize_sqlite_write(db)
    values, current = candidate(body)
    check_destination(db, values, current)
    record = {
        "config": encode(values),
        "updated_by": user.id,
        "updated_at": dt.datetime.now(dt.UTC),
    }
    if current.revision == 0:
        db.add(OperationsStorage(id="storage", revision=1, **record))
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(409, "配置已被更新，请刷新页面") from exc
    else:
        result = db.execute(
            update(OperationsStorage)
            .where(
                OperationsStorage.id == "storage", OperationsStorage.revision == current.revision
            )
            .values(revision=current.revision + 1, **record)
        )
        if result.rowcount != 1:
            db.rollback()
            raise HTTPException(409, "配置已被更新，请刷新页面")
        db.commit()
    return public_settings()
