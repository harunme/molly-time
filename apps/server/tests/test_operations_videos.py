import datetime as dt

import pytest
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_operations import operator  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.accounts import AccountIdentity
from mollytime_server.api import playback
from mollytime_server.management_models import (
    MediaOptions,
    ResourceState,
    TrashEntry,
    UploadSession,
    WatchSession,
)
from mollytime_server.models import Item, MediaFile, PlaybackEvent, User

BASE = "/api/manage/operations/videos"


@pytest.fixture
def library(operator):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.add_all([
            User(id="u2", family_id="f2", name="Second parent", password_hash="unused"),
            User(id="u3", family_id="f2", name="Family member", password_hash="unused", role="member"),
        ])
        session.flush()
        session.add_all([
            AccountIdentity(user_id="u2", account_id="2000000002", email="second@example.test"),
            AccountIdentity(user_id="u3", account_id="2000000003", email="member@example.test"),
            Item(id="folder2", family_id="f2", type="Series", name="Other stories"),
        ])
        session.flush()
        session.get(Item, "e2").parent_id = "folder2"
        session.add_all([
            MediaFile(id="v2", family_id="f2", item_id="e2", kind="video", storage="local",
                      path="video.mp4", mime="video/mp4", size_bytes=10),
            UploadSession(id="v2", family_id="f2", item_id="e2", filename="Original 100%.mp4",
                          kind="video", size=10, fingerprint="test", status="ready",
                          created_at=dt.datetime(2026, 11, 6, 9, 0)),
            ResourceState(item_id="e2", status="draft", ready=True),
        ])
        session.flush()
        session.add(MediaOptions(media_id="v2", label="Original 100%.mp4"))
        session.commit()
    return operator


def test_global_list_pagination_search_and_family_account_filter(library, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Listing must not access media storage")
    monkeypatch.setattr(playback, "build_storage", forbidden)
    result = library.get(BASE + "?pageSize=1").json()
    assert result["total"] == 2 and result["pageSize"] == 1
    video = result["items"][0]
    assert video["id"] == "v2" and video["familyName"] == "Two"
    assert {row["id"] for row in video["accounts"]} == {"u2", "u3"}
    assert video["status"] == "unpublished" and video["canPreview"]
    assert video["collection"] == "Other stories"
    assert video["filename"] == "Original 100%.mp4"
    assert video["uploadedAt"] == "2026-11-06T09:00:00+00:00"
    assert "path" not in video and "url" not in video
    assert library.get(BASE + "?page=2&pageSize=1").json()["items"][0]["id"] == "v1"
    assert library.get(BASE + "?page=3&pageSize=1").json()["items"] == []
    for term in ["second@example.test", "member@example.test", "2000000003", "Second parent", "Original", "%"]:
        found = library.get(BASE, params={"q": term}).json()
        assert found["total"] == 1 and found["items"][0]["id"] == "v2"
    assert library.get(BASE, params={"q": "no match"}).json()["total"] == 0
    assert library.get(BASE + "?userId=u3").json()["total"] == 1
    assert library.get(BASE + "?userId=missing").status_code == 404
    assert library.get(BASE + "?storage=oss").json()["total"] == 0
    for query in ["page=0", "pageSize=101", "storage=invalid", "q=" + "x" * 255]:
        assert library.get(BASE + "?" + query).status_code == 422


def test_only_superadmins_can_list_or_stream(parent):  # noqa: F811
    for role in ["admin", "member"]:
        with Session(db.get_engine()) as session:
            session.get(User, "u1").role = role
            session.commit()
        assert parent.get(BASE).status_code == 403
        assert parent.get(BASE + "/v1/play").status_code == 403
        assert parent.head(BASE + "/v1/play").status_code == 403
    parent.cookies.clear()
    assert parent.get(BASE).status_code == 401
    assert parent.get(BASE + "/v1/play").status_code == 401


def test_device_or_bearer_credentials_cannot_use_operations(client):  # noqa: F811
    assert client.get(BASE).status_code == 401
    assert client.get(BASE + "/v1/play").status_code == 401


def test_cross_family_preview_range_and_existing_isolation(library):
    result = library.get(BASE + "/v2/play", headers={"Range": "bytes=2-5"})
    assert result.status_code == 206 and result.content == b"2345"
    assert result.headers["content-range"] == "bytes 2-5/10"
    assert result.headers["cache-control"] == "no-store"
    assert library.head(BASE + "/v2/play").headers["content-length"] == "10"
    assert library.get(BASE + "/v2/play", headers={"Range": "bytes=99-"}).status_code == 416
    assert library.get("/api/episodes/e2/play").status_code == 404
    assert library.get(BASE + "/s2/play").status_code == 404
    assert library.get(BASE + "/missing/play").status_code == 404
    with Session(db.get_engine()) as session:
        assert session.query(WatchSession).count() == 0
        assert session.query(PlaybackEvent).count() == 0
        session.get(User, "u1").role = "admin"
        session.commit()
    assert library.get(BASE + "/v2/play").status_code == 403


def test_archived_ancestor_deletion_and_legacy_catalog(library):
    with Session(db.get_engine()) as session:
        session.add_all([
            ResourceState(item_id="folder2", status="archived", ready=True),
            TrashEntry(item_id="folder2"),
            Item(id="legacy", type="Episode", name="Legacy video"),
        ])
        session.flush()
        session.add(MediaFile(id="legacy-video", item_id="legacy", kind="video", storage="local", path="video.mp4"))
        session.commit()
    found = library.get(BASE + "?userId=u2").json()["items"][0]
    assert found["status"] == "archived" and found["canPreview"]
    assert library.get(BASE + "/v2/play").status_code == 200
    legacy = library.get(BASE + "?q=Legacy").json()["items"][0]
    assert legacy["accounts"] == [] and legacy["familyId"] is None
    assert library.get(BASE + "/legacy-video/play").status_code == 200
    with Session(db.get_engine()) as session:
        session.get(TrashEntry, "folder2").deleting = True
        session.commit()
    assert not library.get(BASE + "?userId=u2").json()["items"][0]["canPreview"]
    assert library.get(BASE + "/v2/play").status_code == 404


def test_invalid_ownership_and_replaced_files_are_not_exposed(library):
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="mismatch", family_id="f1", item_id="e2", kind="video", storage="local", path="video.mp4"))
        session.add(MediaFile(id="retired", family_id="f2", item_id="e2", kind="retired_video", storage="local", path="video.mp4"))
        session.commit()
    assert library.get(BASE).json()["total"] == 2
    assert library.get(BASE + "/mismatch/play").status_code == 404
    assert library.get(BASE + "/retired/play").status_code == 404


def test_oss_preview_signs_only_on_request_without_fetching_media(library, monkeypatch):
    calls = []
    store = object()
    monkeypatch.setattr(playback, "build_storage", lambda backend: store)
    monkeypatch.setattr(playback, "media_url", lambda storage, key, ttl, family: (
        calls.append((storage, key, family)) or "https://media.example.test/signed-video"
    ))
    with Session(db.get_engine()) as session:
        session.get(MediaFile, "v2").storage = "oss"
        session.commit()
    assert library.get(BASE + "?storage=oss").json()["total"] == 1
    assert calls == []
    response = library.get(BASE + "/v2/play", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == "https://media.example.test/signed-video"
    assert response.headers["cache-control"] == "no-store"
    assert calls == [(store, "video.mp4", "f2")]
