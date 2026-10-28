# ruff: noqa: F811 -- imported pytest fixtures
import base64
import datetime as dt
import io
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy.orm import Session
from test_management import mp4, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.management_models import Device, MediaOptions, UploadTarget
from mollytime_server.media_worker import run_once
from mollytime_server.models import MediaFile
from mollytime_server.remote_uploads import expire_uploads
from mollytime_server.storage import build_storage
from mollytime_server.upload_metadata import metadata_path
from mollytime_server.utils.subtitles import webvtt


class FakeOss:
    name = "oss"

    def __init__(self):
        self.objects, self.uploaded, self.aborted = {}, {}, []
        self.completed = 0

    def initiate(self, key):
        self.uploaded[key] = []
        return "multipart"

    def parts(self, key, upload_id):
        return self.uploaded[key]

    def size_if_exists(self, key):
        return len(self.objects[key]) if key in self.objects else None

    def size(self, key):
        if key not in self.objects:
            raise FileNotFoundError(key)
        return len(self.objects[key])

    def complete(self, key, upload_id, parts):
        self.completed += 1
        self.objects[key] = b"x" * sum(p["size"] for p in parts)

    def abort(self, key, upload_id):
        self.aborted.append(key)

    def delete(self, key):
        self.objects.pop(key, None)

    def part_url(self, key, upload_id, number, ttl, md5):
        return {
            "url": f"https://bucket.example/{key}?part={number}",
            "headers": {"Content-MD5": md5},
        }

    def signed_url(self, key, ttl):
        return f"https://bucket.example/{key}?signed=1"

    def download(self, key, path, expected_size):
        Path(path).write_bytes(self.objects[key])

    def put_file(self, key, path, mime):
        self.objects[key] = Path(path).read_bytes()

    def open(self, key):
        return self.objects[key]


@pytest.fixture
def remote(parent, monkeypatch):
    fake, local = FakeOss(), build_storage("local")

    def factory(backend=None):
        return local if backend == "local" else fake

    for module in ("api.manage_resources", "api.playback", "media_worker", "remote_uploads"):
        monkeypatch.setattr(f"mollytime_server.{module}.build_storage", factory)
    monkeypatch.setattr(config.get_settings(), "storage_backend", "oss")
    return parent, fake


def start(client, size=10, *, kind="video", filename="sample.mp4"):
    response = client.post(
        "/api/manage/uploads",
        json={
            "itemId": "e1",
            "filename": filename,
            "size": size,
            "fingerprint": "fingerprint",
            "kind": kind,
        },
    )
    assert response.status_code == 200
    row = response.json()
    with Session(db.get_engine()) as session:
        return row["id"], session.get(UploadTarget, row["id"]).object_key


def test_direct_upload_validation_and_recovery(remote):
    client, oss = remote
    key, obj = start(client)
    assert client.get(f"/api/manage/uploads/{key}").json()["transport"] == "oss"
    assert client.put(f"/api/manage/uploads/{key}/chunks?offset=0", content=b"x").status_code == 409
    part = {"number": 2, "md5": "eHh4eHh4eHh4eHh4eHh4eA=="}
    assert client.post(f"/api/manage/uploads/{key}/part-url", json=part).status_code == 422
    part["number"] = 1
    assert client.post(f"/api/manage/uploads/{key}/part-url", json=part).status_code == 200
    assert client.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 409
    oss.uploaded[obj] = [{"number": 1, "size": 9, "etag": "tag"}]
    assert client.get(f"/api/manage/uploads/{key}/parts").status_code == 409
    oss.uploaded[obj][0]["size"] = 10
    assert client.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    assert client.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    assert oss.completed == 1
    assert client.post(f"/api/manage/uploads/{key}/cancel").status_code == 409


