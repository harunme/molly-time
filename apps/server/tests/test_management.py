import datetime as dt
import hashlib
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401 -- shared isolated fixture

from molly_server import config, db
from molly_server.auth import hash_password, issue_access_token
from molly_server.management_models import ResourceState, WatchInterval, WatchSession
from molly_server.media_worker import run_once
from molly_server.models import Item, User


@pytest.fixture
def parent(client):  # noqa: F811 -- pytest fixture injection
    with Session(db.get_engine()) as session:
        user = session.get(User, "u1")
        user.password_hash = hash_password("test-parent")
        session.add_all(
            [
                Item(id="series", family_id="f1", type="Series", name="Stories"),
                Item(id="season", family_id="f1", type="Season", name="Season", parent_id="series"),
            ]
        )
        session.get(Item, "e1").parent_id = "season"
        session.commit()
    result = client.post(
        "/api/manage/auth/login", json={"username": "parent", "password": "test-parent"}
    )
    assert result.status_code == 200
    client.headers.pop("Authorization")
    client.headers["X-CSRF-Token"] = result.json()["csrfToken"]
    return client


def native_token():
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="admin")
    return {"Authorization": f"Bearer {token}"}


def event(seq=0, start=0, end=1000, played=1000, position=1000, **extra):
    return {
        "seq": seq,
        "startMs": start,
        "endMs": end,
        "playedMs": played,
        "positionMs": position,
        **extra,
    }


def watch(parent, child="c1"):
    result = parent.post(
        "/api/playback/sessions", headers=native_token(), json={"episodeId": "e1", "childId": child}
    )
    assert result.status_code == 200
    key = result.json()["sessionId"]
    with Session(db.get_engine()) as session:
        session.get(WatchSession, key).started_at = dt.datetime.now(dt.UTC) - dt.timedelta(
            seconds=10
        )
        session.commit()
    return key


def test_parent_cookie_csrf_and_origin(parent):
    assert parent.get("/api/manage/auth/session").status_code == 200
    assert (
        parent.post(
            "/api/manage/children", headers={"X-CSRF-Token": ""}, json={"name": "New"}
        ).status_code
        == 403
    )
    assert (
        parent.post(
            "/api/manage/children", headers={"Origin": "https://evil.test"}, json={"name": "New"}
        ).status_code
        == 403
    )
    assert parent.post("/api/manage/children", json={"name": "New"}).status_code == 200
    assert parent.post("/api/manage/auth/logout").status_code == 200
    assert parent.get("/api/manage/resources", headers=native_token()).status_code == 401


def test_local_origin_port_requires_independent_same_origin_evidence(parent):
    headers = {
        "Host": "127.0.0.1:8099",
        "Origin": "http://127.0.0.1",
        "Referer": "http://127.0.0.1:8099/manage/",
        "Sec-Fetch-Site": "same-origin",
    }
    credentials = {"username": "parent", "password": "test-parent"}
    path = "/api/manage/auth/login"
    assert parent.post(path, headers=headers, json=credentials).status_code == 200
    for change in [
        {"Origin": "http://127.0.0.1:8080"},
        {"Origin": "null"},
        {"Origin": "http://evil.test"},
        {"Origin": "http://127.0.0.1/forged"},
        {"Sec-Fetch-Site": "same-site"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": ""},
        {"Referer": "http://127.0.0.1/manage/"},
        {"Referer": ""},
        {"Referer": "http://["},
        {
            "Host": "example.test:8099",
            "Origin": "http://example.test",
            "Referer": "http://example.test:8099/manage/",
        },
    ]:
        assert parent.post(path, headers=headers | change, json=credentials).status_code == 403
    assert (
        parent.post(
            path, headers=headers | {"Origin": "http://127.0.0.1:8099"}, json=credentials
        ).status_code
        == 200
    )


def test_family_and_draft_media_isolation(parent):
    assert parent.get("/api/manage/resources/e2").status_code == 404
    assert parent.patch("/api/manage/children/c2", json={"name": "No"}).status_code == 404
    with Session(db.get_engine()) as session:
        session.add(ResourceState(item_id="e1", status="draft", ready=True))
        session.commit()
    assert parent.get("/api/episodes/e1").status_code == 200  # parent-cookie preview
    for path in [
        "/api/episodes/e1",
        "/api/episodes/e1/play",
        "/api/episodes/e1/subtitles/0",
        "/api/episodes/e1/progress",
    ]:
        assert parent.get(path, headers=native_token()).status_code == 404
    assert parent.get("/api/home", headers=native_token()).json()["rows"] == []
    assert parent.post("/api/manage/resources/e1/publish").status_code == 200
    assert parent.get("/api/episodes/e1/play", headers=native_token()).status_code == 200


@pytest.fixture(scope="session")
def mp4(tmp_path_factory):
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg is required for real media ingest verification")
    path = tmp_path_factory.mktemp("sample") / "sample.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:d=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-y",
            str(path),
        ],
        check=True,
        timeout=20,
    )
    return path.read_bytes()


