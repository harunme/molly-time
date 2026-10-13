from sqlalchemy.orm import Session
from test_management import event, native_token, parent, watch  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.management_models import ResourceState
from mollytime_server.models import Item, MediaFile


def seed_videos():
    with Session(db.get_engine()) as session:
        session.get(Item, "e1").index_number = 1
        session.add(
            Item(
                id="next",
                family_id="f1",
                type="Episode",
                name="Next",
                parent_id="series",
                index_number=2,
            )
        )
        session.add(
            MediaFile(
                id="next-media",
                family_id="f1",
                item_id="next",
                kind="video",
                storage="local",
                path="video.mp4",
            )
        )
        session.commit()


def test_home_recent_playback_precedes_library(parent):  # noqa: F811
    headers = {**native_token(), "X-Molly-Child": "c1", "X-Molly-Home-Schema": "2"}
    assert [row["title"] for row in parent.get("/api/home", headers=headers).json()["rows"]] == ["我的媒体库"]
    sid = watch(parent)
    response = parent.post(f"/api/playback/sessions/{sid}/events", headers=native_token(),
                           json=event(position=42000, completed=True))
    assert response.status_code == 200
    rows = parent.get("/api/home", headers=headers).json()["rows"]
    assert [row["title"] for row in rows] == ["最近播放", "我的媒体库"]
    assert rows[0]["items"][0]["id"] == "e1"
    assert rows[0]["items"][0]["completed"] is True
    assert [row["title"] for row in parent.get("/api/home", headers={**native_token(), "X-Molly-Home-Schema": "2"}).json()["rows"]] == ["最近播放", "我的媒体库"]


def test_folder_resume_family_history_and_completed_next(parent):  # noqa: F811
    seed_videos()
    path = "/api/series/series/playlist"
    headers = {**native_token(), "X-Molly-Child": "c1"}
    initial = parent.get(path, headers=headers).json()
    assert [e["id"] for e in initial["episodes"]] == ["e1", "next"]
    assert initial["episodeId"] == "e1" and initial["positionMs"] == 0
    sid = watch(parent)
    assert (
        parent.post(
            f"/api/playback/sessions/{sid}/events",
            headers=native_token(),
            json=event(position=42000),
        ).status_code
        == 200
    )
    resumed = parent.get(path, headers=headers).json()
    assert resumed["episodeId"] == "e1" and resumed["positionMs"] == 42000
    assert parent.get(path, headers=native_token()).json()["positionMs"] == 42000
    assert parent.get(path + "?childId=c2", headers=native_token()).status_code == 404
    assert (
        parent.post(
            f"/api/playback/sessions/{sid}/events",
            headers=native_token(),
            json=event(seq=1, start=1000, end=2000, completed=True),
        ).status_code
        == 200
    )
    assert parent.get(path, headers=headers).json()["episodeId"] == "next"
    assert parent.get("/api/episodes/next", headers=native_token()).json()["seriesId"] == "series"
    with Session(db.get_engine()) as session:
        session.add(ResourceState(item_id="next", status="draft", ready=True))
        session.commit()
    result = parent.get(path, headers=headers).json()
    assert [e["id"] for e in result["episodes"]] == ["e1"]
    assert result["episodeId"] == "e1" and result["positionMs"] == 0


def test_parent_creates_folder_upload_target_and_moves_existing_video(parent):  # noqa: F811
    folder = parent.post("/api/manage/resources", json={"name": "Animals", "type": "Series"}).json()
    video = parent.post(
        "/api/manage/resources", json={"name": "Cats", "type": "Episode", "parentId": folder["id"]}
    )
    assert video.status_code == 200
    before = parent.get("/api/manage/resources/e1").json()["files"]
    assert (
        parent.post("/api/manage/resources/e1/move", json={"folderId": folder["id"]}).status_code
        == 200
    )
    listing = parent.get(f"/api/manage/folders/{folder['id']}/videos").json()
    assert {e["id"] for e in listing} == {"e1", video.json()["id"]}
    assert parent.get("/api/manage/resources/e1").json()["files"] == before
    assert parent.get("/api/manage/folders/series/videos").json() == []
    assert (
        parent.post("/api/manage/resources/e2/move", json={"folderId": folder["id"]}).status_code
        == 404
    )
    assert (
        parent.post("/api/manage/resources/e1/move", json={"folderId": "season"}).status_code == 422
    )
    assert parent.get("/api/episodes/e1", headers=native_token()).json()["seriesId"] == folder["id"]


def test_next_episode_order_visibility_last_and_family_boundary(parent):  # noqa: F811
    seed_videos()
    headers = native_token()
    assert parent.get("/api/episodes/e1/next", headers=headers).json() == {"episodeId": "next"}
    assert parent.get("/api/episodes/next/next", headers=headers).json() == {"episodeId": None}
    assert parent.get("/api/episodes/e2/next", headers=headers).status_code == 404
    with Session(db.get_engine()) as session:
        session.add_all(
            [
                Item(id="another-folder", family_id="f1", type="Series", name="Another"),
                Item(
                    id="another-video",
                    family_id="f1",
                    type="Episode",
                    name="Another video",
                    parent_id="another-folder",
                ),
                MediaFile(
                    id="another-media",
                    family_id="f1",
                    item_id="another-video",
                    kind="video",
                    storage="local",
                    path="video.mp4",
                ),
                ResourceState(item_id="next", status="draft", ready=True),
            ]
        )
        session.commit()
    assert parent.get("/api/episodes/e1/next", headers=headers).json() == {"episodeId": None}
    assert parent.get("/api/episodes/next/next", headers=headers).status_code == 404
    with Session(db.get_engine()) as session:
        state = session.get(ResourceState, "next")
        state.status, state.ready = "published", False
        session.commit()
    assert parent.get("/api/episodes/e1/next", headers=headers).json() == {"episodeId": None}
    with Session(db.get_engine()) as session:
        session.get(ResourceState, "next").ready = True
        session.add(ResourceState(item_id="series", status="archived", ready=True))
        session.commit()
    assert parent.get("/api/episodes/e1/next", headers=headers).status_code == 404