def test_remote_cancel_expiry_and_quota(remote):
    client, oss = remote
    key, obj = start(client)
    with Session(db.get_engine()) as session:
        session.get(UploadTarget, key).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(
            seconds=1
        )
        session.commit()
    assert client.get(f"/api/manage/uploads/{key}/parts").status_code == 410
    expire_uploads()
    assert obj in oss.aborted
    assert client.get(f"/api/manage/uploads/{key}").json()["status"] == "cancelled"
    config.get_settings().family_storage_limit_bytes = 1
    assert (
        client.post(
            "/api/manage/uploads",
            json={
                "itemId": "e1",
                "filename": "a.mp4",
                "size": 10,
                "fingerprint": "f",
                "kind": "video",
            },
        ).status_code
        == 507
    )


def test_mixed_playback_and_subtitle_cache(remote):
    client, oss = remote
    with Session(db.get_engine()) as session:
        file = session.get(MediaFile, "v1")
        file.storage, file.path, file.size_bytes, file.sha256 = "oss", "remote.mp4", 10, "abc"
        sub = session.get(MediaFile, "s1")
        sub.storage, sub.path, sub.sha256 = "oss", "remote.srt", "subtitle-version"
        session.add(MediaOptions(media_id="s1", offset_ms=1000))
        session.commit()
    oss.objects["remote.srt"] = b"1\n00:00:01,000 --> 00:00:02,000\nHello\n"
    info = client.get("/api/episodes/e1/playback").json()
    assert info["url"].startswith("https://bucket.example/") and info["version"] == "abc"
    assert client.get("/api/episodes/e1/play", follow_redirects=False).status_code == 302
    assert client.get("/api/episodes/e2/playback").status_code == 404
    path = info["subtitles"][0]["url"]
    assert b"00:00:02.000 --> 00:00:03.000" in client.get(path).content
    oss.objects.clear()
    assert client.get(path).status_code == 200


def test_remote_worker_failure_cleans_disk(remote):
    client, oss = remote
    key, obj = start(client)
    oss.objects[obj] = b"not a mp4!"
    assert client.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    metadata_path(key).unlink()
    assert run_once()
    assert client.get(f"/api/manage/uploads/{key}").json()["status"] == "failed"
    assert not (config.get_settings().data_dir / "uploads" / f"{key}.part").exists()
    assert obj in oss.objects


def test_download_commands_and_status_ownership(parent):
    from mollytime_server.auth import issue_access_token

    with Session(db.get_engine()) as session:
        session.add_all(
            [
                Device(id="d1", family_id="f1", user_id="u1", name="TV"),
                Device(id="d2", family_id="f2", user_id="u1", name="Other"),
            ]
        )
        session.get(MediaFile, "v1").size_bytes = 10
        session.commit()
    assert (
        parent.post("/api/manage/resources/e1/downloads", json={"deviceId": "d2"}).status_code
        == 404
    )
    response = parent.post("/api/manage/resources/e1/downloads", json={"deviceId": "d1"})
    assert response.status_code == 200
    download = response.json()
    assert parent.get("/api/manage/resources/e1/downloads").json()[0]["status"] == "queued"
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="admin", device_id="d1")
    parent.headers["Authorization"] = f"Bearer {token}"
    assert parent.get("/api/device/downloads").json()[0]["playback"]["mediaId"] == "v1"
    path = f"/api/device/downloads/{download['id']}/status"
    body = {"version": "v1", "status": "saved", "downloadedBytes": 9}
    assert parent.post(path, json=body).status_code == 409
    body["downloadedBytes"] = 10
    assert parent.post(path, json=body).status_code == 200
    with Session(db.get_engine()) as session:
        session.get(MediaFile, "v1").kind = "retired_video"
        session.commit()
    assert parent.get("/api/device/downloads").json()[0]["desired"] == "removed"
    assert parent.get(f"/api/device/downloads/{download['id']}/playback").status_code == 409


def test_webvtt_timing_and_unicode():
    result = webvtt("1\r\n00:00:00,500 --> 00:00:02,000\r\n你好\r\n".encode(), -1000)
    assert result.startswith(b"WEBVTT")
    assert b"00:00:00.000 --> 00:00:01.000" in result
    assert "你好" in result.decode()


