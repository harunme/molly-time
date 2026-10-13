# ruff: noqa: F811 -- imported fixture is injected by pytest below
import datetime as dt
import uuid

from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401 -- isolated database fixture

from mollytime_server import db
from mollytime_server.auth import hash_password, issue_access_token
from mollytime_server.management_models import Device, DeviceErrorLog
from mollytime_server.models import User


def device_headers():
    with Session(db.get_engine()) as session:
        session.add(Device(id="tv1", family_id="f1", user_id="u1", name="客厅电视"))
        session.commit()
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="admin", device_id="tv1")
    return {"Authorization": f"Bearer {token}"}


def payload():
    return {
        "id": str(uuid.uuid4()), "category": "playback", "code": "ERROR_CODE_IO_UNSPECIFIED",
        "causeTypes": ["androidx.media3.datasource.cache.CacheDataSource$CacheDataSourceException"],
        "episodeId": "e1", "mediaId": "v1", "positionMs": 42000,
        "availableBytes": 2_000_000_000, "appVersion": "1.2.3",
    }


def test_device_report_is_private_idempotent_and_visible_to_superadmin(client):
    body = payload()
    assert client.post("/api/device/error-logs", json=body).status_code == 403
    headers = device_headers()
    assert client.post("/api/device/error-logs", json=body, headers=headers).json() == {"ok": True}
    assert client.post("/api/device/error-logs", json=body, headers=headers).json() == {"ok": True}
    with Session(db.get_engine()) as session:
        assert session.query(DeviceErrorLog).count() == 1
        user = session.get(User, "u1")
        user.password_hash = hash_password("test-parent")
        session.add(User(id="u2", family_id="f2", name="other-parent", password_hash="test"))
        session.flush()
        session.add(Device(id="tv2", family_id="f2", user_id="u2", name="其他家庭电视"))
        session.flush()
        session.add(DeviceErrorLog(
            id=str(uuid.uuid4()), family_id="f2", device_id="tv2", category="playback",
            code="ERROR_CODE_IO_UNSPECIFIED", cause_types=[], app_version="1.0",
        ))
        session.commit()
    login = client.post("/api/manage/auth/login", json={"username": "parent", "password": "test-parent"})
    assert login.status_code == 200
    assert client.get("/api/manage/device-error-logs").status_code == 403
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "superadmin"
        session.commit()
    rows = client.get("/api/manage/device-error-logs").json()
    assert rows["total"] == 2
    row = next(item for item in rows["items"] if item["deviceId"] == "tv1")
    assert row["deviceName"] == "客厅电视" and row["episodeName"] == "One"
    assert row["familyName"] == "One"
    assert row["code"] == body["code"] and row["availableBytes"] == 2_000_000_000
    assert "url" not in row and "token" not in row
    other = client.get("/api/manage/device-error-logs?deviceId=tv2").json()
    assert other["total"] == 1 and other["items"][0]["familyName"] == "Two"
    assert client.get("/api/manage/device-error-logs?deviceId=other").status_code == 404


def test_device_report_rejects_free_text_and_unbound_clients(client):
    headers = device_headers()
    body = payload()
    body["causeTypes"] = ["IOException https://host/path?token=secret"]
    assert client.post("/api/device/error-logs", json=body, headers=headers).status_code == 422
    body = payload()
    body["code"] = "error: signed url"
    assert client.post("/api/device/error-logs", json=body, headers=headers).status_code == 422
    with Session(db.get_engine()) as session:
        session.get(Device, "tv1").revoked = True
        session.commit()
    assert client.post("/api/device/error-logs", json=payload(), headers=headers).status_code == 401


def test_old_reports_are_pruned_on_new_report(client):
    headers = device_headers()
    with Session(db.get_engine()) as session:
        session.add(DeviceErrorLog(
            id=str(uuid.uuid4()), family_id="f1", device_id="tv1", category="playback",
            code="ERROR_CODE_IO_UNSPECIFIED", cause_types=[], app_version="1.0",
            created_at=dt.datetime.now(dt.UTC) - dt.timedelta(days=31),
        ))
        session.commit()
    assert client.post("/api/device/error-logs", json=payload(), headers=headers).status_code == 200
    with Session(db.get_engine()) as session:
        assert session.query(DeviceErrorLog).count() == 1


def test_report_rate_limit_is_per_device(client):
    headers = device_headers()
    now = dt.datetime.now(dt.UTC)
    with Session(db.get_engine()) as session:
        session.add_all(DeviceErrorLog(
            id=str(uuid.uuid4()), family_id="f1", device_id="tv1", category="playback",
            code="ERROR_CODE_IO_UNSPECIFIED", cause_types=[], app_version="1.0", created_at=now,
        ) for _ in range(60))
        session.commit()
    assert client.post("/api/device/error-logs", json=payload(), headers=headers).status_code == 429
