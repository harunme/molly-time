# ruff: noqa: F811 -- pytest fixtures
import datetime as dt
import fcntl
import uuid
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_remote_storage import remote, start  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db, media_worker
from mollytime_server.management_models import MediaTask, UploadSession, UploadTarget
from mollytime_server.models import MediaFile
from mollytime_server.remote_uploads import expire_uploads
from mollytime_server.upload_metadata import metadata_path


def seed(remote, *, status="failed", expired=True, task_status="failed"):
    web, oss = remote
    key, obj = start(web)
    oss.objects[obj] = b"video"
    with Session(db.get_engine()) as session:
        session.get(UploadSession, key).status = status
        target = session.get(UploadTarget, key)
        target.expires_at = dt.datetime.now(dt.UTC) + dt.timedelta(hours=-1 if expired else 1)
        if task_status:
            session.add(MediaTask(upload_id=key, status=task_status))
        session.commit()
    path = metadata_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}")
    return key, obj


@pytest.mark.parametrize("status,expired,task_status,cleaned", [
    ("uploading", True, None, 1), ("failed", True, "failed", 1),
    ("uploading", False, None, 0), ("failed", False, "failed", 0),
    ("processing", True, "running", 0), ("ready", True, "done", 0),
    ("failed", True, "queued", 0), ("failed", True, "running", 0),
])
def test_only_expired_idle_unregistered_uploads_are_removed(remote, status, expired, task_status, cleaned):
    key, obj = seed(remote, status=status, expired=expired, task_status=task_status)
    web, oss = remote
    assert expire_uploads() == cleaned
    assert (obj not in oss.objects) is bool(cleaned)
    assert metadata_path(key).exists() is not bool(cleaned)
    result = web.get(f"/api/manage/uploads/{key}").json()
    assert result["status"] == ("cancelled" if cleaned else status)
    assert result["expiresAt"]
    assert expire_uploads() == 0  # Already cleaned uploads are idempotent.


@pytest.mark.parametrize("same_id", [True, False])
def test_registered_or_shared_objects_are_never_deleted(remote, same_id):
    key, obj = seed(remote)
    _, oss = remote
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id=key if same_id else "shared-copy", family_id="f2", item_id="e2",
                              kind="video", storage="oss", path=obj))
        session.commit()
    assert expire_uploads() == 0
    assert obj in oss.objects and metadata_path(key).exists()


def test_orphaned_cloud_cover_and_local_processing_files_are_removed(remote):
    key, obj = seed(remote)
    _, oss = remote
    cover_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "molly-cover:" + key))
    cover = f"families/f1/media/{cover_id}.jpg"
    oss.objects[cover] = b"cover"
    root = config.get_settings().resolved_media_dir()
    paths = [root / f"managed/f1/{key}{suffix}" for suffix in (".mp4", ".mp4.tmp", "-cover.jpg")]
    paths += [config.get_settings().data_dir / "uploads" / f"{key}.part"]
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"orphan")
    assert expire_uploads() == 1
    assert obj not in oss.objects and cover not in oss.objects
    assert all(not path.exists() for path in paths)


def test_referenced_cover_is_retained(remote):
    key, obj = seed(remote)
    _, oss = remote
    cover_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "molly-cover:" + key))
    cover = f"families/f1/media/{cover_id}.jpg"
    oss.objects[cover] = b"cover"
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id=cover_id, family_id="f1", item_id="e1", kind="image", storage="oss", path=cover))
        session.commit()
    assert expire_uploads() == 1
    assert obj not in oss.objects and cover in oss.objects


def test_live_share_snapshot_without_catalog_reference_is_retained(remote):
    from mollytime_server.share_models import ContentShare, ShareFile

    _, obj = seed(remote)
    _, oss = remote
    with Session(db.get_engine()) as session:
        session.add(ContentShare(id="share", family_id="f1", created_by="u1", code_hash="hash",
                                 expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=1), snapshot={}))
        session.add(ShareFile(share_id="share", source_media_id="original", source_item_id="e1",
                              storage="oss", path=obj, size_bytes=5, metadata_={}))
        session.commit()
    assert expire_uploads() == 0
    assert obj in oss.objects


def test_one_cloud_failure_does_not_block_others_and_partial_deletion_retries(remote, monkeypatch):
    first, obj = seed(remote)
    second, other_obj = seed(remote)
    web, oss = remote
    cover = f"families/f1/media/{uuid.uuid5(uuid.NAMESPACE_URL, 'molly-cover:' + first)}.jpg"
    oss.objects[cover] = b"cover"
    delete = oss.delete
    def fail_cover(key):
        if key == cover:
            raise OSError("temporary cloud error")
        delete(key)
    monkeypatch.setattr(oss, "delete", fail_cover)
    assert expire_uploads() == 1
    assert web.get(f"/api/manage/uploads/{second}").json()["status"] == "cancelled"
    result = web.get(f"/api/manage/uploads/{first}").json()
    assert result["status"] == "failed" and "清理失败" in result["error"]
    assert obj not in oss.objects and other_obj not in oss.objects and cover in oss.objects
    monkeypatch.setattr(oss, "delete", delete)
    assert expire_uploads() == 1
    assert cover not in oss.objects and not metadata_path(first).exists()


def test_cleanup_waits_for_processing_lock(remote):
    key, obj = seed(remote)
    _, oss = remote
    with (config.get_settings().data_dir / "media-worker.lock").open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert expire_uploads() == 0
        assert obj in oss.objects and metadata_path(key).exists()
    assert expire_uploads() == 1


def test_retry_protects_file_and_new_failure_starts_full_retention_window(remote, monkeypatch):
    key, obj = seed(remote)
    web, oss = remote
    with Session(db.get_engine()) as session:
        task_id = session.query(MediaTask).filter_by(upload_id=key).one().id
    assert web.post(f"/api/manage/tasks/{task_id}/retry").status_code == 200
    assert expire_uploads() == 0
    assert obj in oss.objects
    # A retry may fail immediately; it must still allow a fresh 72-hour window.
    monkeypatch.setattr(oss, "size", Mock(side_effect=OSError("network unavailable")))
    assert media_worker.run_once()
    with Session(db.get_engine()) as session:
        target = session.get(UploadTarget, key)
        assert target.expires_at.replace(tzinfo=dt.UTC) > dt.datetime.now(dt.UTC) + dt.timedelta(hours=71)
    assert expire_uploads() == 0


def test_expired_failed_legacy_local_upload_is_cleaned(parent):
    with Session(db.get_engine()) as session:
        session.add(UploadSession(id="legacy", family_id="f1", item_id="e1", filename="old.mp4",
                                  kind="video", size=10, fingerprint="old", status="failed",
                                  created_at=dt.datetime.now(dt.UTC) - dt.timedelta(days=4)))
        session.commit()
    part = config.get_settings().data_dir / "uploads/legacy.part"
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"old")
    assert expire_uploads() == 1
    assert not part.exists()


def test_cleaned_task_cannot_be_retried_and_quota_is_released(remote):
    from mollytime_server.usage import family_objects

    key, _ = seed(remote)
    web, _ = remote
    with Session(db.get_engine()) as session:
        task_id = session.query(MediaTask).filter_by(upload_id=key).one().id
        used = sum(obj["size"] for obj in family_objects(session, "f1").values())
    config.get_settings().family_storage_limit_bytes = used + 10
    assert expire_uploads() == 1
    assert web.post(f"/api/manage/tasks/{task_id}/retry").status_code == 409
    start(web)  # The expired failed upload no longer reserves this family's capacity.
