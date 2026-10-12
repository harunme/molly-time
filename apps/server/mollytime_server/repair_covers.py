"""Repair proven automatic near-black covers; dry-run unless --apply is supplied."""

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import shutil
import sqlite3
import tempfile
import uuid
from pathlib import Path

from .config import get_settings
from .covers import extract_cover, is_black_cover
from .db import get_engine, get_session_factory
from .management_models import UploadSession
from .models import Item, MediaFile
from .storage import build_storage
from .utils.image import atomic_write


def repair(db, *, apply=False, item_id=None):
    settings = get_settings()
    root = settings.resolved_media_dir().resolve()
    query = db.query(MediaFile).filter(MediaFile.kind == "image")
    if item_id:
        query = query.filter(MediaFile.item_id == item_id)
    results = []
    for image in query.order_by(MediaFile.id).all():
        uploads = (
            db.query(UploadSession)
            .filter(
                UploadSession.item_id == image.item_id,
                UploadSession.family_id == image.family_id,
                UploadSession.kind == "video",
            )
            .all()
        )
        if not any(
            image.id == str(uuid.uuid5(uuid.NAMESPACE_URL, "molly-cover:" + u.id)) for u in uploads
        ):
            continue  # No reliable automatic-cover provenance: never change it.
        others = (
            db.query(MediaFile.id)
            .filter(
                MediaFile.item_id == image.item_id,
                MediaFile.kind == "image",
                MediaFile.id != image.id,
            )
            .first()
        )
        if others:
            continue  # A manually uploaded cover may be active.
        result = {"itemId": image.item_id, "coverId": image.id}
        try:
            if not is_black_cover(build_storage(image.storage).open(image.path)):
                continue
            result["status"] = "would-repair"
            if apply:
                video = (
                    db.query(MediaFile)
                    .filter(
                        MediaFile.item_id == image.item_id,
                        MediaFile.family_id == image.family_id,
                        MediaFile.kind == "video",
                    )
                    .first()
                )
                if not video:
                    raise ValueError("没有可用的视频文件")
                item = db.get(Item, image.item_id)
                with tempfile.TemporaryDirectory(prefix="molly-repair-") as temporary:
                    if video.storage == "local":
                        source = Path(video.path)
                        source = (
                            source.resolve() if source.is_absolute() else (root / source).resolve()
                        )
                        if not source.is_relative_to(root):
                            raise ValueError("视频路径不在媒体目录内")
                    elif video.storage == "oss":
                        if video.size_bytes > settings.media_processing_max_bytes:
                            raise ValueError("视频超出处理容量限制")
                        if shutil.disk_usage(temporary).free < video.size_bytes + 64 * 1024**2:
                            raise ValueError("临时磁盘空间不足")
                        source = Path(temporary) / "video.mp4"
                        build_storage("oss").download(video.path, source, video.size_bytes)
                    else:
                        raise ValueError("不支持的视频存储类型")
                    runtime = item.runtime_ticks
                    if not runtime:
                        from .media_worker import inspect_video

                        runtime = inspect_video(source)
                    data = extract_cover(source, runtime)
                if data is None:
                    image.kind = "retired_image"
                    item.primary_image_tag = ""
                    result["status"] = "use-placeholder"
                else:
                    version = str(uuid.uuid4())
                    destination = root / "managed" / image.family_id / f"{version}-cover.jpg"
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    atomic_write(destination, data)
                    # Original file remains available for recovery. A new hash invalidates resize caches.
                    image.path, image.storage = str(destination.relative_to(root)), "local"
                    image.size_bytes, image.sha256 = len(data), hashlib.sha256(data).hexdigest()
                    item.primary_image_tag = version
                    result["status"] = "repaired"
                db.commit()
        except Exception as error:  # noqa: BLE001 -- report each failure without hiding later candidates
            db.rollback()
            result["status"], result["error"] = "error", str(error)
        results.append(result)
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Back up SQLite and apply repairs")
    parser.add_argument("--item-id", help="Limit to one episode ID")
    args = parser.parse_args(argv)
    settings = get_settings()
    with (settings.data_dir / "media-worker.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "媒体处理任务正在运行，请停止后台服务后重试。\n")
        if args.apply:
            engine = get_engine()
            if engine.dialect.name != "sqlite":
                parser.exit(1, "此命令的自动备份仅支持 SQLite。\n")
            database = engine.url.database
            if not database or not Path(database).is_file():
                parser.exit(1, "找不到现有 SQLite 数据库，请检查数据目录配置。\n")
            stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S%fZ")
            backup = settings.data_dir / f"covers-backup-{stamp}.sqlite"
            with sqlite3.connect(database) as source, sqlite3.connect(backup) as target:
                source.backup(target)
            print(json.dumps({"backup": str(backup)}))
        with get_session_factory()() as db:
            results = repair(db, apply=args.apply, item_id=args.item_id)
        print(json.dumps({"apply": args.apply, "results": results}, ensure_ascii=False, indent=2))
        return 1 if any(r["status"] == "error" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
