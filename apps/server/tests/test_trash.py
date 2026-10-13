# ruff: noqa: F811
import datetime as dt
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

from sqlalchemy import inspect
from sqlalchemy.orm import Session
from test_management import native_token, parent, watch  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.management_models import (
    Device, DeviceDownload, MediaOptions, MediaTask, ResourceState,
    TrashEntry, TrashSettings, UploadSession, UploadTarget, WatchSession,
)
from mollytime_server.models import MediaFile, User
from mollytime_server.storage.oss import OssStorage
from mollytime_server.trash import cleanup_expired


def archive(parent, key="series"):
    response = parent.post(f"/api/manage/resources/{key}/archive")
    assert response.status_code == 200, response.text


def test_archive_restore_nested_tree_and_exact_storage(parent):
    root = config.get_settings().resolved_media_dir()
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="alias", family_id="f1", item_id="e1", kind="retired_video",
                              storage="local", path=str(root / "video.mp4"), size_bytes=10))
        session.commit()
    archive(parent, "e1")
    archive(parent)
    data = parent.get("/api/manage/trash").json()
    assert data["retentionDays"] == 7
    assert data["entryCount"] == data["total"] == 1
    row = data["items"][0]
    assert row["id"] == "series" and row["videoCount"] == 1
    assert data["storage"]["usedBytes"] == 18
    assert data["storage"]["reclaimableBytes"] == 10  # Subtitle shared with another family.
    assert dt.datetime.fromisoformat(row["deleteAt"]) - dt.datetime.fromisoformat(row["archivedAt"]) == dt.timedelta(days=7)
    assert parent.get("/api/manage/resources?page=1").json()["total"] == 0
    assert parent.get("/api/manage/folders/series/videos?page=1").status_code == 409
    assert parent.get("/api/episodes/e1/play", headers=native_token()).status_code == 404
    assert parent.post("/api/manage/trash/e1/restore").status_code == 409
    assert parent.delete("/api/manage/trash/e1").status_code == 409
    assert parent.post("/api/manage/resources/series/publish").status_code == 409
    assert parent.post("/api/manage/trash/series/restore").status_code == 200
    assert parent.get("/api/manage/resources?page=1").json()["total"] == 1
    assert parent.get("/api/manage/trash").json()["items"][0]["id"] == "e1"
    assert parent.post("/api/manage/trash/e1/restore").status_code == 200
    assert parent.get("/api/episodes/e1/play", headers=native_token()).content == b"0123456789"


def test_purge_files_preserves_shared_objects_history_and_device_removal(parent):
    session_id = watch(parent)
    root = config.get_settings().resolved_media_dir()
    with Session(db.get_engine()) as session:
        session.add(Device(id="tv", family_id="f1", user_id="u1"))
        session.add(MediaOptions(media_id="v1", label="Video"))
        session.flush()
        session.add(DeviceDownload(id="download", family_id="f1", device_id="tv", media_id="v1", status="saved"))
        session.commit()
    assert parent.delete("/api/manage/trash/series").status_code == 404
    archive(parent)
    assert parent.delete("/api/manage/trash/series").status_code == 200
    assert not (root / "video.mp4").exists()
    assert (root / "subtitle.srt").read_text() == "subtitle"
    assert parent.get("/api/manage/trash").json()["storage"]["usedBytes"] == 0
    assert parent.get("/api/manage/resources/e1").status_code == 404
    assert parent.get("/api/episodes/e1/play").status_code == 404
    assert parent.post("/api/manage/trash/series/restore").status_code == 404
    with Session(db.get_engine()) as session:
        assert session.get(WatchSession, session_id).item_name == "One"
        assert session.get(MediaOptions, "v1") is None
        assert session.get(MediaFile, "s1") is None
        assert session.get(MediaFile, "s2") is not None
        assert session.get(MediaFile, "v1").kind == "deleted"
        assert session.get(DeviceDownload, "download").desired == "removed"
    assert parent.get("/api/manage/usage").json()["storage"]["usedBytes"] == 0
    assert parent.post("/api/manage/resources", json={"name": "Stories", "type": "Series"}).status_code == 200


def test_oss_delete_failure_is_visible_retryable_and_blocks_restore(parent, monkeypatch):
    with Session(db.get_engine()) as session:
        file = session.get(MediaFile, "v1")
        file.storage, file.path, file.size_bytes = "oss", "managed/f1/video.mp4", 1234
        session.add(MediaFile(id="retired", family_id="f1", item_id="e1", kind="retired_video",
                              storage="oss", path="managed/f1/old.mp4", size_bytes=100))
        session.commit()
    delete = Mock(side_effect=[None, RuntimeError("offline")])
    monkeypatch.setattr(OssStorage, "delete", delete)
    archive(parent)
    assert parent.get("/api/manage/trash").json()["storage"]["ossBytes"] == 1334
    assert parent.delete("/api/manage/trash/series").status_code == 503
    row = parent.get("/api/manage/trash").json()["items"][0]
    assert row["deleting"] and row["error"]
    assert row["storage"]["ossBytes"] == 100  # Successfully deleted files no longer count.
    assert parent.post("/api/manage/trash/series/restore").status_code == 409
    delete.side_effect = None
    assert parent.delete("/api/manage/trash/series").status_code == 200
    assert {call.args[0] for call in delete.call_args_list} == {"managed/f1/video.mp4", "managed/f1/old.mp4"}
    assert [call.args[0] for call in delete.call_args_list].count("managed/f1/video.mp4") == 1