def test_real_resumable_upload_process_preview_publish(parent, mp4):
    ep = parent.post(
        "/api/manage/resources",
        json={"type": "Episode", "name": "New episode", "parentId": "season"},
    ).json()["id"]
    result = parent.post(
        "/api/manage/uploads",
        json={
            "itemId": ep,
            "filename": "hello.mp4",
            "size": len(mp4),
            "fingerprint": "test",
            "kind": "video",
        },
    )
    assert result.status_code == 200
    key = result.json()["id"]
    first = mp4[:100]
    headers = {
        "X-Chunk-SHA256": hashlib.sha256(first).hexdigest(),
        "Content-Type": "application/octet-stream",
    }
    route = f"/api/manage/uploads/{key}/chunks?offset=0"
    assert parent.put(route, content=first, headers=headers).json()["offset"] == 100
    assert (
        parent.put(route, content=first, headers=headers).json()["offset"] == 100
    )  # lost ACK retry
    assert (
        parent.put(
            route,
            content=b"wrong",
            headers={**headers, "X-Chunk-SHA256": hashlib.sha256(b"wrong").hexdigest()},
        ).status_code
        == 409
    )
    assert parent.post(f"/api/manage/uploads/{key}/complete").status_code == 409
    rest = mp4[100:]
    assert (
        parent.put(
            f"/api/manage/uploads/{key}/chunks?offset=100",
            content=rest,
            headers={**headers, "X-Chunk-SHA256": hashlib.sha256(rest).hexdigest()},
        ).status_code
        == 200
    )
    assert parent.post(f"/api/manage/uploads/{key}/complete").status_code == 200
    assert parent.post(f"/api/manage/uploads/{key}/complete").status_code == 200
    assert run_once()
    assert parent.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"
    assert parent.get(f"/api/episodes/{ep}").json()["runtimeMs"] >= 900
    assert parent.get(f"/api/episodes/{ep}/play", headers=native_token()).status_code == 404
    assert parent.post(f"/api/manage/resources/{ep}/publish").status_code == 200
    assert parent.get(f"/api/episodes/{ep}/play", headers=native_token()).content == mp4
    assert parent.get(f"/api/items/{ep}/image", headers=native_token()).status_code == 200


def test_failed_processing_is_retryable_not_published(parent):
    row = parent.post(
        "/api/manage/uploads",
        json={
            "itemId": "e1",
            "filename": "broken.mp4",
            "size": 4,
            "fingerprint": "bad",
            "kind": "video",
        },
    ).json()
    parent.put(
        f"/api/manage/uploads/{row['id']}/chunks?offset=0",
        content=b"oops",
        headers={
            "X-Chunk-SHA256": hashlib.sha256(b"oops").hexdigest(),
            "Content-Type": "application/octet-stream",
        },
    )
    parent.post(f"/api/manage/uploads/{row['id']}/complete")
    run_once()
    failed = parent.get(f"/api/manage/uploads/{row['id']}").json()
    assert failed["status"] == "failed" and failed["error"]
    assert parent.post(f"/api/manage/tasks/{failed['taskId']}/retry").status_code == 200
    assert (
        parent.get("/api/episodes/e1/play", headers=native_token()).content == b"0123456789"
    )  # old media survives


