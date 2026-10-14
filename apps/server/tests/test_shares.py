# ruff: noqa: F811
import datetime as dt
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.auth import hash_password, issue_access_token
from mollytime_server.main import create_app
from mollytime_server.management_models import MediaOptions, ResourceState
from mollytime_server.models import Family, Item, MediaFile, User
from mollytime_server.share_models import ContentShare, ObjectCleanup, ShareClaim, ShareFile
from mollytime_server.shares import cleanup_shares
from mollytime_server.storage.oss import OssStorage
from mollytime_server.usage import storage_totals


@pytest.fixture
def recipient(parent):
    with Session(db.get_engine()) as session:
        session.add(
            User(
                id="u2",
                family_id="f2",
                name="receiver",
                password_hash=hash_password("receiver-password"),
            )
        )
        session.add(Item(id="receiver-folder", family_id="f2", type="Series", name="My collection"))
        session.get(MediaFile, "v1").size_bytes = 10
        session.get(MediaFile, "s1").size_bytes = 8
        session.add(MediaOptions(media_id="s1", label="English", offset_ms=750))
        session.commit()
    with TestClient(create_app()) as receiver:
        result = receiver.post(
            "/api/manage/auth/login", json={"username": "receiver", "password": "receiver-password"}
        )
        assert result.status_code == 200
        receiver.headers["X-CSRF-Token"] = result.json()["csrfToken"]
        yield receiver


def create(parent, resource="series"):
    result = parent.post("/api/manage/shares", json={"resourceId": resource})
    assert result.status_code == 200, result.text
    assert len(result.json()["code"]) == 12
    assert result.json()["url"].endswith("/manage/#/share/" + result.json()["code"])
    assert "token" not in result.json()
    return result.json()


def accept(recipient, share, **extra):
    result = recipient.post("/api/manage/shares/accept", json={"code": share["code"], **extra})
    assert result.status_code == 200, result.text
    return result.json()["resourceId"]


def archive_purge(parent, key):
    assert parent.post(f"/api/manage/resources/{key}/archive").status_code == 200
    result = parent.delete(f"/api/manage/trash/{key}")
    assert result.status_code == 200, result.text


def expire(share):
    with Session(db.get_engine()) as session:
        session.get(ContentShare, share["id"]).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(
            seconds=1
        )
        session.commit()


