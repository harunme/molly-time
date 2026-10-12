"""Authenticated, bounded APK uploads; publishing shares the CLI validation path."""

import datetime as dt
import fcntl
import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Annotated, Literal

import aiofiles
from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as ApiPath
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..client_releases import MAX_APK_BYTES, release_dir
from ..config import get_settings
from ..scripts.publish_tv_release import publish, tool_environment
from ..storage.settings import get_storage_settings
from .operations import Operator

router = APIRouter(prefix="/api/manage/operations/client-releases", tags=["operations"])
UploadId = Annotated[str, ApiPath(pattern=r"^[a-f0-9]{32}$")]


class UploadBody(BaseModel):
    filename: str = Field(min_length=1, max_length=200, pattern=r"(?i)^.+\.apk$")
    size: int = Field(gt=0, le=MAX_APK_BYTES)
    storage: Literal["local", "oss"] = "local"
    notes: str = Field(default="", max_length=4000)


def tools_ready():
    directory = get_settings().android_build_tools_dir
    env = tool_environment()
    java = Path(env["JAVA_HOME"]) / "bin/java" if env.get("JAVA_HOME") else shutil.which("java")
    if not all(os.access(directory / name, os.X_OK) for name in ("apksigner", "aapt")) or not (
        java and os.access(java, os.X_OK)
    ):
        return False
    try:
        for name, argument in (("apksigner", "version"), ("aapt", "version")):
            result = subprocess.run(
                [str(directory / name), argument], check=False, capture_output=True, timeout=10, env=env
            )
            if result.returncode:
                return False
        return True
    except (OSError, subprocess.TimeoutExpired):
        return False


def options():
    storage = get_storage_settings()
    return {
        "canUpload": tools_ready(),
        "ossConfigured": bool(
            storage.oss_endpoint
            and storage.oss_bucket
            and storage.oss_access_key_id
            and storage.oss_access_key_secret
        ),
        "maxSize": MAX_APK_BYTES,
    }


@router.get("/upload-options")
def upload_options(user: Operator):
    return options()


@router.post("/uploads")
def start_upload(body: UploadBody, user: Operator):
    capability = options()
    if not capability["canUpload"]:
        raise HTTPException(
            503, "服务端 APK 校验工具不可用，请配置 Android build-tools 和 Java 后重试"
        )
    if body.storage == "oss" and not capability["ossConfigured"]:
        raise HTTPException(422, "请先在文件存储中配置 OSS")
    directory = release_dir() / "uploads"
    directory.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(directory).free < body.size * 2 + 64 * 1024**2:
        raise HTTPException(507, "服务器空间不足，请清理后重试")
    identifier = uuid.uuid4().hex
    ticket = {
        **body.model_dump(),
        "owner": user.id,
        "expiresAt": (dt.datetime.now(dt.UTC) + dt.timedelta(hours=1)).isoformat(),
    }
    with (directory / f"{identifier}.json").open("x") as handle:
        json.dump(ticket, handle)
    return {"id": identifier}


def upload_ticket(identifier, user):
    path = release_dir() / "uploads" / f"{identifier}.json"
    if not path.is_file():
        raise HTTPException(404, "上传任务不存在，请重新选择安装包")
    try:
        ticket = json.loads(path.read_text())
        body = UploadBody.model_validate(ticket)
    except (ValueError, OSError):
        raise HTTPException(503, "上传任务不可用，请重新上传")
    if ticket.get("owner") != user.id:
        raise HTTPException(404, "上传任务不存在")
    if dt.datetime.fromisoformat(ticket["expiresAt"]) <= dt.datetime.now(dt.UTC):
        path.unlink(missing_ok=True)
        raise HTTPException(410, "上传任务已过期，请重新上传")
    return path, body


@router.delete("/uploads/{upload_id}")
def cancel_upload(upload_id: UploadId, user: Operator):
    ticket, _ = upload_ticket(upload_id, user)
    lock_path = ticket.with_suffix(".lock")
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(409, "安装包正在处理，请等待上传结束后刷新列表")
        ticket.unlink(missing_ok=True)
        lock_path.unlink(missing_ok=True)
    return {"ok": True}


@router.put("/uploads/{upload_id}")
async def upload_apk(upload_id: UploadId, request: Request, user: Operator):
    ticket, body = upload_ticket(upload_id, user)
    content_length = request.headers.get("content-length")
    if content_length is not None and (
        not content_length.isdigit() or int(content_length) != body.size
    ):
        raise HTTPException(422, "安装包上传大小与声明不一致")
    lock_path = ticket.with_suffix(".lock")
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(409, "安装包正在上传或发布，请勿重复提交")
        try:
            # A completed first request may have consumed the ticket before this lock was acquired.
            ticket, body = upload_ticket(upload_id, user)
            with tempfile.TemporaryDirectory(dir=ticket.parent) as temporary:
                apk = Path(temporary) / "upload.apk"
                received = 0
                async with aiofiles.open(apk, "wb") as handle:
                    async for block in request.stream():
                        received += len(block)
                        if received > body.size:
                            raise HTTPException(413, "安装包超出声明大小")
                        await handle.write(block)
                if received != body.size:
                    raise HTTPException(422, "安装包上传不完整，请重试")
                try:
                    release = await run_in_threadpool(
                        publish,
                        apk,
                        body.storage,
                        body.notes,
                        get_settings().android_build_tools_dir,
                    )
                except subprocess.CalledProcessError:
                    raise HTTPException(422, "APK 签名校验或格式检查失败，请上传完整的已签名安装包")
                except subprocess.TimeoutExpired:
                    raise HTTPException(503, "APK 校验超时，请检查服务端校验工具后重试")
                except ValueError as error:
                    message = str(error)
                    if "versionCode" in message:
                        raise HTTPException(409, "构建号必须高于当前版本，同一构建号不能替换安装包")
                    if "signing certificate" in message:
                        raise HTTPException(422, "APK 签名与当前渠道不一致，请使用原有签名密钥")
                    raise HTTPException(
                        422, "APK 包名、版本或格式无效，仅支持 MollyTime 正式版和 debug 包"
                    )
                except Exception:
                    logging.getLogger(__name__).exception("APK upload publication failed")
                    raise HTTPException(
                        503, "安装包发布失败，请检查服务器空间、校验工具或 OSS 配置后重试"
                    )
                return {"release": release.model_dump()}
        except OSError:
            raise HTTPException(507, "服务器空间不足或无法写入安装包，请检查后重试")
        finally:
            ticket.unlink(missing_ok=True)
            lock_path.unlink(missing_ok=True)
