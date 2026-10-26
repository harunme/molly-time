# ruff: noqa: F811
import datetime as dt
import uuid

import pytest
from sqlalchemy.orm import Session
from test_management import event, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db, watch_control
from mollytime_server.auth import issue_access_token
from mollytime_server.management_models import Device, WatchControlPin, WatchSession
from mollytime_server.models import Item, MediaFile


@pytest.fixture(autouse=True)
def quota_clock(monkeypatch):
    clock = [dt.datetime(2026, 10, 26, 12, tzinfo=watch_control.QUOTA_TIMEZONE)]
    monkeypatch.setattr(watch_control, "quota_now", lambda: clock[0])
    return clock


@pytest.fixture
def setup(parent):
    with Session(db.get_engine()) as session:
        session.add_all(
            [
                Device(id="tv1", family_id="f1", user_id="u1", name="客厅"),
                Device(id="tv2", family_id="f1", user_id="u1", name="卧室"),
            ]
        )
        session.get(Item, "e1").index_number = 1
        for index in (2, 3):
            session.add(
                Item(
                    id=f"ep{index}",
                    family_id="f1",
                    type="Episode",
                    name=f"Episode {index}",
                    index_number=index,
                    parent_id="season",
                )
            )
            session.add(
                MediaFile(
                    id=f"media{index}",
                    family_id="f1",
                    item_id=f"ep{index}",
                    kind="video",
                    storage="local",
                    path="video.mp4",
                )
            )
        session.commit()
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="device", device_id="tv1")
    headers = {"Authorization": "Bearer " + token}
    assert parent.post("/api/watch-control/sync", headers=headers, json={}).status_code == 200
    assert parent.put("/api/manage/watch-control/pin", json={"pin": "1234"}).status_code == 200
    return parent, headers


def state(client, headers):
    return client.get("/api/watch-control", headers=headers).json()


def command(client, headers, action, **extra):
    current = state(client, headers)
    return client.post(
        "/api/manage/watch-control/tv1/commands",
        json={
            "action": action,
            "version": current["version"],
            "requestId": str(uuid.uuid4()),
            **extra,
        },
    )


def enable(client, headers, mode="episodes", amount=2):
    response = command(client, headers, "settings", enabled=True, mode=mode, amount=amount)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "allowed"
    return response.json()


def start(client, headers, episode="e1"):
    return client.post("/api/playback/sessions", headers=headers, json={"episodeId": episode})


def finish(client, headers, session_id):
    with Session(db.get_engine()) as session:
        session.get(WatchSession, session_id).started_at = dt.datetime.now(dt.UTC) - dt.timedelta(
            seconds=3
        )
        session.commit()
    response = client.post(
        f"/api/playback/sessions/{session_id}/events",
        headers=headers,
        json=event(completed=True, stopped=True),
    )
    assert response.status_code == 200, response.text
    return response


def test_starting_a_video_consumes_a_slot_and_resume_never_recharges(setup):
    client, headers = setup
    enable(client, headers)
    first = start(client, headers).json()["sessionId"]
    assert state(client, headers)["round"]["remainingEpisodes"] == 1
    assert start(client, headers).status_code == 200
    assert state(client, headers)["round"]["remainingEpisodes"] == 1
    switched = start(client, headers, "ep3").json()["sessionId"]
    assert state(client, headers)["round"]["cursor"] == 1
    assert state(client, headers)["round"]["remainingEpisodes"] == 0
    assert start(client, headers, "ep2").status_code == 403
    assert state(client, headers)["round"]["episodeId"] == "ep3"
    assert start(client, headers, "ep3").status_code == 200  # last video can still resume
    finish(client, headers, first)  # late completion cannot charge the new slot
    assert state(client, headers)["round"]["cursor"] == 1
    finish(client, headers, switched)
    assert state(client, headers)["status"] == "resting"
    assert client.get("/api/episodes/ep2/playback", headers=headers).status_code == 403
    assert command(client, headers, "add").status_code == 200
    assert state(client, headers)["round"]["remainingEpisodes"] == 1
    assert start(client, headers, "ep2").status_code == 200
    assert state(client, headers)["round"]["remainingEpisodes"] == 0