def test_snapshot_claim_preserves_structure_metadata_and_family_isolation(parent, recipient):
    share = create(parent)
    assert share["videoCount"] == 1 and share["sizeBytes"] == 18
    preview = recipient.post("/api/manage/shares/preview", json={"code": share["code"]})
    assert preview.status_code == 200
    assert "path" not in preview.text and "video.mp4" not in preview.text
    root = accept(recipient, share)
    assert recipient.get(f"/api/manage/resources/{root}").json()["status"] == "draft"
    with Session(db.get_engine()) as session:
        season = session.query(Item).filter_by(parent_id=root, type="Season").one()
        ep = session.query(Item).filter_by(parent_id=season.id, type="Episode").one()
        files = session.query(MediaFile).filter_by(item_id=ep.id).all()
        assert {file.path for file in files} == {"video.mp4", "subtitle.srt"}
        assert all(file.family_id == "f2" and file.id not in ("v1", "s1") for file in files)
        assert (
            session.get(MediaOptions, next(f.id for f in files if f.kind == "subtitle")).offset_ms
            == 750
        )
        ep_id = ep.id
    token, _ = issue_access_token(user_id="u2", family_id="f2", role="admin")
    assert (
        recipient.get(
            f"/api/episodes/{ep_id}/play", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 404
    )
    assert parent.get(f"/api/manage/resources/{root}").status_code == 404
    assert recipient.get("/api/manage/resources/e1").status_code == 404
    for key in (root, ep_id):
        assert recipient.post(f"/api/manage/resources/{key}/publish").status_code == 200
    assert (
        recipient.get(
            f"/api/episodes/{ep_id}/play", headers={"Authorization": f"Bearer {token}"}
        ).content
        == b"0123456789"
    )
    assert recipient.post("/api/manage/shares", json={"resourceId": root}).status_code == 409
    assert recipient.get(f"/api/manage/resources/{root}").json()["shared"] is True


def test_source_delete_before_claim_and_expiry_keep_received_file(parent, recipient):
    share = create(parent)
    archive_purge(parent, "series")
    root_path = config.get_settings().resolved_media_dir() / "video.mp4"
    assert root_path.exists()
    with Session(db.get_engine()) as session:
        assert storage_totals(session, ["f1"])["f1"]["usedBytes"] == 18
    claimed = accept(recipient, share)
    expire(share)
    cleanup_shares()
    assert root_path.exists()
    assert (
        recipient.post("/api/manage/shares/preview", json={"code": share["code"]}).json()[
            "claimedResourceId"
        ]
        == claimed
    )
    assert accept(recipient, share) == claimed
    archive_purge(recipient, claimed)
    assert not root_path.exists()
    assert (
        config.get_settings().resolved_media_dir() / "subtitle.srt"
    ).exists()  # Other household's original reference.


def test_expiry_cleans_unclaimed_orphans_and_retries_oss(parent, recipient, monkeypatch):
    with Session(db.get_engine()) as session:
        file = session.get(MediaFile, "v1")
        file.storage, file.path, file.size_bytes = "oss", "families/f1/media/original.mp4", 10
        session.commit()
    delete = Mock()
    monkeypatch.setattr(OssStorage, "delete", delete)
    monkeypatch.setattr(OssStorage, "size", Mock(return_value=10))
    share = create(parent)
    archive_purge(parent, "series")
    delete.assert_not_called()
    expire(share)
    assert (
        recipient.post("/api/manage/shares/accept", json={"code": share["code"]}).status_code == 410
    )
    delete.side_effect = RuntimeError("offline")
    cleanup_shares()
    with Session(db.get_engine()) as session:
        assert session.query(ShareFile).count() == 0
        assert session.query(ObjectCleanup).filter(ObjectCleanup.error != "").count() == 1
    delete.side_effect = None
    cleanup_shares()
    assert [call.args[0] for call in delete.call_args_list] == [
        "families/f1/media/original.mp4"
    ] * 2


def test_single_video_target_duplicate_deleted_claim_and_quota(parent, recipient):
    share = create(parent, "e1")
    assert (
        recipient.post("/api/manage/shares/accept", json={"code": share["code"]}).status_code == 422
    )
    assert (
        recipient.post(
            "/api/manage/shares/accept", json={"code": share["code"], "targetFolderId": "series"}
        ).status_code
        == 404
    )
    # f2 already references the subtitle: only the 10-byte video is new.
    config.get_settings().family_storage_limit_bytes = 17
    assert (
        recipient.post(
            "/api/manage/shares/accept",
            json={"code": share["code"], "targetFolderId": "receiver-folder"},
        ).status_code
        == 507
    )
    with Session(db.get_engine()) as session:
        assert session.query(ShareClaim).count() == 0
        assert session.query(Item).filter_by(family_id="f2").count() == 2
    config.get_settings().family_storage_limit_bytes = 18
    episode = accept(recipient, share, targetFolderId="receiver-folder")
    assert accept(recipient, share) == episode
    second = create(parent, "e1")
    episode2 = accept(recipient, second, targetFolderId="receiver-folder")
    assert recipient.get(f"/api/manage/resources/{episode2}").json()["name"] == "One（分享）"
    with Session(db.get_engine()) as session:
        assert storage_totals(session, ["f2"])["f2"]["usedBytes"] == 18
    archive_purge(recipient, episode)
    assert (
        recipient.post("/api/manage/shares/accept", json={"code": share["code"]}).json()["deleted"]
        is True
    )


def test_permissions_expiry_drafts_reminders_and_no_file_copy(parent, recipient, monkeypatch):
    from mollytime_server.management_models import FamilyReminders

    put = Mock(side_effect=AssertionError("share must not upload"))
    download = Mock(side_effect=AssertionError("share must not download"))
    monkeypatch.setattr(OssStorage, "put_file", put)
    monkeypatch.setattr(OssStorage, "download", download)
    with Session(db.get_engine()) as session:
        session.get(MediaFile, "v1").storage = "oss"
        session.commit()
    share = create(parent)
    accept(recipient, share)
    put.assert_not_called()
    download.assert_not_called()
    assert parent.post("/api/manage/shares/accept", json={"code": share["code"]}).status_code == 409
    assert recipient.post("/api/manage/shares/preview", json={"code": "A" * 12}).status_code == 404
    assert (
        recipient.post(
            "/api/manage/shares/preview", json={"code": share["code"]}, headers={"X-CSRF-Token": ""}
        ).status_code
        == 403
    )
    with Session(db.get_engine()) as session:
        session.get(User, "u2").role = "member"
        session.add(ResourceState(item_id="e1", status="draft", ready=True))
        session.commit()
    assert (
        recipient.post("/api/manage/shares/preview", json={"code": share["code"]}).status_code
        == 403
    )
    assert parent.post("/api/manage/shares", json={"resourceId": "series"}).status_code == 409
    with Session(db.get_engine()) as session:
        session.get(ResourceState, "e1").status = "published"
        session.add(FamilyReminders(family_id="f1", folder_id="series", warning_id="e1"))
        session.commit()
    assert parent.post("/api/manage/shares", json={"resourceId": "e1"}).status_code == 422


def test_snapshot_does_not_follow_edits_and_multiple_households_can_claim(parent, recipient):
    share = create(parent)
    assert parent.patch("/api/manage/resources/e1", json={"name": "Edited"}).status_code == 200
    root = accept(recipient, share)
    with Session(db.get_engine()) as session:
        session.add(Family(id="f3", name="Third"))
        session.flush()
        session.add(
            User(
                id="u3", family_id="f3", name="third", password_hash=hash_password("third-password")
            )
        )
        season = session.query(Item).filter_by(parent_id=root).one()
        assert session.query(Item).filter_by(parent_id=season.id).one().name == "One"
        session.commit()
    with TestClient(create_app()) as third:
        login = third.post(
            "/api/manage/auth/login", json={"username": "third", "password": "third-password"}
        )
        third.headers["X-CSRF-Token"] = login.json()["csrfToken"]
        root3 = accept(third, share)
        assert root3 != root
    with Session(db.get_engine()) as session:
        assert session.query(ShareClaim).count() == 2
        assert len({file.path for file in session.query(MediaFile).filter_by(kind="video")}) == 1


def test_concurrent_claim_and_deletion_never_copy_or_lose_file(parent, recipient):
    share = create(parent)
    barrier = threading.Barrier(2)

    def claim():
        barrier.wait(timeout=5)
        return recipient.post("/api/manage/shares/accept", json={"code": share["code"]})

    def remove():
        barrier.wait(timeout=5)
        return parent.delete("/api/manage/trash/series")

    assert parent.post("/api/manage/resources/series/archive").status_code == 200
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [
            future.result(timeout=15) for future in [pool.submit(claim), pool.submit(remove)]
        ]
    assert all(result.status_code in (200, 409) for result in results)
    # A lock conflict is retryable; success must preserve the same snapshot bytes.
    if results[1].status_code == 409:
        assert parent.delete("/api/manage/trash/series").status_code == 200
    root = accept(recipient, share)
    assert (config.get_settings().resolved_media_dir() / "video.mp4").exists()
    with Session(db.get_engine()) as session:
        assert session.query(ShareClaim).count() == 1
        assert session.get(Item, root).family_id == "f2"


def test_inherited_cover_is_frozen_and_remapped(parent, recipient):
    root = config.get_settings().resolved_media_dir()
    (root / "cover.jpg").write_bytes(b"cover")
    with Session(db.get_engine()) as session:
        session.add(
            MediaFile(
                id="folder-cover",
                family_id="f1",
                item_id="series",
                kind="image",
                storage="local",
                path="cover.jpg",
                size_bytes=5,
            )
        )
        session.get(Item, "series").primary_image_tag = "folder-cover"
        session.commit()
    prepared = parent.post("/api/manage/shares/prepare", json={"resourceId": "e1"})
    assert prepared.json()["sizeBytes"] == 23
    with Session(db.get_engine()) as session:
        assert session.query(ContentShare).count() == 0  # Preparing does not retain anything.
    share = create(parent, "e1")
    episode = accept(recipient, share, targetFolderId="receiver-folder")
    with Session(db.get_engine()) as session:
        image = session.query(MediaFile).filter_by(item_id=episode, kind="image").one()
        assert image.path == "cover.jpg"
        assert session.get(Item, episode).primary_image_tag == image.id


def test_rollback_leaves_no_partial_claim_or_content(parent, recipient, monkeypatch):
    from mollytime_server.api import shares

    share = create(parent)
    real_options = shares.MediaOptions
    monkeypatch.setattr(
        shares, "MediaOptions", Mock(side_effect=RuntimeError("simulated write failure"))
    )
    with pytest.raises(RuntimeError, match="simulated write failure"):
        recipient.post("/api/manage/shares/accept", json={"code": share["code"]})
    with Session(db.get_engine()) as session:
        assert session.query(ShareClaim).count() == 0
        assert session.query(Item).filter_by(family_id="f2").count() == 2
        assert session.query(MediaFile).filter_by(family_id="f2").count() == 1
    monkeypatch.setattr(shares, "MediaOptions", real_options)
    accept(recipient, share)


def test_snapshot_retention_blocks_bucket_change_after_source_purge(parent, recipient, monkeypatch):
    from fastapi import HTTPException

    from mollytime_server.api.operations import check_destination
    from mollytime_server.storage.settings import get_storage_settings

    with Session(db.get_engine()) as session:
        file = session.get(MediaFile, "v1")
        file.storage, file.path, file.size_bytes = "oss", "families/f1/media/video.mp4", 10
        session.commit()
    monkeypatch.setattr(OssStorage, "delete", Mock())
    share = create(parent)
    archive_purge(parent, "series")
    with Session(db.get_engine()) as session:
        assert session.query(MediaFile).filter_by(storage="oss").count() == 0
        with pytest.raises(HTTPException) as error:
            check_destination(
                session,
                {
                    "oss_endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
                    "oss_bucket": "other-bucket",
                },
                get_storage_settings(),
            )
        assert error.value.status_code == 409
    expire(share)
    monkeypatch.setattr(OssStorage, "delete", Mock(side_effect=RuntimeError("offline")))
    cleanup_shares()
    with Session(db.get_engine()) as session:
        assert session.query(ShareFile).count() == 0
        with pytest.raises(HTTPException):
            check_destination(
                session, {"oss_endpoint": "", "oss_bucket": "other-bucket"}, get_storage_settings()
            )


def test_public_overview_without_login_requires_authenticated_claim(parent, recipient):
    share = create(parent)
    with TestClient(create_app()) as guest:
        preview = guest.post("/api/shares/preview", json={"code": share["code"]})
        assert preview.status_code == 200
        assert preview.json()["name"] == "Stories"
        assert preview.json()["claimedResourceId"] is None
        assert preview.json()["ownShare"] is False
        assert all(
            value not in preview.text
            for value in ("video.mp4", "subtitle.srt", "storage", '"url"', '"sha256"')
        )
        assert (
            guest.post("/api/manage/shares/accept", json={"code": share["code"]}).status_code == 401
        )
        assert guest.post("/api/shares/preview", json={"token": "A" * 32}).status_code == 422
        assert guest.post("/api/shares/preview", json={"code": "A" * 12}).status_code == 404
        expire(share)
        assert guest.post("/api/shares/preview", json={"code": share["code"]}).status_code == 410


def test_public_overview_claim_state_is_scoped_to_logged_in_family(parent, recipient):
    share = create(parent)
    root = accept(recipient, share)
    assert (
        parent.post("/api/shares/preview", json={"code": share["code"]}).json()["ownShare"] is True
    )
    preview = recipient.post("/api/shares/preview", json={"code": share["code"]}).json()
    assert preview["claimedResourceId"] == root
    assert preview["ownShare"] is False
    with TestClient(create_app()) as guest:
        assert (
            guest.post("/api/shares/preview", json={"code": share["code"]}).json()[
                "claimedResourceId"
            ]
            is None
        )
    expire(share)
    assert (
        recipient.post("/api/shares/preview", json={"code": share["code"]}).json()[
            "claimedResourceId"
        ]
        == root
    )


def test_migration_removes_token_column_and_preserves_claims_and_foreign_keys(parent, recipient):
    from sqlalchemy import inspect

    share = create(parent)
    root = accept(recipient, share)
    engine = db.get_engine()
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "ALTER TABLE content_shares ADD COLUMN token_hash VARCHAR(64) NOT NULL DEFAULT 'obsolete-token'"
        )
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX old_token_hash ON content_shares(token_hash)"
        )
    barrier = threading.Barrier(2)

    def initialize():
        barrier.wait(timeout=5)
        db.init_db()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(initialize) for _ in range(2)]
        for future in futures:
            future.result(timeout=10)
    db.init_db()
    assert "token_hash" not in {
        column["name"] for column in inspect(engine).get_columns("content_shares")
    }
    with engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
    assert accept(recipient, share) == root
    create(parent)


