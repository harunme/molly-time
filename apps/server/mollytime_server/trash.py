"""Family recycle bin, exact object accounting and retryable physical deletion."""

import datetime as dt
import fcntl
import logging
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from .config import get_settings
from .db import get_session_factory
from .manage_auth import aware
from .management_models import (
    DeviceDownload,
    DeviceReminder,
    FamilyReminders,
    MediaOptions,
    MediaTask,
    ResourceState,
    TrashEntry,
    TrashSettings,
    UploadSession,
    UploadTarget,
)
from .models import Item, MediaFile
from .storage import build_storage
from .storage.local import LocalStorage
from .transactions import external_io, serialize_sqlite_write

logger = logging.getLogger(__name__)
DEFAULT_RETENTION_DAYS = 7


def backfill_trash(db):
    # Old archives have no timestamp. Give them a full retention period from migration.
    serialize_sqlite_write(db)
    rows = db.query(ResourceState).outerjoin(TrashEntry, TrashEntry.item_id == ResourceState.item_id).filter(
        ResourceState.status == "archived", TrashEntry.item_id.is_(None),
    ).all()
    for state in rows:
        db.add(TrashEntry(item_id=state.item_id, previous_status="draft"))
    db.commit()


def retention_days(db, family_id):
    settings = db.get(TrashSettings, family_id)
    return settings.retention_days if settings else DEFAULT_RETENTION_DAYS


def family_tree(db, family_id):
    return {item.id: item for item in db.query(Item).filter(
        Item.family_id == family_id, Item.type != "Deleted",
    ).all()}


def subtree(items, item_id):
    children = {}
    for item in items.values():
        children.setdefault(item.parent_id, []).append(item.id)
    found, queue = set(), [item_id]
    while queue:
        key = queue.pop()
        if key not in found:
            found.add(key)
            queue.extend(children.get(key, []))
    return found


def archived_ancestor(db, item):
    current, seen = item, set()
    while current and current.id not in seen:
        seen.add(current.id)
        state = db.get(ResourceState, current.id)
        if state and state.status in ("archived", "deleted"):
            return current.id
        current = db.get(Item, current.parent_id) if current.parent_id else None
    return None


def ensure_active(db, item):
    if archived_ancestor(db, item):
        raise HTTPException(409, "内容已在回收站，请先恢复后再操作")


def ensure_idle(db, keys):
    if db.query(UploadSession.id).filter(
        UploadSession.item_id.in_(keys), UploadSession.status.in_(["uploading", "processing"]),
    ).first() or db.query(MediaTask.id).join(UploadSession).filter(
        UploadSession.item_id.in_(keys), MediaTask.status.in_(["queued", "running"]),
    ).first():
        raise HTTPException(409, "内容仍有上传或处理任务，请完成或取消后再移入回收站")


def archive(db, item):
    state = db.get(ResourceState, item.id)
    if state and state.status == "archived":
        return  # Repeated archive requests must not restart the retention clock.
    ensure_active(db, item)
    ensure_idle(db, subtree(family_tree(db, item.family_id), item.id))
    if state is None:
        state = ResourceState(item_id=item.id, status="published", ready=True)
        db.add(state)
    db.add(TrashEntry(item_id=item.id, previous_status=state.status))
    state.status = "archived"


def root_entries(db, items):
    entries = {row.item_id: row for row in db.query(TrashEntry).filter(
        TrashEntry.item_id.in_(items),
    ).all()}
    roots = []
    for key, row in entries.items():
        parent, seen = items[key].parent_id, {key}
        while parent in items and parent not in seen and parent not in entries:
            seen.add(parent)
            parent = items[parent].parent_id
        if parent not in entries and parent not in seen:
            roots.append(row)
    return roots


def owned_entry(db, item_id, family_id):
    item = db.get(Item, item_id)
    entry = db.get(TrashEntry, item_id)
    if item is None or item.family_id != family_id or entry is None:
        raise HTTPException(404, "回收站内容不存在")
    parent = db.get(Item, item.parent_id) if item.parent_id else None
    if parent and archived_ancestor(db, parent):
        raise HTTPException(409, "请先处理回收站中的上级文件夹")
    return item, entry


def restore(db, item_id, family_id):
    serialize_sqlite_write(db)
    _item, entry = owned_entry(db, item_id, family_id)
    if entry.deleting:
        raise HTTPException(409, "内容已开始彻底删除，无法恢复；删除失败时请重试")
    state = db.get(ResourceState, item_id)
    state.status = entry.previous_status
    db.delete(entry)
    db.commit()
    return {"ok": True}


def object_identity(backend, key):
    if backend in ("local", "temporary"):
        # Local identities do not depend on OSS configuration. Avoid reading and
        # decrypting the operations settings once per media object.
        store = LocalStorage(get_settings().resolved_media_dir() if backend == "local"
                             else get_settings().data_dir / "uploads")
        return "disk", str(store._abspath(key))
    return backend, key