def test_offline_started_video_sync_does_not_restore_or_replace_slots(setup):
    client, headers = setup
    enable(client, headers)
    current = state(client, headers)
    body = {"roundId": current["round"]["id"], "cursor": 1, "episodeId": "ep2"}
    response = client.post("/api/watch-control/sync", headers=headers, json=body).json()
    assert response["round"]["remainingEpisodes"] == 0
    assert response["round"]["episodeId"] == "ep2"
    assert start(client, headers, "ep2").status_code == 200
    for snapshot in ({**body, "cursor": 0, "episodeId": "e1"}, {**body, "episodeId": "ep3"}):
        client.post("/api/watch-control/sync", headers=headers, json=snapshot)
        assert state(client, headers)["round"]["episodeId"] == "ep2"
        assert state(client, headers)["round"]["remainingEpisodes"] == 0
    assert start(client, headers, "e1").status_code == 403


def test_tv_start_sets_daily_rule_without_resetting_existing_allowance(setup):
    client, headers = setup
    current = state(client, headers)
    body = {
        "action": "start",
        "mode": "minutes",
        "amount": 15,
        "version": current["version"],
        "requestId": str(uuid.uuid4()),
        "pin": "1234",
    }
    wrong = client.post(
        "/api/watch-control/commands", headers=headers, json={**body, "pin": "0000"}
    )
    assert wrong.status_code == 403
    assert state(client, headers)["enabled"] is False
    result = client.post("/api/watch-control/commands", headers=headers, json=body)
    assert result.status_code == 200, result.text
    allowed = result.json()
    assert allowed["enabled"] and allowed["status"] == "allowed"
    assert allowed["amount"] == 15 and allowed["mode"] == "minutes"
    assert allowed["round"]["remainingMs"] == 900000
    duplicate = client.post("/api/watch-control/commands", headers=headers, json=body)
    assert duplicate.json()["round"]["id"] == allowed["round"]["id"]
    # Even the legacy start command cannot reset today; changes apply tomorrow.
    body.update(mode="episodes", amount=1, version=allowed["version"], requestId=str(uuid.uuid4()))
    next_round = client.post("/api/watch-control/commands", headers=headers, json=body).json()
    assert next_round["round"]["id"] == allowed["round"]["id"]
    assert next_round["mode"] == "episodes" and next_round["amount"] == 1
    completed = start(client, headers, "ep3").json()["sessionId"]
    finish(client, headers, completed)
    assert state(client, headers)["status"] == "allowed"
    assert next_round["round"]["mode"] == "minutes"


def test_time_pause_duplicate_and_late_old_round(setup, quota_clock):
    client, headers = setup
    original = enable(client, headers, "minutes", 1)
    round_id = original["round"]["id"]
    snapshot = {"roundId": round_id, "playedMs": 45000, "acknowledged": original["version"]}
    for _ in range(2):
        result = client.post("/api/watch-control/sync", headers=headers, json=snapshot)
        assert result.json()["round"]["remainingMs"] == 15000
    assert start(client, headers, "ep2").status_code == 200
    assert command(client, headers, "stop").status_code == 200
    assert start(client, headers).status_code == 403
    added = command(client, headers, "add").json()
    assert added["round"]["remainingMs"] == 600000
    assert command(client, headers, "reselect").status_code == 409
    quota_clock[0] += dt.timedelta(days=1)
    current = state(client, headers)
    client.post("/api/watch-control/sync", headers=headers, json={**snapshot, "playedMs": 9999999})
    assert state(client, headers)["round"]["id"] == current["round"]["id"]
    assert state(client, headers)["round"]["remainingMs"] == 60000