def test_remote_video_processes_and_preserves_cloud_source(remote, mp4, monkeypatch):
    from unittest.mock import Mock

    from mollytime_server import media_worker

    extract = Mock(side_effect=AssertionError("Must not decode video on the server"))
    monkeypatch.setattr(media_worker, "extract_cover", extract)
    image = io.BytesIO()
    Image.new("RGB", (64, 36), "blue").save(image, "JPEG")
    cover_data = image.getvalue()

    web, oss = remote
    monkeypatch.setattr(oss, "download", Mock(side_effect=AssertionError("Must not download video")))
    data = mp4
    key, obj = start(web, len(data))
    oss.objects[obj] = data
    assert web.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250, "cover": "data:image/jpeg;base64," + base64.b64encode(cover_data).decode()}).status_code == 200
    assert run_once()
    assert web.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"
    with Session(db.get_engine()) as session:
        file = session.get(MediaFile, key)
        assert file.storage == "oss" and file.path == obj
        assert file.sha256 == ""
        assert session.get(MediaOptions, key).retention == "backup"
        cover = session.query(MediaFile).filter(MediaFile.item_id == file.item_id,
                                                MediaFile.kind == "image").first()
        assert cover is not None and cover.storage == "oss"
        assert oss.objects[cover.path] == cover_data
    assert oss.objects[obj] == data
    assert not (config.get_settings().data_dir / "uploads" / f"{key}.part").exists()
    extract.assert_not_called()
    db.init_db()  # additive migration is safe to repeat
    assert web.get("/api/episodes/e1/playback").json()["mediaId"] == key


def test_failed_upload_can_be_discarded(remote):
    web, oss = remote
    key, obj = start(web)
    oss.objects[obj] = b"not a mp4!"
    assert web.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    metadata_path(key).unlink()
    assert run_once()
    assert web.post(f"/api/manage/uploads/{key}/cancel").status_code == 200
    assert obj not in oss.objects


def test_remote_completion_recovers_after_database_interruption(remote):
    web, oss = remote
    key, obj = start(web)
    # OSS has completed, but the original request never committed task creation.
    oss.objects[obj] = b"x" * 10
    assert web.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    assert oss.completed == 0
    assert web.get(f"/api/manage/uploads/{key}").json()["status"] == "processing"


def test_cross_family_cannot_sign_or_cancel_upload(remote):
    from mollytime_server.auth import hash_password
    from mollytime_server.models import User

    web, _ = remote
    key, _ = start(web)
    with Session(db.get_engine()) as session:
        session.add(
            User(
                id="other-parent",
                family_id="f2",
                name="other-parent",
                password_hash=hash_password("other-password"),
            )
        )
        session.commit()
    auth = web.post(
        "/api/manage/auth/login", json={"username": "other-parent", "password": "other-password"}
    )
    assert auth.status_code == 200
    web.headers["X-CSRF-Token"] = auth.json()["csrfToken"]
    assert web.get(f"/api/manage/uploads/{key}/parts").status_code == 404
    assert (
        web.post(
            f"/api/manage/uploads/{key}/part-url",
            json={"number": 1, "md5": "eHh4eHh4eHh4eHh4eHh4eA=="},
        ).status_code
        == 404
    )
    assert web.post(f"/api/manage/uploads/{key}/cancel").status_code == 404


@pytest.mark.parametrize("metadata", [None, {}, {"runtimeMs": 0}, {"runtimeMs": -1},
                                     {"runtimeMs": True}, {"runtimeMs": "1250"},
                                     {"runtimeMs": 2**63},
                                     {"runtimeMs": 1250, "cover": "not an image"},
                                     {"runtimeMs": 1250, "cover": "x" * 350001}])