def test_shared_oss_file_is_not_deleted(parent, monkeypatch):
    with Session(db.get_engine()) as session:
        for key in ("v1", "s2"):
            file = session.get(MediaFile, key)
            file.storage, file.path, file.size_bytes = "oss", "shared.mp4", 512
        session.commit()
    delete = Mock()
    monkeypatch.setattr(OssStorage, "delete", delete)
    archive(parent)
    assert parent.delete("/api/manage/trash/series").status_code == 200
    delete.assert_not_called()


def test_retention_boundaries_disable_change_and_repeat_archive(parent):
    archive(parent)
    row = parent.get("/api/manage/trash").json()["items"][0]
    archived_at = dt.datetime.fromisoformat(row["archivedAt"])
    archive(parent)
    assert parent.get("/api/manage/trash").json()["items"][0]["archivedAt"] == row["archivedAt"]
    assert cleanup_expired(archived_at + dt.timedelta(days=7, seconds=-1)) == 0
    assert parent.put("/api/manage/trash/settings", json={"retentionDays": 0}).status_code == 200
    assert cleanup_expired(archived_at + dt.timedelta(days=100)) == 0
    assert parent.get("/api/manage/trash").json()["items"][0]["deleteAt"] is None
    assert parent.put("/api/manage/trash/settings", json={"retentionDays": 30}).status_code == 200
    assert cleanup_expired(archived_at + dt.timedelta(days=7)) == 0
    assert parent.put("/api/manage/trash/settings", json={"retentionDays": 7}).status_code == 200
    assert cleanup_expired(archived_at + dt.timedelta(days=7)) == 1
    assert cleanup_expired(archived_at + dt.timedelta(days=7)) == 0


def test_legacy_archives_get_full_retention_without_reset_on_restart(parent):
    with Session(db.get_engine()) as session:
        session.add(ResourceState(item_id="series", status="archived", ready=True))
        session.commit()
    before = dt.datetime.now(dt.UTC)
    db.init_db()
    row = parent.get("/api/manage/trash").json()["items"][0]
    assert dt.datetime.fromisoformat(row["archivedAt"]) >= before
    db.init_db()
    assert parent.get("/api/manage/trash").json()["items"][0]["archivedAt"] == row["archivedAt"]
    assert parent.post("/api/manage/trash/series/restore").status_code == 200
    assert parent.get("/api/manage/resources/series").json()["status"] == "draft"


def legacy_trash_table(engine):
    # Reproduce the first recycle-bin schema, before deletion progress was added.
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE trash_entries")
        connection.exec_driver_sql("""
            CREATE TABLE trash_entries (
                item_id VARCHAR(36) PRIMARY KEY REFERENCES items(id),
                archived_at DATETIME NOT NULL,
                previous_status VARCHAR(16) NOT NULL,
                deleting BOOLEAN NOT NULL,
                error VARCHAR(256) NOT NULL
            )
        """)


def test_startup_upgrades_legacy_trash_before_backfill_and_preserves_records(parent):
    engine = db.get_engine()
    legacy_trash_table(engine)
    with Session(engine) as session:
        session.add_all([
            ResourceState(item_id="e1", status="archived", ready=True),
            ResourceState(item_id="series", status="archived", ready=True),
            TrashSettings(family_id="f1", retention_days=30),
        ])
        session.commit()
    with engine.begin() as connection:
        connection.exec_driver_sql("""
            INSERT INTO trash_entries VALUES
                ('e1', '2026-10-01 08:30:00', 'published', 1, 'retry pending')
        """)
        before = connection.exec_driver_sql("SELECT * FROM trash_entries").one()

    db.init_db()
    db.init_db()

    column = next(column for column in inspect(engine).get_columns("trash_entries")
                  if column["name"] == "deleted_objects")
    assert not column["nullable"]
    with engine.connect() as connection:
        assert connection.exec_driver_sql("""
            SELECT item_id, archived_at, previous_status, deleting, error
            FROM trash_entries WHERE item_id = 'e1'
        """).one() == before
    with Session(engine) as session:
        entry = session.get(TrashEntry, "e1")
        assert entry.deleted_objects == []
        assert session.get(TrashEntry, "series").deleted_objects == []
        assert session.get(TrashSettings, "f1").retention_days == 30
        assert session.query(MediaFile).count() == 3
        entry.deleted_objects = [["oss", "already-deleted.mp4"]]
        session.commit()
    db.init_db()
    with Session(engine) as session:
        assert session.get(TrashEntry, "e1").deleted_objects == [["oss", "already-deleted.mp4"]]
        assert session.query(TrashEntry).count() == 2
    assert parent.get("/api/manage/trash").status_code == 200