def test_idempotency_versions_device_isolation_and_legacy_bypass(setup):
    client, headers = setup
    enable(client, headers, "minutes")
    before = state(client, headers)
    body = {"action": "add", "version": before["version"], "requestId": str(uuid.uuid4())}
    first = client.post("/api/manage/watch-control/tv1/commands", json=body)
    second = client.post("/api/manage/watch-control/tv1/commands", json=body)
    assert first.json() == second.json()
    assert first.json()["round"]["amount"] == 12
    assert (
        client.post(
            "/api/manage/watch-control/tv1/commands", json={**body, "action": "stop"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/manage/watch-control/tv1/commands", json={**body, "requestId": str(uuid.uuid4())}
        ).status_code
        == 409
    )
    assert client.delete("/api/manage/reminders/devices/tv1").status_code == 409
    assert (
        client.post("/api/manage/reminders/requests", json={"deviceId": "tv1"}).status_code == 409
    )
    devices = client.get("/api/manage/watch-control").json()["devices"]
    assert next(d for d in devices if d["deviceId"] == "tv2")["enabled"] is False
    assert command(client, headers, "settings", mode="episodes", amount=3).status_code == 200
    assert state(client, headers)["round"]["mode"] == "minutes"


def test_pin_lockout_and_reset(setup):
    client, headers = setup
    enable(client, headers)
    body = {
        "action": "stop",
        "version": state(client, headers)["version"],
        "requestId": str(uuid.uuid4()),
        "pin": "0000",
    }
    for index in range(5):
        response = client.post("/api/watch-control/commands", headers=headers, json=body)
        assert response.status_code == (429 if index == 4 else 403)
    assert (
        client.post(
            "/api/watch-control/commands", headers=headers, json={**body, "pin": "1234"}
        ).status_code
        == 429
    )
    assert client.put("/api/manage/watch-control/pin", json={"pin": "4321"}).status_code == 200
    assert (
        client.post(
            "/api/watch-control/commands", headers=headers, json={**body, "pin": "4321"}
        ).status_code
        == 200
    )
    with Session(db.get_engine()) as session:
        assert "4321" not in session.get(WatchControlPin, "f1").password_hash
    assert (
        client.post("/api/watch-control/pin", headers=headers, json={"pin": "5678"}).status_code
        == 409
    )


def test_configuration_does_not_require_capability_and_permissions_still_apply(setup):
    client, headers = setup
    body = {"action": "settings", "version": 0, "requestId": str(uuid.uuid4()), "enabled": True}
    assert client.post("/api/manage/watch-control/tv2/commands", json=body).status_code == 200
    assert client.get("/api/watch-control").status_code == 403
    client.cookies.clear()
    assert (
        client.post(
            "/api/manage/watch-control/tv1/commands", headers=headers, json=body
        ).status_code
        == 401
    )


def test_offline_completion_and_time_exhaustion(setup, quota_clock):
    client, headers = setup
    enable(client, headers)
    start(client, headers)
    current = state(client, headers)
    result = client.post(
        "/api/watch-control/sync",
        headers=headers,
        json={"roundId": current["round"]["id"], "cursor": 2},
    )
    assert result.json()["status"] == "resting"
    assert start(client, headers).status_code == 403
    command(client, headers, "settings", mode="minutes", amount=1)
    quota_clock[0] += dt.timedelta(days=1)
    current = state(client, headers)
    result = client.post(
        "/api/watch-control/sync",
        headers=headers,
        json={"roundId": current["round"]["id"], "playedMs": 60000},
    )
    assert result.json()["status"] == "resting"
    assert start(client, headers).status_code == 403


def test_optional_clips_and_live_policy(setup, quota_clock):
    from mollytime_server.management_models import FamilyReminders, LiveTvSettings, ResourceState

    client, headers = setup
    with Session(db.get_engine()) as session:
        session.add(
            LiveTvSettings(
                id="platform",
                enabled=True,
                channels=[
                    {"id": "a" * 32, "name": "Channel", "url": "https://stream.test/live.m3u8"}
                ],
            )
        )
        session.add(
            Item(id="clip", family_id="f1", type="Episode", name="休息提醒", parent_id="season")
        )
        session.flush()
        session.add(ResourceState(item_id="clip", status="draft", ready=True))
        session.add(
            MediaFile(
                id="clip-media",
                family_id="f1",
                item_id="clip",
                kind="video",
                storage="local",
                path="video.mp4",
            )
        )
        session.flush()
        session.add(FamilyReminders(family_id="f1", enabled=False, farewell_id="clip"))
        session.commit()
    enable(client, headers)
    assert state(client, headers)["farewellPath"] == "/api/reminders/farewell/playback"
    assert client.get("/api/reminders/farewell/playback", headers=headers).status_code == 200
    live_path = "/api/live-tv/channels/" + "a" * 32 + "/sessions"
    assert client.post(live_path, headers=headers).status_code == 403
    assert (
        client.get("/api/episodes/e1/playback", headers=headers).status_code == 403
    )  # a playback session reserves a slot before streaming
    command(client, headers, "settings", mode="minutes", amount=1)
    quota_clock[0] += dt.timedelta(days=1)
    assert client.post(live_path, headers=headers).status_code == 200
    current = state(client, headers)
    client.post(
        "/api/watch-control/sync",
        headers=headers,
        json={"roundId": current["round"]["id"], "playedMs": 60000},
    )
    assert client.post(live_path, headers=headers).status_code == 403


def test_offline_unseen_device_keeps_configuration_until_capable_client_acknowledges(setup):
    client, _ = setup
    with Session(db.get_engine()) as session:
        session.get(Device, "tv2").last_seen = dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
        session.commit()
    version = 0

    def send(action, **fields):
        nonlocal version
        response = client.post(
            "/api/manage/watch-control/tv2/commands",
            json={
                "requestId": str(uuid.uuid4()),
                "version": version,
                "action": action,
                **fields,
            },
        )
        assert response.status_code == 200, response.text
        result = response.json()
        version = result["version"]
        return result

    configured = send("settings", enabled=True, mode="minutes", amount=30)
    assert configured["supported"] is False and configured["acknowledged"] == 0
    assert configured["enabled"] is True
    send("settings", enabled=True, mode="minutes", amount=45)
    added = send("add")
    assert added["round"]["remainingMs"] == 40 * 60000
    saved = next(
        d
        for d in client.get("/api/manage/watch-control").json()["devices"]
        if d["deviceId"] == "tv2"
    )
    assert saved["online"] is False and saved["mode"] == "minutes" and saved["amount"] == 45
    assert saved["version"] == version and saved["acknowledged"] == 0
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="device", device_id="tv2")
    headers = {"Authorization": "Bearer " + token}
    response = client.post(
        "/api/watch-control/sync",
        headers=headers,
        json={"supported": False, "acknowledged": version},
    )
    assert response.json()["acknowledged"] == 0
    response = client.post("/api/watch-control/sync", headers=headers, json={"supported": True})
    assert response.json()["round"]["id"] == saved["round"]["id"]
    assert response.json()["acknowledged"] == 0  # Receiving the rule alone is not confirmation.
    response = client.post(
        "/api/watch-control/sync",
        headers=headers,
        json={"supported": True, "acknowledged": version},
    )
    assert response.json()["acknowledged"] == version