def test_home_draft_publish_revision_and_child_inheritance(parent):
    content = {
        "schemaVersion": 1,
        "rows": [
            {
                "id": "stories",
                "title": "Sleep stories",
                "source": "manual",
                "itemIds": ["series"],
                "enabled": True,
                "limit": 12,
            }
        ],
    }
    route = "/api/manage/home-config"
    result = parent.put(route, json={"revision": 0, "content": content})
    assert result.status_code == 200
    assert (
        parent.get("/api/home", headers=native_token()).json()["rows"][0]["title"]
        != "Sleep stories"
    )
    assert parent.put(route, json={"revision": 0, "content": content}).status_code == 409
    assert parent.post(route + "/publish", json={"revision": 1}).status_code == 200
    assert (
        parent.get("/api/home", headers={**native_token(), "X-Molly-Child": "c1"}).json()["rows"][
            0
        ]["title"]
        == "Sleep stories"
    )
    assert (
        parent.put(route + "?childId=c2", json={"revision": 0, "content": content}).status_code
        == 404
    )
    child_content = {**content, "rows": [{**content["rows"][0], "title": "Child shelf"}]}
    parent.put(route + "?childId=c1", json={"revision": 0, "content": child_content})
    parent.post(route + "/publish?childId=c1", json={"revision": 1})
    assert (
        parent.get("/api/home", headers={**native_token(), "X-Molly-Child": "c1"}).json()["rows"][
            0
        ]["title"]
        == "Child shelf"
    )
    parent.delete(route + "?childId=c1")
    assert (
        parent.get("/api/home", headers={**native_token(), "X-Molly-Child": "c1"}).json()["rows"][
            0
        ]["title"]
        == "Sleep stories"
    )
    assert len(parent.get(route + "/revisions").json()) == 1


def test_watch_idempotency_pauses_seek_and_out_of_order(parent):
    key = watch(parent)
    route = f"/api/playback/sessions/{key}/events"
    headers = native_token()
    assert (
        parent.post(route, headers=headers, json=event(2, 2000, 3000, 1000, 90000)).status_code
        == 200
    )
    assert (
        parent.post(route, headers=headers, json=event(0, 0, 1000, 1000, 1000)).status_code == 200
    )
    assert (
        parent.post(route, headers=headers, json=event(1, 1000, 2000, 0, 90000)).status_code == 200
    )
    assert parent.post(route, headers=headers, json=event(2, 2000, 3000, 1000, 90000)).json()[
        "duplicate"
    ]
    assert (
        parent.post(route, headers=headers, json=event(2, 2000, 3000, 1000, 1)).status_code == 409
    )
    assert (
        parent.post(
            route, headers=headers, json=event(3, 3000, 3000, 0, 90000, stopped=True)
        ).status_code
        == 200
    )
    assert (
        parent.get("/api/episodes/e1/progress?childId=c1", headers=headers).json()["positionMs"]
        == 90000
    )
    day = dt.datetime.now(dt.UTC).astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
    report = parent.get(f"/api/manage/reports/watch-time?start={day}&end={day}&childId=c1").json()
    assert report["totalPlayedMs"] == 2000
    assert report["sessions"][0]["positionMs"] == 90000 and report["sessions"][0]["ended"]


def test_concurrent_overlap_is_rejected(parent):
    key = watch(parent)
    path = f"/api/playback/sessions/{key}/events"
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda seq: parent.post(path, headers=native_token(), json=event(seq)).status_code,
                [0, 1],
            )
        )
    assert sorted(results) == [200, 422]
    with Session(db.get_engine()) as session:
        assert session.query(WatchInterval).filter(WatchInterval.session_id == key).count() == 1


