# ruff: noqa: F811 -- pytest fixtures share parameter names
import datetime as dt

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session
from test_management import event, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.auth import issue_access_token
from mollytime_server.device_presence import device_online
from mollytime_server.management_models import (
    Device,
    DeviceReminder,
    FamilyReminders,
    ResourceState,
    WatchInterval,
    WatchSession,
)
from mollytime_server.models import Item, MediaFile


def seed(parent):
    with Session(db.get_engine()) as session:
        session.add_all(
            [
                Device(id="tv1", family_id="f1", user_id="u1", name="客厅"),
                Device(id="tv2", family_id="f1", user_id="u1", name="卧室"),
            ]
        )
        session.add(
            Item(id="other", family_id="f1", type="Episode", name="Other", parent_id="season")
        )
        session.add(
            MediaFile(
                id="other-media",
                family_id="f1",
                item_id="other",
                kind="video",
                storage="local",
                path="video.mp4",
            )
        )
        session.commit()
    for kind in ["warning", "farewell"]:
        response = parent.post(f"/api/manage/reminders/{kind}/upload-target")
        assert response.status_code == 200
        item_id = response.json()["itemId"]
        with Session(db.get_engine()) as session:
            session.add(
                MediaFile(
                    id=f"clip-{kind}",
                    family_id="f1",
                    item_id=item_id,
                    kind="video",
                    storage="local",
                    path="video.mp4",
                )
            )
            session.get(ResourceState, item_id).ready = True
            session.commit()
    return headers("tv1"), headers("tv2")


def headers(device):
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="device", device_id=device)
    return {"Authorization": f"Bearer {token}"}


def start(parent, tv, episode="e1"):
    response = parent.post(
        "/api/playback/sessions", headers=tv, json={"episodeId": episode, "childId": "c1"}
    )
    assert response.status_code == 200
    return response.json()["sessionId"]


def test_current_watch_uses_actual_played_time_and_expires(parent):
    tv, _ = seed(parent)
    session_id = start(parent, tv)
    with Session(db.get_engine()) as session:
        session.add_all([
            WatchInterval(session_id=session_id, seq=0, start_ms=0, end_ms=60000,
                          played_ms=60000, position_ms=900000),
            WatchInterval(session_id=session_id, seq=1, start_ms=60000, end_ms=90000,
                          played_ms=0, position_ms=900000),
        ])
        session.get(WatchSession, session_id).last_reported_at = dt.datetime.now(dt.UTC)
        session.commit()

    def current():
        return {row["id"]: row["currentWatch"] for row in
                parent.get("/api/manage/reminders/devices").json()}

    watch = current()
    assert watch["tv1"] == {"sessionId": session_id, "name": "One", "playedMs": 60000}
    assert watch["tv2"] is None
    with Session(db.get_engine()) as session:
        session.get(WatchSession, session_id).last_reported_at = (
            dt.datetime.now(dt.UTC) - dt.timedelta(seconds=46))
        session.commit()
    assert current()["tv1"] is None
    with Session(db.get_engine()) as session:
        row = session.get(WatchSession, session_id)
        row.last_reported_at = dt.datetime.now(dt.UTC)
        row.ended = True
        session.commit()
    assert current()["tv1"] is None


def test_boot_watch_time_survives_episode_changes_and_resets_only_on_reboot(parent):
    tv, _ = seed(parent)
    boot_headers = {**tv, "X-Molly-Boot-Id": "android:5",
                    "X-Molly-Boot-Elapsed-Ms": "600000"}
    assert parent.get("/api/me", headers=boot_headers).status_code == 200
    at = dt.datetime.now(dt.UTC)
    with Session(db.get_engine()) as session:
        for key, minutes, played, purpose, device in [
            ("previous-boot", 20, 60000, "family_watch", "tv1"),
            ("first-episode", 5, 60000, "family_watch", "tv1"),
            ("second-episode", 2, 30000, "family_watch", "tv1"),
            ("paused", 1, 0, "family_watch", "tv1"),
            ("other-device", 1, 60000, "family_watch", "tv2"),
            ("parent-preview", 1, 60000, "parent_preview", None),
        ]:
            session.add(WatchSession(id=key, family_id="f1", user_id="u1", device_id=device,
                item_id="e1", item_name="One", purpose=purpose,
                started_at=at - dt.timedelta(minutes=minutes), ended=True))
            session.flush()
            session.add(WatchInterval(session_id=key, seq=0, start_ms=0, end_ms=60000,
                played_ms=played, position_ms=900000))
        session.commit()

    def devices():
        return {row["id"]: row for row in
                parent.get("/api/manage/reminders/devices").json()}

    assert devices()["tv1"]["bootPlayedMs"] == 90000
    assert devices()["tv1"]["bootId"] == "android:5"
    assert devices()["tv1"]["currentWatch"] is None
    assert devices()["tv2"]["bootPlayedMs"] is None
    # Same boot: restarting the app or refreshing credentials cannot clear totals.
    parent.get("/api/me", headers={**boot_headers, "X-Molly-Boot-Elapsed-Ms": "1"})
    assert devices()["tv1"]["bootPlayedMs"] == 90000
    # A genuinely newer boot boundary excludes every earlier playback session.
    parent.get("/api/me", headers={**boot_headers, "X-Molly-Boot-Id": "android:6",
                                  "X-Molly-Boot-Elapsed-Ms": "0"})
    assert devices()["tv1"]["bootPlayedMs"] == 0
    assert devices()["tv1"]["bootId"] == "android:6"
    with Session(db.get_engine()) as session:
        old = session.get(WatchSession, "paused")
        old.ended = False
        old.last_reported_at = dt.datetime.now(dt.UTC)
        session.commit()
    assert devices()["tv1"]["currentWatch"] is None
    # Delayed reports from an older boot cannot roll the boundary back.
    parent.get("/api/me", headers=boot_headers)
    assert devices()["tv1"]["bootPlayedMs"] == 0


