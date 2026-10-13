import datetime as dt

import pytest
from sqlalchemy import event as sql_event
from sqlalchemy.orm import Session
from test_management import event, native_token, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.management_models import ResourceState
from mollytime_server.models import Item, MediaFile
from mollytime_server.resource_policy import visible, visible_item_ids


def seed_catalog():
    with Session(db.get_engine()) as session:
        session.get(Item, "e1").index_number = 1
        for index in range(60):
            key = f"video-{index:02}"
            session.add(Item(id=key, family_id="f1", parent_id="season", type="Episode",
                             name=f"Video {index:02}", index_number=index + 2))
            session.add(MediaFile(id=f"media-{key}", family_id="f1", item_id=key,
                                  kind="video", storage="local", path="video.mp4"))
        # Duplicate video files must not create duplicate cards or inflate totals.
        session.add(MediaFile(id="duplicate", family_id="f1", item_id="video-00",
                              kind="video", storage="local", path="another.mp4"))
        session.flush()
        session.add(ResourceState(item_id="video-03", status="draft", ready=True))
        for index in range(30):
            key = f"folder-{index:02}"
            session.add(Item(id=key, family_id="f1", type="Series", name=f"Folder {index:02}",
                             primary_image_tag="cover"))
            session.flush()
            session.add(ResourceState(item_id=key, status="archived" if index == 4 else "published", ready=True,
                                      published_at=dt.datetime(2026, 1, 1)))
            session.add(Item(id=f"{key}-video", family_id="f1", parent_id=key,
                             type="Episode", name="Video"))
            session.add(MediaFile(id=f"{key}-media", family_id="f1", item_id=f"{key}-video",
                                  kind="video", storage="local", path="video.mp4"))
        session.commit()


def test_playlist_pages_are_bounded_ordered_and_keep_late_resume(parent):  # noqa: F811
    seed_catalog()
    headers = {**native_token(), "X-Molly-Child": "c1"}
    path = "/api/series/series/playlist"
    sid = parent.post("/api/playback/sessions", headers=headers,
                      json={"episodeId": "video-50", "childId": "c1"}).json()["sessionId"]
    assert parent.post(f"/api/playback/sessions/{sid}/events", headers=headers,
                       json=event(position=42000)).status_code == 200
    loaded = []

    def capture(_session, item):
        if isinstance(item, Item) and item.type == "Episode":
            loaded.append(item.id)

    sql_event.listen(Session, "loaded_as_persistent", capture)
    try:
        first = parent.get(path + "?page=1&pageSize=24", headers=headers).json()
    finally:
        sql_event.remove(Session, "loaded_as_persistent", capture)
    assert len(first["episodes"]) == 24 and first["total"] == 60 and first["hasMore"]
    assert first["episodeId"] == "video-50" and first["positionMs"] == 42000
    assert first["resumeEpisode"]["id"] == "video-50"
    assert len(set(loaded)) <= 25  # Current batch plus the separate resume card.
    pages = [first] + [parent.get(path + f"?page={page}&pageSize=24", headers=headers).json()
                       for page in (2, 3)]
    ids = [episode["id"] for data in pages for episode in data["episodes"]]
    assert ids == ["e1"] + [f"video-{index:02}" for index in range(60) if index != 3]
    assert not pages[-1]["hasMore"] and len(pages[-1]["episodes"]) == 12
    assert parent.get(path + "?page=4", headers=headers).json()["episodes"] == []
    assert parent.get(path + "?page=1&childId=c2", headers=headers).status_code == 404
    assert not parent.get(path + "?page=1", headers=native_token()).json()["hasProgress"]
    # Completion finds the next visible episode even when outside the current page.
    assert parent.post(f"/api/playback/sessions/{sid}/events", headers=headers,
                       json=event(seq=1, start=1000, end=2000, completed=True)).status_code == 200
    assert parent.get(path + "?page=1", headers=headers).json()["episodeId"] == "video-51"


def test_home_library_loads_beyond_24_and_keeps_curated_limits(parent):  # noqa: F811
    seed_catalog()
    headers = {**native_token(), "X-Molly-Home-Schema": "2"}
    first = parent.get("/api/home?page=1&pageSize=24", headers=headers).json()["rows"][0]
    second = parent.get("/api/home?page=2&pageSize=24&rowId=library", headers=headers).json()["rows"][0]
    assert first["id"] == "library" and first["total"] == 30 and first["hasMore"]
    assert len(first["items"]) == 24 and len(second["items"]) == 6 and not second["hasMore"]
    ids = [item["id"] for item in first["items"] + second["items"]]
    assert len(set(ids)) == 30 and "folder-04" not in ids
    assert next(item for item in second["items"] if item["id"] == "series")["episodeCount"] == 60
    assert len(parent.get("/api/home", headers=headers).json()["rows"][0]["items"]) == 24
    assert parent.get("/api/home?page=2&rowId=missing", headers=headers).status_code == 404
    from mollytime_server.api.catalog_pagination import paged_home
    with Session(db.get_engine()) as session:
        content = {"rows": [{"id": "manual", "title": "Picks", "enabled": True,
                             "source": "manual", "limit": 3,
                             "itemIds": ["folder-09", "folder-01", "folder-04", "folder-08", "folder-05"]}]}
        data = paged_home(content, session, "f1", None, 1, 2, None)["rows"][0]
        assert [item["id"] for item in data["items"]] == ["folder-09", "folder-01"]
        assert data["total"] == 3 and data["hasMore"]
        data = paged_home(content, session, "f1", None, 2, 2, "manual")["rows"][0]
        assert [item["id"] for item in data["items"]] == ["folder-08"] and not data["hasMore"]


@pytest.mark.parametrize("path", ["/api/home", "/api/series/series/playlist"])
@pytest.mark.parametrize("query", ["page=0", "page=-1", "page=2147483648", "pageSize=0", "pageSize=49"])
def test_pagination_validates_bounds(parent, path, query):  # noqa: F811
    assert parent.get(f"{path}?{query}", headers=native_token()).status_code == 422


def test_sql_visibility_matches_ancestor_family_and_cycle_rules(parent):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.add_all([
            Item(id="draft-root", family_id="f1", type="Series", name="Draft"),
            Item(id="hidden", family_id="f1", parent_id="draft-root", type="Episode", name="Hidden"),
            Item(id="foreign-parent", family_id="f1", parent_id="e2", type="Episode", name="Foreign"),
            Item(id="cycle-a", family_id="f1", type="Series", name="Cycle A"),
            Item(id="cycle-b", family_id="f1", type="Season", name="Cycle B"),
        ])
        session.flush()
        session.get(Item, "cycle-a").parent_id = "cycle-b"
        session.get(Item, "cycle-b").parent_id = "cycle-a"
        session.add(ResourceState(item_id="draft-root", status="draft", ready=True))
        session.commit()
        expected = {item.id for item in session.query(Item).filter(Item.family_id == "f1") if visible(session, item)}
        actual = {key for key, in session.execute(visible_item_ids("f1"))}
        assert actual == expected