@pytest.mark.parametrize("mode,amount", [("episodes", 2), ("minutes", 30)])
def test_midnight_refreshes_once_without_pin_and_discards_bonus(setup, quota_clock, mode, amount):
    client, headers = setup
    quota_clock[0] = quota_clock[0].replace(hour=23, minute=59, second=59)
    original = enable(client, headers, mode, amount)
    command(client, headers, "add")
    command(client, headers, "stop")
    assert state(client, headers)["status"] == "resting"
    for _ in range(3):
        assert state(client, headers)["round"]["id"] == original["round"]["id"]
    quota_clock[0] += dt.timedelta(seconds=1)
    fresh = state(client, headers)
    assert fresh["quotaDay"] == "2026-10-27"
    assert fresh["resetsAt"] == int(dt.datetime(2026, 10, 28, tzinfo=watch_control.QUOTA_TIMEZONE).timestamp() * 1000)
    assert fresh["status"] == "allowed" and fresh["round"]["amount"] == amount
    assert fresh["round"]["id"] != original["round"]["id"]
    # Repeated reads, stale offline snapshots and old completions cannot change today's quota.
    for _ in range(3):
        response = client.post("/api/watch-control/sync", headers=headers, json={
            "roundId": original["round"]["id"], "playedMs": 99999999, "cursor": 99,
        }).json()
        assert response["round"] == fresh["round"]
        assert response["version"] == fresh["version"]
    quota_clock[0] -= dt.timedelta(days=1)
    assert state(client, headers)["round"]["id"] == fresh["round"]["id"]