def test_reminder_clips_stay_out_of_resource_library(parent):
    seed(parent)
    with Session(db.get_engine()) as session:
        reminders = session.get(FamilyReminders, "f1")
        folder_id = reminders.folder_id
        clip_ids = {reminders.warning_id, reminders.farewell_id}

    listing = parent.get("/api/manage/resources", params={"page": 1, "pageSize": 1}).json()
    assert listing["total"] == 1
    assert [item["id"] for item in listing["items"]] == ["series"]
    assert parent.get("/api/manage/resources", params={"q": "家长提醒"}).json() == []
    assert parent.get("/api/manage/resources", params={"summary": "true"}).json()[0]["id"] == "series"
    assert parent.get("/api/manage/resources", params={"ids": folder_id}).json() == []
    assert parent.get("/api/manage/resources", params={"parentId": folder_id}).status_code == 404
    assert parent.get(f"/api/manage/folders/{folder_id}/videos").status_code == 404
    assert parent.get("/api/manage/resources/stats").json()["folderCount"] == 1
    assert parent.get("/api/manage/resources/stats").json()["videoCount"] == 2
    assert all(parent.get("/api/manage/resources", params={"ids": clip_id}).json() == [] for clip_id in clip_ids)
    assert parent.get("/api/manage/reminders").json()["warning"]["ready"] is True


def test_active_episode_reminder_stops_next_and_replay_until_parent_restores(parent):
    tv, other_tv = seed(parent)
    sid = start(parent, tv)
    response = parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"})
    assert response.status_code == 200
    state = response.json()
    assert state["episodeId"] == "e1" and state["phase"] == "pending"
    assert (
        parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"}).status_code == 409
    )
    assert parent.get("/api/reminders/state", headers=other_tv).json()["phase"] == "idle"
    assert (
        parent.post(
            f"/api/reminders/requests/{state['requestId']}/ack", headers=other_tv
        ).status_code
        == 404
    )
    assert (
        parent.post(f"/api/reminders/requests/{state['requestId']}/ack", headers=tv).json()["phase"]
        == "watching"
    )
    assert (
        parent.post("/api/playback/sessions", headers=tv, json={"episodeId": "other"}).status_code
        == 403
    )
    assert parent.get("/api/episodes/other/play", headers=tv).status_code == 403
    assert (
        parent.post(
            f"/api/playback/sessions/{sid}/events",
            headers=tv,
            json=event(end=0, played=0, completed=True, stopped=True),
        ).status_code
        == 200
    )
    assert parent.get("/api/reminders/state", headers=tv).json()["phase"] == "done"
    for episode in ["e1", "other"]:
        assert (
            parent.post(
                "/api/playback/sessions", headers=tv, json={"episodeId": episode}
            ).status_code
            == 403
        )
        assert parent.get(f"/api/episodes/{episode}/play", headers=tv).status_code == 403
    assert parent.get("/api/reminders/farewell/play", headers=tv).status_code == 200
    assert parent.delete("/api/manage/reminders/devices/tv1").status_code == 200
    assert parent.get("/api/reminders/state", headers=tv).json()["phase"] == "idle"
    start(parent, tv, "other")


