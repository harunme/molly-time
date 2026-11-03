# ruff: noqa: F811
import datetime as dt
import uuid
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_operations import operator  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.analytics import ZONE, watching
from mollytime_server.analytics_models import DeviceDay, Installation, InstallationDay
from mollytime_server.auth import issue_access_token
from mollytime_server.management_models import Device, WatchInterval, WatchSession
from mollytime_server.models import Item

ROOT = "/api/manage/operations/analytics"


def installation():
    return {
        "installationId": str(uuid.uuid4()),
        "installationToken": "a" * 64,
        "version": "1.2.3",
        "channel": "release",
    }


def device_headers(key="d1"):
    with Session(db.get_engine()) as session:
        if session.get(Device, key) is None:
            session.add(Device(id=key, family_id="f1", user_id="u1"))
            session.commit()
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="device", device_id=key)
    return {"Authorization": "Bearer " + token}


def test_permissions_and_input(parent):
    for path in ("overview", "daily", "families", "devices?familyId=f1", "versions"):
        assert parent.get(ROOT + "/" + path).status_code == 403
    body = installation()
    assert parent.post("/api/client/telemetry", json={**body, "familyId": "f2"}).status_code == 422
    assert (
        parent.post(
            "/api/client/telemetry", json=body, headers={"Authorization": "Bearer invalid"}
        ).status_code
        == 401
    )
    assert parent.post("/api/client/telemetry", json={**body, "channel": "debug"}).json()["ignored"]
    with Session(db.get_engine()) as session:
        assert session.query(Installation).count() == 0


def test_retry_upgrade_repair_version_and_revoke(operator):
    body = installation()
    for _ in range(2):
        assert operator.post("/api/client/telemetry", json=body).status_code == 200
    headers = device_headers()
    assert (
        operator.post(
            "/api/client/telemetry", json={**body, "version": "2.0"}, headers=headers
        ).status_code
        == 200
    )
    other = device_headers("d2")
    assert operator.post("/api/client/telemetry", json=body, headers=other).status_code == 200
    assert (
        operator.post(
            "/api/client/telemetry", json={**body, "installationToken": "b" * 64}
        ).status_code
        == 403
    )
    with Session(db.get_engine()) as session:
        assert session.query(Installation).count() == session.query(InstallationDay).count() == 1
        assert session.get(Installation, body["installationId"]).device_id == "d2"
        assert session.query(DeviceDay).count() == 2
        session.get(Device, "d2").revoked = True
        session.commit()
    assert operator.post("/api/client/telemetry", json=body, headers=other).status_code == 401
    result = operator.get(ROOT + "/overview").json()
    assert result["installationCount"] == 1
    assert result["onlineDevices"] == result["boundDevices"] == 1
    rows = operator.get(ROOT + "/devices?familyId=f1").json()["items"]
    assert next(r for r in rows if r["id"] == "d1")["version"] is None
    assert operator.get(ROOT + "/versions").json()["items"] == [{"version": "1.2.3", "count": 1}]


def test_concurrent_registration_and_missing_history(operator):
    body = installation()
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(
            pool.map(
                lambda _: operator.post("/api/client/telemetry", json=body).status_code, range(3)
            )
        )
    assert results == [200] * 3
    with Session(db.get_engine()) as session:
        assert session.query(Installation).count() == session.query(InstallationDay).count() == 1
    response = operator.get(ROOT + "/daily?days=30")
    assert response.status_code == 200, response.text
    rows = response.json()["items"]
    assert len(rows) == 30
    assert rows[0]["newInstallations"] is None
    assert rows[0]["visitingDevices"] is None
    assert rows[-1]["newInstallations"] == 1
    assert operator.get(ROOT + "/daily?days=8").status_code == 422


def test_old_client_presence_and_online_boundaries(operator):
    headers = device_headers()
    assert operator.get("/api/me", headers=headers).status_code == 200
    assert operator.get("/api/me", headers=headers).status_code == 200
    with Session(db.get_engine()) as session:
        assert session.query(DeviceDay).count() == 1
        session.get(Device, "d1").last_seen = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=91)
        session.commit()
    assert operator.get(ROOT + "/overview").json()["onlineDevices"] == 0
    assert operator.get(ROOT + "/daily?days=7").json()["items"][-1]["visitingDevices"] == 1
    assert operator.get(ROOT + "/families?q=One").json()["total"] == 1
    assert operator.get(ROOT + "/families?q=missing").json()["items"] == []


def test_cross_midnight_live_dedup_preview_and_late_session(operator):
    device_headers()
    now = dt.datetime.now(dt.UTC)
    midnight = dt.datetime.combine(now.astimezone(ZONE).date(), dt.time.min, ZONE).astimezone(
        dt.UTC
    )
    # A long-lived session has an interval at midnight; session start is deliberately old.
    started = midnight - dt.timedelta(days=40)
    offset = int((midnight - started).total_seconds() * 1000)
    with Session(db.get_engine()) as session:
        session.add(Item(id="live", family_id="f1", type="LiveChannel", name="Live"))
        session.flush()
        for key, item, purpose, device in [
            ("vod", "e1", "family_watch", "d1"),
            ("live", "live", "live_tv", "d1"),
            ("preview", "e1", "parent_preview", None),
        ]:
            session.add(
                WatchSession(
                    id=key,
                    family_id="f1",
                    user_id="u1",
                    device_id=device,
                    item_id=item,
                    item_name=key,
                    purpose=purpose,
                    started_at=started,
                    last_reported_at=now,
                )
            )
            session.flush()
            session.add(
                WatchInterval(
                    session_id=key,
                    seq=0,
                    start_ms=offset - 1000,
                    end_ms=offset + 1000,
                    played_ms=2000,
                    position_ms=2000,
                    completed=False,
                    stopped=False,
                )
            )
        session.commit()
        buckets, families = watching(session, 7, midnight + dt.timedelta(seconds=2))
        today = buckets[midnight.astimezone(ZONE).date().isoformat()]
        yesterday = buckets[(midnight.astimezone(ZONE).date() - dt.timedelta(days=1)).isoformat()]
        assert (
            today["vodMs"] == today["liveMs"] == yesterday["vodMs"] == yesterday["liveMs"] == 1000
        )
        assert today["families"] == {"f1"} and today["devices"] == {"d1"}
        assert families == {"f1": 4000}
    summary = operator.get(ROOT + "/overview").json()
    assert summary["todayWatchingFamilies"] == summary["weekWatchingFamilies"] == 1
    # Family report intentionally continues to exclude live TV.
    assert operator.get("/api/manage/overview").json()["watch"]["todayPlayedMs"] == 1000