def test_remote_completion_rejects_missing_or_invalid_browser_metadata(remote, metadata):
    web, oss = remote
    key, obj = start(web)
    oss.objects[obj] = b"x" * 10
    result = web.post(f"/api/manage/uploads/{key}/complete", json=metadata)
    assert result.status_code == 422
    assert web.get(f"/api/manage/uploads/{key}").json()["status"] == "uploading"
    assert oss.completed == 0


def test_browser_video_without_cover_avoids_all_server_video_processing(remote, monkeypatch):
    from unittest.mock import Mock

    from mollytime_server import media_worker
    web, oss = remote
    forbidden = Mock(side_effect=AssertionError("Video processing belongs to the browser"))
    monkeypatch.setattr(oss, "download", forbidden)
    monkeypatch.setattr(media_worker, "inspect_video", forbidden)
    monkeypatch.setattr(media_worker, "extract_cover", forbidden)
    monkeypatch.setattr(media_worker.shutil, "disk_usage", forbidden)
    key, obj = start(web)
    oss.objects[obj] = b"x" * 10
    assert web.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    assert run_once()
    assert web.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"
    forbidden.assert_not_called()
    assert not metadata_path(key).exists()
    with Session(db.get_engine()) as session:
        assert session.query(MediaFile).filter_by(item_id="e1", kind="image").first() is None
    info = web.get("/api/episodes/e1/playback").json()
    assert info["mediaId"] == info["version"] == key
    assert info["sha256"] == ""


def test_browser_metadata_is_kept_for_retry_and_cleared_after_success(remote, monkeypatch):
    from mollytime_server.management_models import MediaTask
    web, oss = remote
    key, obj = start(web)
    oss.objects[obj] = b"x" * 10
    assert web.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    size = oss.size
    def offline(*args):
        raise OSError("OSS unavailable")
    monkeypatch.setattr(oss, "size", offline)
    assert run_once()
    assert web.get(f"/api/manage/uploads/{key}").json()["status"] == "failed"
    assert metadata_path(key).exists()
    monkeypatch.setattr(oss, "size", size)
    with Session(db.get_engine()) as session:
        task_id = session.query(MediaTask).filter_by(upload_id=key).one().id
    assert web.post(f"/api/manage/tasks/{task_id}/retry").status_code == 200
    assert run_once()
    assert web.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"
    assert not metadata_path(key).exists()


@pytest.mark.parametrize("kind,filename", [("image", "cover.jpg"), ("preview", "motion.webp"), ("subtitle", "en.srt")])
def test_small_remote_files_keep_server_validation(remote, kind, filename):
    import hashlib
    web, oss = remote
    output = io.BytesIO()
    Image.new("RGB", (64, 36), "blue").save(output, "JPEG")
    if kind == "preview":
        output = io.BytesIO()
        Image.new("RGB", (64, 36), "red").save(output, "WEBP", save_all=True,
            append_images=[Image.new("RGB", (64, 36), "blue")], duration=[100, 100], loop=0)
    content = output.getvalue() if kind in ("image", "preview") else b"1\n00:00:00,000 --> 00:00:01,000\nHello\n"
    key, obj = start(web, len(content), kind=kind, filename=filename)
    oss.objects[obj] = content
    result = web.post(f"/api/manage/uploads/{key}/complete")
    assert result.status_code == 200
    if kind in ("image", "preview"):
        assert result.json()["status"] == "ready"
        assert result.json()["taskId"] is None
        assert not run_once()
        assert not (config.get_settings().data_dir / "uploads" / f"{key}.part").exists()
    else:
        assert run_once()
    assert web.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"
    with Session(db.get_engine()) as session:
        assert session.get(MediaFile, key).sha256 == hashlib.sha256(content).hexdigest()


def test_cancel_removes_metadata_left_by_incomplete_completion(remote):
    web, _ = remote
    key, _ = start(web)
    assert web.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 409
    assert metadata_path(key).exists()
    assert web.post(f"/api/manage/uploads/{key}/cancel").status_code == 200
    assert not metadata_path(key).exists()