def test_daily_settings_defer_and_toggle_cannot_refill_today(setup, quota_clock):
    client, headers = setup
    original = enable(client, headers)
    start(client, headers)
    changed = command(client, headers, "settings", mode="minutes", amount=15).json()
    assert changed["round"]["id"] == original["round"]["id"]
    assert changed["round"]["remainingEpisodes"] == 1
    command(client, headers, "settings", enabled=False)
    enabled = command(client, headers, "settings", enabled=True).json()
    assert enabled["status"] == "resting"
    assert enabled["round"]["id"] == original["round"]["id"]
    assert command(client, headers, "allow").status_code == 409
    quota_clock[0] += dt.timedelta(days=1)
    fresh = state(client, headers)
    assert fresh["round"]["mode"] == "minutes"
    assert fresh["round"]["remainingMs"] == 900000


def test_midnight_play_without_poll_and_late_completion(setup, quota_clock):
    client, headers = setup
    enable(client, headers, amount=1)
    old_session = start(client, headers).json()["sessionId"]
    quota_clock[0] += dt.timedelta(days=1)
    assert start(client, headers, "ep2").status_code == 200
    fresh = state(client, headers)
    finish(client, headers, old_session)
    assert state(client, headers)["round"] == fresh["round"]


def test_stale_command_at_midnight_cannot_add_to_new_day(setup, quota_clock):
    client, headers = setup
    original = enable(client, headers)
    quota_clock[0] += dt.timedelta(days=1)
    response = client.post("/api/manage/watch-control/tv1/commands", json={
        "action": "add", "version": original["version"], "requestId": str(uuid.uuid4()),
    })
    assert response.status_code == 409
    fresh = state(client, headers)
    assert fresh["quotaDay"] == "2026-10-27" and fresh["round"]["amount"] == 2


def test_upgrade_adopts_consumption_without_refilling(setup):
    from mollytime_server.management_models import WatchControl
    client, headers = setup
    enable(client, headers, amount=1)
    command(client, headers, "stop")
    with Session(db.get_engine()) as session:
        session.get(WatchControl, "tv1").quota_day = None
        session.commit()
    current = state(client, headers)
    assert current["quotaDay"] == "2026-10-26" and current["status"] == "resting"


def test_daily_schema_upgrade_is_idempotent_and_preserves_rows(setup):
    from sqlalchemy import inspect
    client, headers = setup
    original = enable(client, headers)
    with db.get_engine().begin() as connection:
        connection.exec_driver_sql("ALTER TABLE watch_controls DROP COLUMN quota_day")
    db.upgrade_watch_control_daily(db.get_engine())
    db.upgrade_watch_control_daily(db.get_engine())
    assert "quota_day" in {col["name"] for col in inspect(db.get_engine()).get_columns("watch_controls")}
    assert state(client, headers)["round"] == original["round"]
