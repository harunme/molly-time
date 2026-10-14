# Imported pytest fixtures are intentionally reused as test arguments.
# ruff: noqa: F811
import datetime as dt

import pytest
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.management_models import (
    Device,
    DeviceDownload,
    HomeConfig,
    HomeRevision,
    ResourceState,
    UploadSession,
    WatchInterval,
    WatchSession,
)
from mollytime_server.models import ChildProfile, Item


def test_resource_pages_filter_before_count_and_keep_family_scope(parent):
    with Session(db.get_engine()) as session:
        for index in range(45):
            key = f"folder-{index:02}"
            session.add(Item(id=key, family_id="f1", type="Series", name=f"Folder {index:02}"))
            session.flush()
            if index % 2 == 0:
                session.add(ResourceState(item_id=key, status="draft", ready=False))
        session.add(Item(id="other-folder", family_id="f2", type="Series", name="Folder outside"))
        session.add(Item(id="literal-folder", family_id="f1", type="Series", name="100%_done"))
        session.commit()
    path = "/api/manage/resources?q=Folder&summary=true&pageSize=20"
    first = parent.get(path + "&page=1").json()
    second = parent.get(path + "&page=2").json()
    assert first["total"] == second["total"] == 45
    assert len(first["items"]) == len(second["items"]) == 20
    assert {row["id"] for row in first["items"]}.isdisjoint(row["id"] for row in second["items"])
    assert set(first["items"][0]) == {"id", "name", "type", "status"}
    assert parent.get(path + "&page=3").json()["items"][-1]["id"] == "folder-44"
    assert parent.get(path + "&page=1&status=draft").json()["total"] == 23
    assert parent.get(path + "&page=1&status=published").json()["total"] == 22
    literal = parent.get("/api/manage/resources", params={"page": 1, "q": "%_"}).json()
    assert [row["id"] for row in literal["items"]] == ["literal-folder"]
    assert parent.get(path + "&page=4").json()["items"] == []


def test_folder_pages_include_direct_and_season_videos(parent):
    with Session(db.get_engine()) as session:
        for index in range(25):
            session.add(Item(id=f"paged-video-{index:02}", family_id="f1", type="Episode",
                name=f"Paged Video {index:02}", index_number=index + 1,
                parent_id="series" if index % 2 else "season"))
        session.commit()
    first = parent.get("/api/manage/folders/series/videos?page=1&pageSize=20&q=Paged").json()
    second = parent.get("/api/manage/folders/series/videos?page=2&pageSize=20&q=Paged").json()
    assert first["total"] == second["total"] == 25
    assert len(first["items"]) == 20 and len(second["items"]) == 5
    assert second["items"][0]["indexNumber"] == 21


@pytest.mark.parametrize("kind,endpoint", [
    ("Series", "resources"),
    ("Episode", "folders/series/videos"),
])
def test_archives_are_hidden_before_pagination_and_can_be_found_explicitly(parent, kind, endpoint):
    with Session(db.get_engine()) as session:
        for index in range(6):
            key = f"archive-check-{index}"
            session.add(Item(
                id=key, family_id="f1", type=kind, name=f"Archive check {index}",
                index_number=index + 1,
                parent_id=("series" if index % 2 else "season") if kind == "Episode" else None,
            ))
            session.flush()
            if index in (1, 2):
                session.add(ResourceState(item_id=key, status="draft" if index == 1 else "published"))
        session.commit()
    for index in (0, 5):
        response = parent.post(f"/api/manage/resources/archive-check-{index}/archive")
        assert response.status_code == 200
    path = f"/api/manage/{endpoint}?q=Archive%20check"
    first = parent.get(path + "&page=1&pageSize=3&status=").json()
    second = parent.get(path + "&page=2&pageSize=3").json()
    assert first["total"] == second["total"] == 4
    assert [row["id"] for row in first["items"]] == [f"archive-check-{i}" for i in (1, 2, 3)]
    assert [row["id"] for row in second["items"]] == ["archive-check-4"]
    assert len(parent.get(path).json()) == 4
    assert parent.get(path + "&page=1&status=draft").json()["total"] == 1
    assert parent.get(path + "&page=1&status=published").json()["total"] == 3
    archived = parent.get(path + "&page=1&status=archived").json()
    assert archived["total"] == 2
    assert [row["id"] for row in archived["items"]] == ["archive-check-0", "archive-check-5"]
    assert all(row["status"] == "archived" for row in archived["items"])
    if kind == "Series":
        assert parent.get(path + "&page=1&summary=true").json()["total"] == 4
    detail = parent.get("/api/manage/resources/archive-check-0")
    assert detail.status_code == 200 and detail.json()["status"] == "archived"


