"""Durable SQLite media tasks. Embedded worker or `python -m ...media_worker`."""

import datetime as dt
import fcntl
import hashlib
import json
import logging
import math
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

from PIL import Image
from sqlalchemy import or_, update

from .config import get_settings
from .covers import extract_cover
from .db import get_session_factory, init_db
from .management_models import MediaOptions, MediaTask, ResourceState, UploadSession, UploadTarget
from .models import Item, MediaFile
from .storage import build_storage
from .utils.image import atomic_write

logger = logging.getLogger(__name__)


def inspect_video(path: Path) -> int:
    """Validate an MP4 video; codec compatibility belongs to the playback device."""
    if not shutil.which("ffprobe") or not shutil.which("ffmpeg"):
        raise ValueError("未安装 FFmpeg/FFprobe，请安装后重试处理")
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                str(path),
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=45,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        raise ValueError("无法读取视频信息，文件可能损坏或不完整，请检查原文件") from error
    except subprocess.TimeoutExpired as error:
        raise ValueError("视频信息检查超时，请重试处理") from error
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if "mp4" not in data.get("format", {}).get("format_name", "").split(","):
        raise ValueError("文件不是 MP4 容器")
    if not any(
        s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
        for s in streams
    ):
        raise ValueError("文件中没有视频轨道，请上传包含画面的视频")
    try:
        duration = float(data.get("format", {}).get("duration", 0))
    except (TypeError, ValueError) as error:
        raise ValueError("无法读取有效视频时长，请检查文件是否完整") from error
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("无法读取有效视频时长，请检查文件是否完整")
    return round(duration * 10_000_000)


def process(task_id):
    factory = get_session_factory()
    with factory() as db:
        task = db.get(MediaTask, task_id)
        upload = db.get(UploadSession, task.upload_id)
        item = db.get(Item, upload.item_id)
        target = db.get(UploadTarget, upload.id)
        remote = bool(target and target.backend == "oss")
        source = get_settings().data_dir / "uploads" / f"{upload.id}.part"
        root = get_settings().resolved_media_dir().resolve()
        folder = root / "managed" / upload.family_id
        folder.mkdir(parents=True, exist_ok=True)
        destination = folder / f"{upload.id}{Path(upload.filename).suffix.lower()}"
        try:
            if remote:
                source.parent.mkdir(parents=True, exist_ok=True)
                if upload.size > get_settings().media_processing_max_bytes:
                    raise ValueError("文件超出处理容量限制，请联系管理员")
                if shutil.disk_usage(source.parent).free < upload.size + 64 * 1024**2:
                    raise ValueError("处理磁盘空间不足，请稍后重试")
                build_storage("oss").download(target.object_key, source, upload.size)
            if not source.is_file() or source.stat().st_size != upload.size:
                raise ValueError("临时文件缺失或大小不一致，请重新上传")
            digest = hashlib.sha256()
            with source.open("rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(block)
            runtime = None
            cover_data = None
            cover = folder / f"{upload.id}-cover.jpg"
            if upload.kind == "video":
                runtime = inspect_video(source)
                try:
                    cover_data = extract_cover(source, runtime)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    # The TV may support a codec that this FFmpeg build cannot decode.
                    # An optional automatic cover must not block a valid video upload.
                    logger.warning("Automatic cover extraction failed for %s", upload.id, exc_info=True)
                if cover_data is not None:
                    atomic_write(cover, cover_data)
                mime = "video/mp4"
            elif upload.kind == "image":
                with Image.open(source) as image:
                    image.verify()
                mime = "image/" + (
                    "jpeg" if destination.suffix in (".jpg", ".jpeg") else destination.suffix[1:]
                )
            else:
                content = source.read_text(encoding="utf-8-sig")
                if "-->" not in content or (
                    destination.suffix == ".vtt" and not content.startswith("WEBVTT")
                ):
                    raise ValueError("字幕需要 UTF-8 编码，并包含有效的时间轴")
                mime = "text/vtt" if destination.suffix == ".vtt" else "application/x-subrip"
            if not remote:
                staging = destination.with_suffix(destination.suffix + ".tmp")
                shutil.copyfile(source, staging)
                staging.replace(destination)
            if db.get(MediaFile, upload.id) is None:
                old = (
                    db.query(MediaFile)
                    .filter(MediaFile.item_id == item.id, MediaFile.kind == upload.kind)
                    .all()
                )
                index = max([f.index for f in old] + [-1]) + 1 if upload.kind == "subtitle" else 0
                if upload.kind != "subtitle":
                    for file in old:
                        file.kind = "retired_" + file.kind
                db.add(
                    MediaFile(
                        id=upload.id,
                        family_id=upload.family_id,
                        item_id=item.id,
                        kind=upload.kind,
                        storage="oss" if remote else "local",
                        path=target.object_key if remote else str(destination.relative_to(root)),
                        mime=mime,
                        language=upload.language,
                        is_default=False,
                        index=index,
                        size_bytes=upload.size,
                        sha256=digest.hexdigest(),
                    )
                )
            db.flush()
            if db.get(MediaOptions, upload.id) is None:
                db.add(MediaOptions(media_id=upload.id, retention="backup", label=upload.filename))
            if upload.kind == "image":
                item.primary_image_tag = upload.id
            if runtime is not None:
                item.runtime_ticks = runtime
                state = db.get(ResourceState, item.id)
                if state is None:
                    state = ResourceState(item_id=item.id, status="published", ready=True)
                    db.add(state)
                state.ready = True
                if (
                    cover_data is not None and not db.query(MediaFile.id)
                    .filter(MediaFile.item_id == item.id, MediaFile.kind == "image")
                    .first()
                ):
                    image_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "molly-cover:" + upload.id))
                    if not db.get(MediaFile, image_id):
                        db.add(
                            MediaFile(
                                id=image_id,
                                family_id=upload.family_id,
                                item_id=item.id,
                                kind="image",
                                storage="local",
                                path=str(cover.relative_to(root)),
                                mime="image/jpeg",
                                size_bytes=cover.stat().st_size,
                            )
                        )
                    item.primary_image_tag = image_id
            upload.status, upload.error = "ready", ""
            task.status, task.error, task.lease_until = "done", "", None
            db.commit()
            # Source can be removed only after the catalog transaction is durable.
            try:
                source.unlink(missing_ok=True)
            except OSError:
                logger.exception("Committed media source cleanup failed for %s", upload.id)
        except Exception as error:  # noqa: BLE001 -- persist failure for any task error
            db.rollback()
            logger.warning("Media task %s failed: %s", task_id, type(error).__name__)
            task = db.get(MediaTask, task_id)
            upload = db.get(UploadSession, task.upload_id)
            message = (
                str(error)
                if isinstance(error, ValueError)
                else "文件检查失败，请检查文件或服务日志后重试"
            )
            task.status, task.error, task.lease_until = "failed", message, None
            upload.status, upload.error = "failed", message
            db.commit()
        finally:
            if remote:
                try:
                    source.unlink(missing_ok=True)
                except OSError:
                    logger.exception("Remote processing temporary cleanup failed for %s", upload.id)