def test_idle_tv_gets_exactly_the_next_episode_and_request_survives_restart(parent):
    tv, _ = seed(parent)
    result = parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"}).json()
    assert result["episodeId"] is None
    sid = start(parent, tv, "other")
    assert parent.get("/api/reminders/state", headers=tv).json()["episodeId"] == "other"
    assert (
        parent.post(
            f"/api/playback/sessions/{sid}/events",
            headers=tv,
            json=event(end=0, played=0, stopped=True),
        ).status_code
        == 200
    )
    start(parent, tv, "other")  # Exit before completion may resume the same last episode.
    assert (
        parent.post("/api/playback/sessions", headers=tv, json={"episodeId": "e1"}).status_code
        == 403
    )
    with Session(db.get_engine()) as session:
        row = session.get(DeviceReminder, "tv1")
        assert row.episode_id == "other" and row.request_id == result["requestId"]


def test_stale_session_does_not_choose_an_old_last_episode(parent):
    tv, _ = seed(parent)
    sid = start(parent, tv)
    with Session(db.get_engine()) as session:
        session.get(WatchSession, sid).started_at = dt.datetime.now(dt.UTC) - dt.timedelta(hours=1)
        session.commit()
    result = parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"}).json()
    assert result["episodeId"] is None
    start(parent, tv, "other")


def test_private_recordings_preview_range_and_no_watch_sessions(parent):
    tv, _ = seed(parent)
    settings = parent.get("/api/manage/reminders").json()
    assert settings["warning"]["ready"] and settings["farewell"]["ready"]
    warning = settings["warning"]["itemId"]
    assert parent.get(f"/api/episodes/{warning}", headers=tv).status_code == 404
    assert (
        parent.post("/api/playback/sessions", headers=tv, json={"episodeId": warning}).status_code
        == 404
    )
    assert parent.get("/api/reminders/warning/play").content == b"0123456789"
    assert parent.get("/api/reminders/warning/playback", headers=tv).status_code == 404
    parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"})
    info = parent.get("/api/reminders/warning/playback", headers=tv).json()
    assert info["url"] == "/api/reminders/warning/play" and info["subtitles"] == []
    response = parent.get(info["url"], headers={**tv, "Range": "bytes=2-5"})
    assert response.status_code == 206 and response.content == b"2345"
    with Session(db.get_engine()) as session:
        assert session.query(WatchSession).count() == 0


def test_delayed_completion_of_an_old_session_cannot_finish_the_new_last_episode(parent):
    tv, _ = seed(parent)
    old_session = start(parent, tv)
    parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"})
    current_session = start(parent, tv)
    completion = event(end=0, played=0, completed=True, stopped=True)
    assert (
        parent.post(
            f"/api/playback/sessions/{old_session}/events", headers=tv, json=completion
        ).status_code
        == 200
    )
    assert parent.get("/api/reminders/state", headers=tv).json()["phase"] == "pending"
    assert (
        parent.post(
            f"/api/playback/sessions/{current_session}/events", headers=tv, json=completion
        ).status_code
        == 200
    )
    assert parent.get("/api/reminders/state", headers=tv).json()["phase"] == "done"


def test_authorization_csrf_readiness_and_other_family(parent):
    tv, _ = seed(parent)
    path = "/api/manage/reminders/requests"
    assert (
        parent.post(path, json={"deviceId": "tv1"}, headers={"X-CSRF-Token": "wrong"}).status_code
        == 403
    )
    assert parent.post(path, json={"deviceId": "missing"}).status_code == 404
    with Session(db.get_engine()) as session:
        session.get(Device, "tv2").family_id = "f2"
        session.get(
            ResourceState, parent.get("/api/manage/reminders").json()["warning"]["itemId"]
        ).ready = False
        session.commit()
    assert parent.post(path, json={"deviceId": "tv2"}).status_code == 404
    assert parent.post(path, json={"deviceId": "tv1"}).status_code == 422
    parent.cookies.clear()
    assert parent.post(path, json={"deviceId": "tv1"}, headers=tv).status_code == 401