def test_share_artwork_uses_snapshot_and_never_grants_video_access(parent, recipient):
    root = config.get_settings().resolved_media_dir()
    (root / "share-cover.jpg").write_bytes(b"snapshot-cover")
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="share-cover", family_id="f1", item_id="series", kind="image",
            storage="local", path="share-cover.jpg", mime="image/jpeg", size_bytes=14))
        session.get(Item, "series").overview = "Stories to enjoy together"
        session.get(Item, "e1").runtime_ticks = 600_000_000
        session.commit()
    share = create(parent)
    with TestClient(create_app()) as guest:
        data = guest.post("/api/shares/preview", json={"code": share["code"]}).json()
        assert data["overview"] == "Stories to enjoy together"
        assert data["durationMs"] == 60000
        assert next(row for row in data["items"] if row["type"] == "Episode")["imageId"] == data["imageId"]
        route = f'/api/shares/images/{data["imageId"]}'
        barrier = threading.Barrier(4)
        def fetch_cover():
            barrier.wait(timeout=5)
            return guest.post(route, json={"code": share["code"]})
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = [task.result(timeout=10) for task in [pool.submit(fetch_cover) for _ in range(4)]]
        assert all(result.status_code == 200 and result.content == b"snapshot-cover" for result in results)
        image = guest.post(route, json={"code": share["code"]})
        assert image.status_code == 200 and image.content == b"snapshot-cover"
        assert image.headers["content-type"] == "image/jpeg"
        assert image.headers["cache-control"] == "no-store"
        with Session(db.get_engine()) as session:
            video = next(file for file in session.query(ShareFile).filter_by(share_id=share["id"]).all() if file.metadata_["kind"] == "video")
            video_id = video.id
        assert guest.post(f"/api/shares/images/{video_id}", json={"code": share["code"]}).status_code == 404
        assert guest.post(route, json={"code": "A" * 12}).status_code == 404
        assert guest.post(route, json={"code": "invalid"}).status_code == 422
        archive_purge(parent, "series")
        assert guest.post(route, json={"code": share["code"]}).content == b"snapshot-cover"
        expire(share)
        assert guest.post(route, json={"code": share["code"]}).status_code == 410
