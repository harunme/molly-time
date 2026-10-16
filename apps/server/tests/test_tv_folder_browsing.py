# ruff: noqa: F811
from sqlalchemy.orm import Session
from test_management import native_token, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401
from test_tv_sync import state, tv  # noqa: F401

from mollytime_server import db
from mollytime_server.catalog_versions import version
from mollytime_server.management_models import ResourceState
from mollytime_server.models import MediaFile


def create(parent, name, kind="Series", parent_id=None):
    response = parent.post("/api/manage/resources", json={"name": name, "type": kind, "parentId": parent_id})
    assert response.status_code == 200, response.text
    key = response.json()["id"]
    if kind == "Episode":
        with Session(db.get_engine()) as session:
            session.add(MediaFile(id="media-" + key, item_id=key, family_id="f1", kind="video", storage="local", path="video.mp4"))
            session.get(ResourceState, key).ready = True
            session.commit()
        assert parent.post(f"/api/manage/resources/{key}/publish").status_code == 200
    return key


def test_tv_browses_one_level_in_management_order_and_reorders_playback(parent):
    root = create(parent, "收藏")
    other = create(parent, "其他故事")
    create(parent, "其他视频", "Episode", other)
    assert parent.post("/api/manage/resources/series/move", json={"folderId": root}).status_code == 200
    direct = create(parent, "目录内视频", "Episode", root)
    songs = create(parent, "韵律儿歌", parent_id="season")
    song = create(parent, "动作儿歌", "Episode", songs)
    create(parent, "空文件夹", parent_id=root)
    assert parent.put(f"/api/manage/resources/{direct}/position", json={"beforeId": "series"}).status_code == 200
    assert parent.put(f"/api/manage/resources/{songs}/position", json={"beforeId": "e1"}).status_code == 200
    assert parent.put(f"/api/manage/resources/{other}/position", json={"beforeId": root}).status_code == 200
    headers = native_token()
    home = parent.get("/api/home?page=1", headers=headers).json()
    library = next(row for row in home["rows"] if row["id"] == "library")
    assert [item["id"] for item in library["items"]] == [other, root]
    result = parent.get(f"/api/series/{root}/playlist?page=1", headers=headers)
    assert result.status_code == 200, result.text
    result = result.json()
    assert [item["id"] for item in result["items"]] == [direct, "series"]
    assert [item["type"] for item in result["items"]] == ["episode", "folder"]
    assert result["itemTotal"] == 2
    assert [item["id"] for item in result["episodes"]] == [direct, song, "e1"]
    nested = parent.get("/api/series/season/playlist?page=1&pageSize=1", headers=headers).json()
    assert [item["id"] for item in nested["items"]] == [songs]
    assert nested["itemsHasMore"] is True
    second = parent.get("/api/series/season/playlist?page=2&pageSize=1", headers=headers).json()
    assert [item["id"] for item in second["items"]] == ["e1"]
    assert second["itemsHasMore"] is False
    with Session(db.get_engine()) as session:
        before = version(session, "f1", "folder:season")
    assert parent.put("/api/manage/resources/e1/position", json={"beforeId": songs}).status_code == 200
    with Session(db.get_engine()) as session:
        assert version(session, "f1", "folder:season") != before
    reordered = parent.get(f"/api/series/{root}/playlist?page=1", headers=headers).json()
    assert [item["id"] for item in reordered["episodes"]] == [direct, "e1", song]


def test_static_catalog_contains_nested_series_and_seasons(parent, tv):
    songs = create(parent, "韵律儿歌", parent_id="season")
    create(parent, "动作儿歌", "Episode", songs)
    current = state(tv)
    manifest = tv.get("/api/tv/catalog/manifest", params={"version": current["catalogVersion"]}).json()
    folders = {item["id"]: item for item in manifest["folders"]}
    assert {"series", "season", songs} <= folders.keys()
    result = tv.get("/api/tv/catalog/folders/season", params={"version": folders["season"]["version"]})
    assert result.status_code == 200, result.text
    assert {item["id"] for item in result.json()["items"]} == {songs, "e1"}
    assert result.json()["itemTotal"] == 2
