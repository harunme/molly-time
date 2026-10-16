# ruff: noqa: F811 -- shared isolated fixtures
import datetime as dt
import hashlib

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_operations import body, operator  # noqa: F401
from test_remote_storage import remote, start  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db, media_worker
from mollytime_server.api import operations
from mollytime_server.management_models import UploadTarget
from mollytime_server.models import Family, MediaFile
from mollytime_server.remote_uploads import expire_uploads
from mollytime_server.storage.local import LocalStorage
from mollytime_server.transactions import external_io
from mollytime_server.usage import storage_totals


@pytest.fixture
def no_transaction(client):
    engine = db.get_engine()
    active = set()

    def begin(connection):
        active.add(connection)

    def end(connection):
        active.discard(connection)

    def check():
        assert not active, "External I/O ran with a database transaction/connection held"

    event.listen(engine, "begin", begin)
    event.listen(engine, "commit", end)
    event.listen(engine, "rollback", end)
    try:
        yield check
    finally:
        event.remove(engine, "begin", begin)
        event.remove(engine, "commit", end)
        event.remove(engine, "rollback", end)


def guard_methods(monkeypatch, target, names, check):
    for name in names:
        original = getattr(target, name)

        def guarded(*args, _original=original, **kwargs):
            check()
            return _original(*args, **kwargs)

        monkeypatch.setattr(target, name, guarded)


def test_oss_upload_worker_cancel_and_expiry_release_transactions(remote, no_transaction, monkeypatch):
    client, oss = remote
    guard_methods(monkeypatch, oss, [
        "initiate", "parts", "complete", "size", "size_if_exists", "abort", "delete",
        "download", "put_file", "part_url", "signed_url", "open",
    ], no_transaction)
    key, obj = start(client)
    oss.uploaded[obj] = [{"number": 1, "size": 10, "etag": "tag"}]
    assert client.get(f"/api/manage/uploads/{key}/parts").status_code == 200
    assert client.post(f"/api/manage/uploads/{key}/part-url", json={
        "number": 1, "md5": "eHh4eHh4eHh4eHh4eHh4eA==",
    }).status_code == 200
    assert client.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1000}).status_code == 200
    assert media_worker.run_once()
    assert client.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"
    assert client.get("/api/episodes/e1/playback").status_code == 200
    assert client.get("/api/episodes/e1/play", follow_redirects=False).status_code == 302

    key, _ = start(client)
    assert client.post(f"/api/manage/uploads/{key}/cancel").status_code == 200
    key, _ = start(client)
    with Session(db.get_engine()) as session:
        session.get(UploadTarget, key).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        session.commit()
    assert expire_uploads() == 1


def test_local_upload_fsync_and_processing_release_transactions(parent, no_transaction, monkeypatch):
    import os

    original = os.fsync

    def fsync(fd):
        no_transaction()
        return original(fd)

    monkeypatch.setattr(os, "fsync", fsync)
    payload = b"1\n00:00:00,000 --> 00:00:01,000\nHello\n"
    key = parent.post("/api/manage/uploads", json={
        "itemId": "e1", "filename": "hello.srt", "kind": "subtitle",
        "fingerprint": "local", "size": len(payload),
    }).json()["id"]
    path = f"/api/manage/uploads/{key}"
    for _ in range(2):  # An acknowledged duplicate must remain idempotent.
        assert parent.put(path + "/chunks?offset=0", content=payload, headers={
            "X-Chunk-SHA256": hashlib.sha256(payload).hexdigest(),
        }).status_code == 200
    assert parent.post(path + "/complete").status_code == 200
    original_copy = media_worker.shutil.copyfile

    def copy(*args, **kwargs):
        no_transaction()
        return original_copy(*args, **kwargs)

    monkeypatch.setattr(media_worker.shutil, "copyfile", copy)
    assert media_worker.run_once()
    assert parent.get(path).json()["status"] == "ready"


def test_storage_statistics_batch_families_and_deduplicate_disk_checks(parent, no_transaction, monkeypatch):
    checks = []
    original_size = LocalStorage.size

    def size(storage, path):
        no_transaction()
        checks.append(path)
        return original_size(storage, path)

    monkeypatch.setattr(LocalStorage, "size", size)
    with Session(db.get_engine()) as session:
        session.add_all([Family(id=f"usage-{i}", name=f"Family {i}") for i in range(20)])
        session.add(MediaFile(id="usage-alias", family_id="f1", item_id="e1", kind="retired_video",
                              storage="local", path="video.mp4", size_bytes=10))
        session.commit()
    selects = []

    def capture(connection, cursor, statement, parameters, context, many):
        if statement.lstrip().upper().startswith("SELECT"):
            selects.append(statement)

    event.listen(db.get_engine(), "before_cursor_execute", capture)
    try:
        with Session(db.get_engine()) as session:
            baseline = storage_totals(session, ["f1"])
            count = len(selects)
            selects.clear()
            checks.clear()
            totals = storage_totals(session, ["f1", "f2"] + [f"usage-{i}" for i in range(20)])
        assert len(selects) == count == 3
        assert totals["f1"] == baseline["f1"]
        assert checks.count("video.mp4") == checks.count("subtitle.srt") == 1
    finally:
        event.remove(db.get_engine(), "before_cursor_execute", capture)