def test_cross_midnight_and_late_resume(parent):
    old = watch(parent)
    with Session(db.get_engine()) as session:
        session.get(WatchSession, old).started_at = dt.datetime(2026, 10, 10, 15, 59, 59, 500000)
        session.commit()
    path = f"/api/playback/sessions/{old}/events"
    parent.post(path, headers=native_token(), json=event(position=50000))
    newer = watch(parent)
    parent.post(
        f"/api/playback/sessions/{newer}/events", headers=native_token(), json=event(position=10000)
    )
    parent.post(path, headers=native_token(), json=event(1, 1000, 2000, 1000, 60000))
    assert (
        parent.get("/api/episodes/e1/progress?childId=c1", headers=native_token()).json()[
            "positionMs"
        ]
        == 10000
    )
    report = parent.get("/api/manage/reports/watch-time?start=2026-10-10&end=2026-10-11").json()
    assert [d["playedMs"] for d in report["days"]] == [500, 1500]
    assert report["totalPlayedMs"] == 2000


def test_device_revocation_refresh_and_management_boundary(parent):
    auth = parent.post(
        "/api/auth/login",
        headers={"X-Molly-Client": "tv-shell/2"},
        json={"username": "parent", "password": "test-parent"},
    ).json()
    device = auth["deviceId"]
    token = {"Authorization": "Bearer " + auth["accessToken"]}
    assert parent.get("/api/home", headers=token).status_code == 200
    assert parent.post(f"/api/manage/devices/{device}/revoke").status_code == 200
    assert parent.get("/api/home", headers=token).status_code == 401
    assert (
        parent.post("/api/auth/refresh", json={"refreshToken": auth["refreshToken"]}).status_code
        == 401
    )
    parent.cookies.clear()
    assert parent.get("/api/manage/resources", headers=token).status_code == 401


def test_member_can_read_and_logout_but_cannot_edit(parent):
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        session.commit()
    assert parent.get("/api/manage/resources").status_code == 200
    assert parent.post("/api/manage/children", json={"name": "No"}).status_code == 403
    assert parent.post("/api/manage/auth/logout").status_code == 200


def test_schema_additive_and_repeatable(parent):
    db.init_db()
    db.init_db()
    assert parent.get("/api/episodes/e1/play", headers=native_token()).content == b"0123456789"
    assert config.get_settings().data_dir.exists()


def test_new_scan_is_draft_and_repeat_scan_keeps_publication(parent, mp4, tmp_path):
    from molly_server.scripts.scan_bbkt import _scan_episode

    folder = tmp_path / "ImportedEpisode"
    folder.mkdir()
    (folder / "video.mp4").write_bytes(mp4)
    with Session(db.get_engine()) as session:
        series, season = session.get(Item, "series"), session.get(Item, "season")
        episode = _scan_episode(session, folder, series, season, "f1")
        session.commit()
        key = episode.id
        state = session.get(ResourceState, key)
        assert state.status == "draft" and state.ready
    assert parent.get(f"/api/episodes/{key}/play", headers=native_token()).status_code == 404
    assert parent.post(f"/api/manage/resources/{key}/publish").status_code == 200
    with Session(db.get_engine()) as session:
        _scan_episode(
            session, folder, session.get(Item, "series"), session.get(Item, "season"), "f1"
        )
        session.commit()
        assert session.get(ResourceState, key).status == "published"
    assert parent.get(f"/api/episodes/{key}/play", headers=native_token()).content == mp4


def test_cover_replacement_changes_image_reference(parent):
    import io

    from PIL import Image

    versions = []
    for color in ["red", "green"]:
        content = io.BytesIO()
        Image.new("RGB", (32, 32), color).save(content, "PNG")
        data = content.getvalue()
        row = parent.post(
            "/api/manage/uploads",
            json={
                "itemId": "series",
                "filename": "cover.png",
                "size": len(data),
                "fingerprint": color,
                "kind": "image",
            },
        ).json()
        assert (
            parent.put(
                f"/api/manage/uploads/{row['id']}/chunks?offset=0",
                content=data,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Chunk-SHA256": hashlib.sha256(data).hexdigest(),
                },
            ).status_code
            == 200
        )
        parent.post(f"/api/manage/uploads/{row['id']}/complete")
        assert run_once()
        url = parent.get("/api/manage/resources/series").json()["imageUrl"]
        assert parent.get(url).status_code == 200
        versions.append(url)
    assert versions[0] != versions[1]