def run_once():
    # Serialize processing across embedded workers/processes sharing this data directory.
    folder = get_settings().data_dir
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "media-worker.lock").open("a+b") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return _run_once()


def _run_once():
    with get_session_factory()() as db:
        now = dt.datetime.now(dt.UTC)
        eligible = or_(
            MediaTask.status == "queued",
            (MediaTask.status == "running") & (MediaTask.lease_until < now),
        )
        task = db.query(MediaTask).filter(eligible).first()
        if task is None:
            return False
        key = task.id
        result = db.execute(
            update(MediaTask)
            .where(MediaTask.id == key, eligible)
            # SQLite returns naive timestamps; evaluate the lease predicate in SQL,
            # not against ORM objects using an aware UTC `now`. This session closes
            # immediately after claiming the task, so in-memory synchronization is unnecessary.
            .execution_options(synchronize_session=False)
            .values(
                status="running",
                lease_until=now + dt.timedelta(minutes=10),
                attempts=MediaTask.attempts + 1,
            )
        )
        db.commit()
        if result.rowcount != 1:
            return False
    process(key)
    return True


def loop(stop):
    last_cleanup = None
    while not stop.is_set():
        try:
            now = dt.datetime.now(dt.UTC)
            if last_cleanup is None or (now - last_cleanup).total_seconds() >= 300:
                from .remote_uploads import expire_uploads

                last_cleanup = now
                try:
                    expire_uploads()
                except Exception:  # Cleanup failure must not starve media tasks.
                    logger.exception("Upload expiry cleanup failed")
            worked = run_once()
        except Exception:
            logger.exception("Media worker iteration failed")
            worked = False
        if not worked:
            stop.wait(1)


def start_worker():
    stop = threading.Event()
    thread = threading.Thread(target=loop, args=(stop,), name="mollytime-media", daemon=True)
    thread.start()
    return stop, thread


if __name__ == "__main__":
    init_db()
    logging.basicConfig(level=logging.INFO)
    loop(threading.Event())