def test_concurrent_startup_upgrades_legacy_trash_only_once(parent):
    engine = db.get_engine()
    legacy_trash_table(engine)
    barrier = threading.Barrier(2)

    def initialize():
        barrier.wait(timeout=5)
        db.init_db()

    with ThreadPoolExecutor(max_workers=2) as executor:
        tasks = [executor.submit(initialize) for _ in range(2)]
        for task in tasks:
            task.result(timeout=10)
    assert [column["name"] for column in inspect(engine).get_columns("trash_entries")].count("deleted_objects") == 1


def test_trash_scope_permissions_and_policy_validation(parent):
    with Session(db.get_engine()) as session:
        session.add(ResourceState(item_id="e2", status="archived"))
        session.add(TrashEntry(item_id="e2"))
        session.commit()
    assert parent.get("/api/manage/trash").json()["total"] == 0
    assert parent.delete("/api/manage/trash/e2").status_code == 404
    assert parent.post("/api/manage/trash/e2/restore").status_code == 404
    for value in (-1, 366, 1.5, True, "7"):
        assert parent.put("/api/manage/trash/settings", json={"retentionDays": value}).status_code == 422
    archive(parent)
    assert parent.delete("/api/manage/trash/series", headers={"X-CSRF-Token": ""}).status_code == 403
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        session.commit()
    assert parent.get("/api/manage/trash").status_code == 200
    assert parent.delete("/api/manage/trash/series").status_code == 403
    assert parent.post("/api/manage/trash/series/restore").status_code == 403
    assert parent.put("/api/manage/trash/settings", json={"retentionDays": 1}).status_code == 403


def test_uploads_block_archive_and_trash_rejects_new_content(parent):
    with Session(db.get_engine()) as session:
        session.add(UploadSession(id="upload", family_id="f1", item_id="e1", filename="video.mp4",
                                  kind="video", size=10, fingerprint="upload"))
        session.commit()
    assert parent.post("/api/manage/resources/series/archive").status_code == 409
    with Session(db.get_engine()) as session:
        session.get(UploadSession, "upload").status = "cancelled"
        session.commit()
    archive(parent)
    assert parent.post("/api/manage/resources", json={"type": "Episode", "name": "New", "parentId": "series"}).status_code == 409
    assert parent.patch("/api/manage/resources/e1", json={"name": "Changed"}).status_code == 409
    assert parent.post("/api/manage/uploads", json={"itemId": "e1", "filename": "new.mp4", "size": 10, "kind": "video", "fingerprint": "new"}).status_code == 409


def test_failed_uploads_and_processing_leftovers_are_removed(parent, monkeypatch):
    settings = config.get_settings()
    (settings.data_dir / "uploads").mkdir()
    (settings.data_dir / "uploads/failed.part").write_bytes(b"temp")
    with Session(db.get_engine()) as session:
        session.add(UploadSession(id="failed", family_id="f1", item_id="e1", filename="failed.mp4",
                                  kind="video", size=512, fingerprint="failed", status="failed"))
        session.flush()
        session.add(UploadTarget(upload_id="failed", backend="oss", object_key="failed.mp4",
                                 expires_at=dt.datetime.now(dt.UTC)))
        session.add(MediaTask(id="task", upload_id="failed", status="failed"))
        session.commit()
    delete = Mock()
    monkeypatch.setattr(OssStorage, "delete", delete)
    archive(parent)
    assert parent.post("/api/manage/tasks/task/retry").status_code == 409
    assert parent.get("/api/manage/trash").json()["storage"]["usedBytes"] == 534
    assert parent.delete("/api/manage/trash/series").status_code == 200
    assert not (settings.data_dir / "uploads/failed.part").exists()
    delete.assert_called_once_with("failed.mp4")
    with Session(db.get_engine()) as session:
        assert session.get(UploadSession, "failed") is None
        assert session.get(MediaTask, "task") is None
        assert session.get(UploadTarget, "failed") is None


def test_search_pagination_and_totals_are_separate(parent):
    for index in range(3):
        response = parent.post("/api/manage/resources", json={"type": "Series", "name": f"Trash {index}"})
        archive(parent, response.json()["id"])
    data = parent.get("/api/manage/trash?page=2&pageSize=2").json()
    assert data["total"] == 3 and len(data["items"]) == 1
    filtered = parent.get("/api/manage/trash?q=Trash%202").json()
    assert filtered["total"] == 1 and filtered["entryCount"] == 3
    assert parent.get("/api/manage/trash?page=0").status_code == 422


def test_background_worker_cleans_expired_trash_without_starving_media(parent, monkeypatch):
    from mollytime_server import media_worker, remote_uploads, trash

    stop = threading.Event()
    cleanup = Mock(side_effect=RuntimeError("temporary storage failure"))
    process = Mock(side_effect=lambda: stop.set())
    monkeypatch.setattr(remote_uploads, "expire_uploads", Mock())
    monkeypatch.setattr(trash, "cleanup_expired", cleanup)
    monkeypatch.setattr(media_worker, "run_once", process)
    media_worker.loop(stop)
    cleanup.assert_called_once()
    process.assert_called_once()