def test_operations_connection_check_and_key_io_release_transactions(operator, no_transaction, monkeypatch):
    monkeypatch.setattr(operations, "test_connection", lambda values: no_transaction())
    assert operator.post("/api/manage/operations/storage/test", json=body()).status_code == 200
    assert operator.put("/api/manage/operations/storage", json=body()).status_code == 200


def test_external_io_never_commits_or_discards_pending_writes(client):
    with Session(db.get_engine()) as session:
        family = session.get(Family, "f1")
        family.name = "Pending"
        with pytest.raises(RuntimeError, match="pending database changes"), external_io(session):
            pytest.fail("I/O must not run")
        assert family in session.dirty
        session.rollback()
        family = session.get(Family, "f1")
        with external_io(session, family):
            assert not session.in_transaction()
            assert family.name == "One"
        family.name = "After I/O"
        session.commit()
    with Session(db.get_engine()) as session:
        assert session.get(Family, "f1").name == "After I/O"


def test_static_catalog_images_keep_the_repeatable_read_snapshot(parent, monkeypatch):
    from mollytime_server import images
    from mollytime_server.api.tv_sync import begin_snapshot
    from mollytime_server.models import Item

    with Session(db.get_engine()) as session:
        session.get(MediaFile, "v1").kind = "image"
        session.get(MediaFile, "v1").storage = "oss"
        session.commit()

    def forbidden(*args):
        pytest.fail("Static catalogs must not read signing configuration or end their snapshot")

    monkeypatch.setattr(images, "build_storage", forbidden)
    monkeypatch.setattr(images, "external_io", forbidden)
    with Session(db.get_engine()) as session:
        begin_snapshot(session)
        transaction = session.get_transaction()
        ref = images.image_ref(session, session.get(Item, "e1"))
        assert ref["url"].startswith("/api/items/e1/image")
        assert "directUrl" not in ref
        assert session.get_transaction() is transaction and transaction.is_active


def test_share_snapshot_and_retryable_deletion_release_transactions(parent, no_transaction, monkeypatch):
    from mollytime_server.share_models import ContentShare
    from mollytime_server.shares import cleanup_shares

    guard_methods(monkeypatch, LocalStorage, ["size", "delete"], no_transaction)
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="unshared-retired", family_id="f1", item_id="e1",
                              kind="retired_video", storage="local", path="unshared-old.mp4"))
        session.commit()
    response = parent.post("/api/manage/shares", json={"resourceId": "series"})
    assert response.status_code == 200
    assert parent.post("/api/manage/resources/series/archive").status_code == 200
    assert parent.delete("/api/manage/trash/series").status_code == 200
    with Session(db.get_engine()) as session:
        for share in session.query(ContentShare).all():
            share.expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        session.commit()
    assert cleanup_shares() > 0


def test_trash_statistics_queries_do_not_grow_with_page_size(parent):
    from mollytime_server.management_models import ResourceState, TrashEntry
    from mollytime_server.models import Item

    with Session(db.get_engine()) as session:
        session.add_all([
            Item(id=f"trash-stat-{i}", family_id="f1", type="Series", name=f"Archived {i}")
            for i in range(20)
        ])
        session.flush()
        session.add_all([ResourceState(item_id=f"trash-stat-{i}", status="archived") for i in range(20)])
        session.add_all([TrashEntry(item_id=f"trash-stat-{i}") for i in range(20)])
        session.commit()
    statements = []

    def capture(connection, cursor, statement, parameters, context, many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    engine = db.get_engine()
    event.listen(engine, "before_cursor_execute", capture)
    try:
        first = parent.get("/api/manage/trash?pageSize=1").json()
        baseline = len(statements)
        statements.clear()
        page = parent.get("/api/manage/trash?pageSize=20").json()
        assert len(statements) == baseline
        assert first["storage"] == page["storage"]
        assert len(page["items"]) == page["entryCount"] == 20
    finally:
        event.remove(engine, "before_cursor_execute", capture)