def object_snapshot(db, keys):
    return (
        db.query(MediaFile).filter(
            MediaFile.item_id.in_(keys), MediaFile.kind != "deleted",
        ).all(),
        db.query(UploadSession, UploadTarget).outerjoin(UploadTarget).filter(
            UploadSession.item_id.in_(keys),
        ).all(),
        db.query(TrashEntry).filter(TrashEntry.item_id.in_(keys)).all(),
    )


def objects_for(db, keys, snapshot=None):
    """All versions, failed completed uploads and local processing leftovers, deduplicated."""
    objects = {}

    def add(backend, key, size):
        identity = object_identity(backend, key)
        unknown = backend not in ("local", "temporary", "oss") or size <= 0
        if backend in ("local", "temporary"):
            try:
                size = Path(identity[1]).stat().st_size
                unknown = False
            except FileNotFoundError:
                size, unknown = 0, False
            except OSError:
                unknown = True
        previous = objects.get(identity)
        if previous is None or size > previous["size"]:
            objects[identity] = {"backend": backend, "key": key, "size": max(0, size), "unknown": unknown}

    files, uploads, entries = snapshot if snapshot is not None else object_snapshot(db, keys)
    with external_io(db):
        for file in files:
            if file.item_id in keys:
                add(file.storage, file.path, file.size_bytes)
        for upload, target in uploads:
            if upload.item_id not in keys:
                continue
            if target and target.backend == "oss" and target.object_key and upload.status != "cancelled":
                add("oss", target.object_key, upload.size)
            add("temporary", f"{upload.id}.part", 0)
            add("temporary", f"{upload.id}.video.json", 0)
            base = f"managed/{upload.family_id}/{upload.id}"
            for key in (base + Path(upload.filename).suffix.lower(), base + "-cover.jpg",
                        base + Path(upload.filename).suffix.lower() + ".tmp"):
                add("local", key, 0)
        for entry in entries:
            if entry.item_id in keys:
                for identity in entry.deleted_objects:
                    objects.pop(tuple(identity), None)
    return objects


def reference_snapshot(db):
    from .shares import retained_files

    files = db.query(MediaFile.item_id, MediaFile.storage, MediaFile.path).filter(
        MediaFile.kind != "deleted",
    ).all()
    targets = db.query(UploadSession.item_id, UploadTarget.backend, UploadTarget.object_key).join(
        UploadTarget, UploadTarget.upload_id == UploadSession.id,
    ).all()
    shares = retained_files(db).all()
    with external_io(db):
        refs = {}
        for item, backend, path in [*files, *targets]:
            if path:
                refs.setdefault(object_identity(backend, path), set()).add(item)
        for file in shares:
            # A live snapshot protects the object independently of any catalog tree.
            refs.setdefault(object_identity(file.storage, file.path), set()).add(None)
    return refs


def outside_references(db, keys, snapshot=None):
    refs = snapshot if snapshot is not None else reference_snapshot(db)
    return {identity for identity, owners in refs.items() if owners - keys}


def object_totals(objects, shared):
    return {
        "usedBytes": sum(row["size"] for row in objects.values()),
        "reclaimableBytes": sum(row["size"] for key, row in objects.items() if key not in shared),
        "ossBytes": sum(row["size"] for row in objects.values() if row["backend"] == "oss"),
        "localBytes": sum(row["size"] for row in objects.values() if row["backend"] in ("local", "temporary")),
        "unknownSizeCount": sum(row["unknown"] for row in objects.values()),
    }


def trash_snapshot(db, family_id, q="", page=1, page_size=20):
    items = family_tree(db, family_id)
    roots = sorted(root_entries(db, items), key=lambda row: (aware(row.archived_at), row.item_id), reverse=True)
    keys = set().union(*(subtree(items, row.item_id) for row in roots)) if roots else set()
    days = retention_days(db, family_id)
    snapshot = object_snapshot(db, keys)
    references = reference_snapshot(db)
    all_objects = objects_for(db, keys, snapshot)
    storage = object_totals(all_objects, outside_references(db, keys, references))
    matching = [row for row in roots if q.strip().casefold() in items[row.item_id].name.casefold()]
    rows = []
    for entry in matching[(page - 1) * page_size:page * page_size]:
        item = items[entry.item_id]
        child_keys = subtree(items, item.id)
        objects = objects_for(db, child_keys, snapshot)
        rows.append({
            "id": item.id, "name": item.name, "type": item.type,
            "archivedAt": aware(entry.archived_at).isoformat(),
            "deleteAt": (aware(entry.archived_at) + dt.timedelta(days=days)).isoformat() if days else None,
            "deleting": entry.deleting, "error": entry.error,
            "videoCount": sum(items[key].type == "Episode" for key in child_keys),
            "storage": object_totals(objects, outside_references(db, child_keys, references)),
        })
    return {"items": rows, "total": len(matching), "page": page, "pageSize": page_size,
            "storage": storage, "entryCount": len(roots), "retentionDays": days}