def test_settings_upload_and_revision_lists_have_complete_pages(parent):
    with Session(db.get_engine()) as session:
        session.add(HomeConfig(id="f1:default", family_id="f1", draft={"schemaVersion": 1, "rows": []}))
        for index in range(25):
            session.add(ChildProfile(id=f"child-{index}", family_id="f1", name=f"Child {index}"))
            session.add(Device(id=f"device-{index}", family_id="f1", user_id="u1", name=f"TV {index}", revoked=index == 0))
            session.add(UploadSession(id=f"upload-{index}", family_id="f1", item_id="e1",
                filename=f"video-{index}.mp4", kind="video", size=100, fingerprint=str(index)))
            session.add(HomeRevision(id=f"revision-{index}", config_id="f1:default", user_id="u1",
                content={"schemaVersion": 1, "rows": []}))
        session.commit()
    for endpoint, total in [("children", 26), ("devices", 25), ("uploads", 25), ("home-config/revisions", 25)]:
        first = parent.get(f"/api/manage/{endpoint}?page=1&pageSize=20").json()
        second = parent.get(f"/api/manage/{endpoint}?page=2&pageSize=20").json()
        assert first["total"] == second["total"] == total
        assert len(first["items"]) == 20 and len(second["items"]) == total - 20
        assert {row["id"] for row in first["items"]}.isdisjoint(row["id"] for row in second["items"])
    assert parent.get("/api/manage/devices?page=1&activeOnly=true").json()["total"] == 24


def test_watch_detail_pages_preserve_full_range_totals(parent):
    with Session(db.get_engine()) as session:
        for index in range(31):
            key = f"watch-{index:02}"
            session.add(WatchSession(id=key, family_id="f1", user_id="u1", child_id="c1",
                item_id="e1", item_name="Story", purpose="child_watch", last_seq=0,
                started_at=dt.datetime(2026, 10, 10, 12, index, tzinfo=dt.UTC)))
            session.flush()
            session.add(WatchInterval(session_id=key, seq=0, start_ms=0, end_ms=1000,
                played_ms=1000, position_ms=1000))
        session.commit()
    path = "/api/manage/reports/watch-time?start=2026-10-10&end=2026-10-10&pageSize=10"
    first = parent.get(path + "&sessionPage=1").json()
    second = parent.get(path + "&sessionPage=2").json()
    assert first["totalPlayedMs"] == second["totalPlayedMs"] == 31000
    assert first["sessionTotal"] == second["sessionTotal"] == 31
    assert first["contentTotal"] == 1
    assert len(first["sessions"]) == len(second["sessions"]) == 10
    assert {row["id"] for row in first["sessions"]}.isdisjoint(row["id"] for row in second["sessions"])
    assert first["sessions"][0]["positionMs"] == 1000


def test_download_pages_only_include_requested_devices_and_media(parent):
    with Session(db.get_engine()) as session:
        for index in range(25):
            key = f"tv-{index}"
            session.add(Device(id=key, family_id="f1", user_id="u1", name=f"TV {index}"))
            session.flush()
            session.add(DeviceDownload(id=f"copy-{index}", family_id="f1", device_id=key,
                media_id="v1", desired="saved", status="queued"))
        session.commit()
    path = "/api/manage/resources/e1/downloads?pageSize=20&mediaId=v1"
    first = parent.get(path + "&page=1").json()
    second = parent.get(path + "&page=2").json()
    assert first["total"] == second["total"] == 25
    assert len(first["items"]) == 20 and len(second["items"]) == 5
    filtered = parent.get(path + "&page=1&deviceIds=tv-23,tv-24").json()
    assert filtered["total"] == 2
    assert {row["deviceId"] for row in filtered["items"]} == {"tv-23", "tv-24"}
    assert parent.get(path + "&page=1&deviceIds=outside").json()["total"] == 0
    assert parent.get(path + "&page=1&mediaId=s2").json()["total"] == 0


@pytest.mark.parametrize("endpoint", ["resources", "folders/series/videos", "uploads", "children", "devices", "home-config/revisions"])
def test_page_bounds_are_validated(parent, endpoint):
    assert parent.get(f"/api/manage/{endpoint}?page=0").status_code == 422
    assert parent.get(f"/api/manage/{endpoint}?page=1&pageSize=101").status_code == 422


def test_pending_uploads_filter_before_pagination_and_keep_family_scope(parent):
    with Session(db.get_engine()) as session:
        for index, status in enumerate(["ready", "cancelled", "uploading", "processing", "failed"]):
            session.add(UploadSession(id=f"pending-{index}", family_id="f1", item_id="e1",
                filename=f"video-{index}.mp4", kind="video", size=100, fingerprint=str(index), status=status))
        session.add(UploadSession(id="other-pending", family_id="f2", item_id="e1",
            filename="other.mp4", kind="video", size=100, fingerprint="other", status="uploading"))
        session.commit()
    first = parent.get("/api/manage/uploads?pending=true&page=1&pageSize=2").json()
    second = parent.get("/api/manage/uploads?pending=true&page=2&pageSize=2").json()
    assert first["total"] == second["total"] == 3
    rows = first["items"] + second["items"]
    assert {row["status"] for row in rows} == {"uploading", "processing", "failed"}
    assert {row["id"] for row in rows} == {"pending-2", "pending-3", "pending-4"}
    assert parent.get("/api/manage/uploads?page=1").json()["total"] == 5