def test_upgrade_old_reminder_table_preserves_requests_and_binds_active_session(parent):
    tv, _ = seed(parent)
    sid = start(parent, tv)
    engine = db.get_engine()
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE device_reminders")
        connection.exec_driver_sql("""
            CREATE TABLE device_reminders (
                device_id VARCHAR(36) PRIMARY KEY REFERENCES devices(id),
                family_id VARCHAR(36) NOT NULL REFERENCES families(id),
                request_id VARCHAR(36) NOT NULL,
                episode_id VARCHAR(36) REFERENCES items(id),
                phase VARCHAR(16) NOT NULL
            )
        """)
        connection.exec_driver_sql("""
            INSERT INTO device_reminders VALUES
                ('tv1', 'f1', 'existing-request', 'e1', 'watching'),
                ('tv2', 'f1', 'completed-request', 'other', 'done')
        """)
        before = connection.execute(text("SELECT * FROM device_reminders ORDER BY device_id")).all()
    assert "session_id" not in {
        column["name"] for column in inspect(engine).get_columns("device_reminders")
    }

    db.init_db()
    db.init_db()

    with engine.connect() as connection:
        after = connection.execute(
            text(
                "SELECT device_id, family_id, request_id, episode_id, phase "
                "FROM device_reminders ORDER BY device_id"
            )
        ).all()
        assert after == before
    with Session(engine) as session:
        assert session.get(DeviceReminder, "tv1").session_id == sid
        assert session.get(DeviceReminder, "tv2").session_id is None
        assert session.query(MediaFile).count() == 6
    foreign_keys = inspect(engine).get_foreign_keys("device_reminders")
    assert any(
        key["constrained_columns"] == ["session_id"] and key["referred_table"] == "watch_sessions"
        for key in foreign_keys
    )
    response = parent.get("/api/manage/reminders/devices")
    assert response.status_code == 200
    assert (
        next(device for device in response.json() if device["id"] == "tv1")["phase"] == "watching"
    )
    assert (
        parent.post(
            f"/api/playback/sessions/{sid}/events",
            headers=tv,
            json=event(end=0, played=0, completed=True, stopped=True),
        ).status_code
        == 200
    )
    assert parent.get("/api/reminders/state", headers=tv).json()["phase"] == "done"


def test_offline_devices_sort_last_and_parent_views_cannot_mark_them_online(parent):
    seed(parent)
    old = dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
    with Session(db.get_engine()) as session:
        session.get(Device, "tv1").last_seen = old
        session.commit()
    devices = parent.get("/api/manage/reminders/devices").json()
    assert [device["id"] for device in devices] == ["tv2", "tv1"]
    assert [device["online"] for device in devices] == [True, False]
    assert devices[1]["lastSeen"] == old.isoformat()
    assert parent.get("/api/me").status_code == 200
    response = parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"})
    assert response.status_code == 409 and "离线" in response.json()["detail"]
    with Session(db.get_engine()) as session:
        assert session.get(DeviceReminder, "tv1") is None
        assert session.get(Device, "tv1").last_seen == old.replace(tzinfo=None)


def test_idle_device_heartbeat_restores_presence_without_creating_watch_history(parent):
    tv, _ = seed(parent)
    old = dt.datetime.now(dt.UTC) - dt.timedelta(hours=1)
    with Session(db.get_engine()) as session:
        for device in session.query(Device):
            device.last_seen = old
        session.commit()
    assert parent.get("/api/me", headers=tv).status_code == 200
    devices = {
        device["id"]: device for device in parent.get("/api/manage/reminders/devices").json()
    }
    assert devices["tv1"]["online"] and not devices["tv2"]["online"]
    assert (
        parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"}).status_code == 200
    )
    with Session(db.get_engine()) as session:
        assert session.query(WatchSession).count() == 0
        session.get(Device, "tv1").revoked = True
        session.get(Device, "tv1").last_seen = old
        session.commit()
    assert parent.get("/api/me", headers=tv).status_code == 401
    with Session(db.get_engine()) as session:
        assert session.get(Device, "tv1").last_seen == old.replace(tzinfo=None)


def test_presence_is_rechecked_when_sending_but_offline_restore_is_allowed(parent):
    seed(parent)
    assert next(
        device
        for device in parent.get("/api/manage/reminders/devices").json()
        if device["id"] == "tv1"
    )["online"]
    with Session(db.get_engine()) as session:
        device = session.get(Device, "tv1")
        device.last_seen = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=91)
        session.commit()
    assert (
        parent.post("/api/manage/reminders/requests", json={"deviceId": "tv1"}).status_code == 409
    )
    with Session(db.get_engine()) as session:
        assert session.get(DeviceReminder, "tv1") is None
        session.add(DeviceReminder(device_id="tv1", family_id="f1", phase="done"))
        session.commit()
    assert parent.delete("/api/manage/reminders/devices/tv1").status_code == 200


@pytest.mark.parametrize(
    "age, online", [(0, True), (89, True), (90, True), (91, False), (-1, False)]
)
def test_online_threshold_is_deterministic_and_normalizes_sqlite_dates(age, online):
    at = dt.datetime(2026, 10, 13, 12, tzinfo=dt.UTC)
    device = Device(last_seen=(at - dt.timedelta(seconds=age)).replace(tzinfo=None), revoked=False)
    assert device_online(device, at) is online
    device.revoked = True
    assert not device_online(device, at)