@contextmanager
def deletion_lock():
    # Coordinate embedded/standalone workers and manual deletion in other API processes.
    folder = get_settings().data_dir
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "trash-delete.lock").open("a+b") as trash_lock, (folder / "media-worker.lock").open("a+b") as media_lock:
        try:
            fcntl.flock(trash_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(media_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise HTTPException(409, "后台正在处理文件，请稍后重试删除") from exc
        yield


def purge(item_id, family_id, *, expired_at=None):
    with deletion_lock(), get_session_factory()() as db:
        serialize_sqlite_write(db)
        item, entry = owned_entry(db, item_id, family_id)
        if expired_at is not None:
            days = retention_days(db, family_id)
            if not days or aware(entry.archived_at) + dt.timedelta(days=days) > expired_at:
                return False
        keys = subtree(family_tree(db, family_id), item.id)
        ensure_idle(db, keys)
        objects = objects_for(db, keys)
        shared = outside_references(db, keys)
        db.add(entry)
        entry.deleting, entry.error = True, ""
        db.commit()  # Durable before the first deletion; partially deleted trees cannot be restored.
        try:
            for identity, obj in objects.items():
                if identity in shared:
                    continue
                with external_io(db, entry):
                    store = (LocalStorage(get_settings().data_dir / "uploads")
                             if obj["backend"] == "temporary" else build_storage(obj["backend"]))
                    store.delete(obj["key"])
                entry.deleted_objects = [*entry.deleted_objects, list(identity)]
                db.commit()  # Track partial progress for accurate totals and idempotent retries.
            serialize_sqlite_write(db)
            # Keep only catalog identity for watch-history FKs; files and upload data are removed.
            # Download tombstones let offline TVs receive removal commands when they reconnect.
            files = db.query(MediaFile).filter(MediaFile.item_id.in_(keys)).all()
            file_ids = [file.id for file in files]
            db.query(MediaOptions).filter(MediaOptions.media_id.in_(file_ids)).delete(synchronize_session=False)
            downloads = db.query(DeviceDownload).filter(DeviceDownload.media_id.in_(file_ids)).all()
            retained_files = {row.media_id for row in downloads}
            for row in downloads:
                row.desired, row.status, row.error = "removed", "queued", ""
            for file in files:
                if file.id in retained_files:
                    file.kind, file.path = "deleted", ""
                else:
                    db.delete(file)
            upload_ids = [key for (key,) in db.query(UploadSession.id).filter(UploadSession.item_id.in_(keys))]
            db.query(MediaTask).filter(MediaTask.upload_id.in_(upload_ids)).delete(synchronize_session=False)
            db.query(UploadTarget).filter(UploadTarget.upload_id.in_(upload_ids)).delete(synchronize_session=False)
            db.query(UploadSession).filter(UploadSession.id.in_(upload_ids)).delete(synchronize_session=False)
            for reminders in db.query(FamilyReminders).filter(FamilyReminders.family_id == family_id):
                for field in ("folder_id", "warning_id", "farewell_id"):
                    if getattr(reminders, field) in keys:
                        setattr(reminders, field, None)
                        reminders.enabled = False
            db.query(DeviceReminder).filter(DeviceReminder.episode_id.in_(keys)).delete(synchronize_session=False)
            db.query(TrashEntry).filter(TrashEntry.item_id.in_(keys)).delete(synchronize_session=False)
            for resource in db.query(Item).filter(Item.id.in_(keys)):
                resource.type, resource.parent_id, resource.view_id = "Deleted", None, None
                resource.overview, resource.primary_image_tag, resource.image_count = "", "", 0
                state = db.get(ResourceState, resource.id)
                if state is None:
                    db.add(ResourceState(item_id=resource.id, status="deleted", ready=False))
                else:
                    state.status, state.ready = "deleted", False
            db.commit()
        except Exception as exc:
            db.rollback()
            entry = db.get(TrashEntry, item_id)
            if entry:
                entry.error = "删除未完成，请重试；若持续失败，请检查存储连接和删除权限。"
                db.commit()
            logger.exception("Trash deletion failed for %s", item_id)
            raise HTTPException(503, "删除未完成，记录已保留在回收站，可重试删除") from exc
    return True


def cleanup_expired(now=None):
    now = now or dt.datetime.now(dt.UTC)
    with get_session_factory()() as db:
        families = [key for (key,) in db.query(Item.family_id).join(TrashEntry).distinct() if key]
        candidates = []
        for family in families:
            days = retention_days(db, family)
            if days:
                for entry in root_entries(db, family_tree(db, family)):
                    if aware(entry.archived_at) + dt.timedelta(days=days) <= now:
                        candidates.append((entry.item_id, family))
    deleted = 0
    for item_id, family in candidates:
        try:
            deleted += bool(purge(item_id, family, expired_at=now))
        except HTTPException:
            logger.warning("Trash cleanup deferred for %s", item_id)
    return deleted
