# ruff: noqa: F811 -- imported pytest fixtures
import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_remote_storage import remote  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.management_models import UploadSession, UploadTarget

VIDEO_LIMIT = 500 * 1024**2


def body(size, kind="video", filename="sample.mp4"):
    return {
        "itemId": "e1", "filename": filename, "size": size,
        "fingerprint": "size-limit", "kind": kind,
    }


def test_default_limits_and_options(parent):
    settings = config.get_settings()
    assert settings.max_upload_bytes == settings.media_processing_max_bytes == VIDEO_LIMIT
    response = parent.get("/api/manage/uploads/options")
    assert response.status_code == 200
    assert response.json() == {"video": VIDEO_LIMIT, "subtitle": 5 * 1024**2, "image": 20 * 1024**2, "preview": 20 * 1024**2}


@pytest.mark.parametrize("backend", ["local", "oss"])
def test_oversize_upload_creates_no_session_or_cloud_multipart(remote, backend):
    web, oss = remote
    config.get_settings().storage_backend = backend
    result = web.post("/api/manage/uploads", json=body(VIDEO_LIMIT + 1))
    assert result.status_code == 413
    assert result.json()["detail"] == "单个视频不能超过 500 MB"
    with Session(db.get_engine()) as session:
        assert session.scalar(select(func.count()).select_from(UploadSession)) == 0
        assert session.scalar(select(func.count()).select_from(UploadTarget)) == 0
    assert oss.uploaded == {} and oss.objects == {}


@pytest.mark.parametrize("backend", ["local", "oss"])
def test_file_at_exact_limit_is_allowed(remote, backend):
    web, _ = remote
    config.get_settings().storage_backend = backend
    response = web.post("/api/manage/uploads", json=body(VIDEO_LIMIT))
    assert response.status_code == 200
    assert response.json()["transport"] == backend
    assert response.json()["size"] == VIDEO_LIMIT


def test_effective_limit_uses_smaller_processing_capacity(parent, monkeypatch):
    monkeypatch.setattr(config.get_settings(), "media_processing_max_bytes", 200 * 1024**2)
    assert parent.get("/api/manage/uploads/options").json()["video"] == 200 * 1024**2
    response = parent.post("/api/manage/uploads", json=body(200 * 1024**2 + 1))
    assert response.status_code == 413
    assert response.json()["detail"] == "单个视频不能超过 200 MB"


@pytest.mark.parametrize("kind,filename,size,limit", [
    ("subtitle", "captions.srt", 5 * 1024**2 + 1, "字幕不能超过 5 MB"),
    ("image", "cover.jpg", 20 * 1024**2 + 1, "封面不能超过 20 MB"),
    ("preview", "preview.webp", 20 * 1024**2 + 1, "动态预览不能超过 20 MB"),
])
def test_other_media_keep_their_size_limits(parent, kind, filename, size, limit):
    response = parent.post("/api/manage/uploads", json=body(size, kind, filename))
    assert response.status_code == 413
    assert limit in response.json()["detail"]


def test_upload_options_require_login(parent):
    parent.post("/api/manage/auth/logout")
    assert parent.get("/api/manage/uploads/options").status_code == 401
