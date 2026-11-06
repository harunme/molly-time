# ruff: noqa: F811 -- shared isolated database fixture
import datetime as dt
import uuid

import pytest
from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.auth import hash_password, issue_access_token
from mollytime_server.management_models import ClientErrorLog, Device
from mollytime_server.models import User


def payload(**changes):
    return {
        "id": str(uuid.uuid4()), "installationId": str(uuid.uuid4()),
        "source": "android-parent", "code": "NATIVE_UNCAUGHT", "fatal": True,
        "errorType": "java.lang.IllegalStateException",
        "stack": ["at com.molly.parent.ResourceCover(ParentScreen.kt:1155)"],
        "breadcrumbs": [{"name": "cover.enqueued", "at": dt.datetime.now(dt.UTC).isoformat()},
                        {"name": "tab.select.1", "at": dt.datetime.now(dt.UTC).isoformat()}],
        "screen": "tab.library", "appVersion": "0.1.2 (4)", "osVersion": "Android 14",
        "deviceModel": "Pixel 7", "occurredAt": dt.datetime.now(dt.UTC).isoformat(), **changes,
    }


def login(client, role="admin"):
    client.headers.pop("Authorization", None)
    with Session(db.get_engine()) as session:
        user = session.get(User, "u1")
        user.password_hash = hash_password("test-parent")
        user.role = role
        session.commit()
    response = client.post("/api/manage/auth/login", json={"username": "parent", "password": "test-parent"})
    assert response.status_code == 200
    return {"X-CSRF-Token": response.json()["csrfToken"]}


def test_parent_crash_requires_csrf_and_is_idempotent_with_operator_visibility(client):
    headers = login(client)
    body = payload()
    assert client.post("/api/client/error-logs", json=body).status_code == 403
    assert client.post("/api/client/error-logs", json=body, headers=headers).json() == {"ok": True}
    assert client.post("/api/client/error-logs", json=body, headers=headers).json() == {"ok": True}
    assert client.get("/api/manage/client-error-logs").status_code == 403
    with Session(db.get_engine()) as session:
        assert session.query(ClientErrorLog).count() == 1
        session.get(User, "u1").role = "superadmin"
        session.commit()
    result = client.get("/api/manage/client-error-logs?source=android-parent&fatal=true").json()
    assert result["total"] == 1
    row = result["items"][0]
    assert row["stack"] == body["stack"] and row["breadcrumbs"][-1]["name"] == "tab.select.1"
    assert row["familyName"] == "One" and row["source"] == "android-parent"
    assert client.get("/api/manage/client-error-logs?source=ios-parent").json()["total"] == 0
    assert client.get("/api/manage/client-error-logs?fatal=false").json()["total"] == 0
    assert "userId" not in row and "installationId" not in row


def test_member_can_report_but_cannot_read_and_cross_origin_is_rejected(client):
    headers = login(client, "member")
    assert client.post("/api/client/error-logs", json=payload(), headers=headers).status_code == 200
    assert client.get("/api/manage/client-error-logs").status_code == 403
    assert client.post("/api/client/error-logs", json=payload(), headers={**headers, "Origin": "https://other.example"}).status_code == 403


def test_anonymous_device_attribution_and_cross_owner_id_collision(client):
    body = payload(source="tv-android")
    client.headers.pop("Authorization", None)
    assert client.post("/api/client/error-logs", json=body).status_code == 401
    with Session(db.get_engine()) as session:
        session.add(Device(id="tv1", family_id="f1", user_id="u1", name="TV"))
        session.add(User(id="other", family_id="f2", name="other", password_hash="unused"))
        session.commit()
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="admin", device_id="tv1")
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/client/error-logs", json=body, headers=headers).status_code == 200
    assert client.post("/api/client/error-logs", json=payload(), headers=headers).status_code == 403
    other, _ = issue_access_token(user_id="other", family_id="f2", role="admin")
    assert client.post("/api/client/error-logs", json=body, headers={"Authorization": f"Bearer {other}"}).status_code == 409
    with Session(db.get_engine()) as session:
        row = session.get(ClientErrorLog, body["id"])
        assert row.device_id == "tv1" and row.family_id == "f1"


@pytest.mark.parametrize("changes", [
    {"source": "unknown"}, {"stack": ["x" * 301]}, {"stack": ["frame"] * 65},
    {"message": "must not be accepted"}, {"screen": "screen?token=secret"},
    {"breadcrumbs": [{"name": "user@example.com", "at": dt.datetime.now(dt.UTC).isoformat()}]},
    {"occurredAt": (dt.datetime.now(dt.UTC) - dt.timedelta(days=31)).isoformat()},
])
def test_payload_bounds(client, changes):
    assert client.post("/api/client/error-logs", json=payload(**changes)).status_code == 422


def test_redaction_rate_limit_and_old_record_cleanup(client):
    body = payload(stack=["at asset https://example.com/media?token=secret", "Authorization: Bearer private", "contact user@example.com"])
    assert client.post("/api/client/error-logs", json=body).status_code == 200
    with Session(db.get_engine()) as session:
        row = session.get(ClientErrorLog, body["id"])
        assert "secret" not in str(row.stack) and "private" not in str(row.stack) and "user@example.com" not in str(row.stack)
        row.created_at = dt.datetime.now(dt.UTC) - dt.timedelta(days=31)
        session.commit()
    assert client.post("/api/client/error-logs", json=payload()).status_code == 200
    with Session(db.get_engine()) as session:
        assert session.get(ClientErrorLog, body["id"]) is None
        for _ in range(119):
            session.add(ClientErrorLog(id=str(uuid.uuid4()), family_id="f1", user_id="u1", installation_id=str(uuid.uuid4()),
                source="web-parent", code="JS_UNCAUGHT", fatal=True, error_type="Error", app_version="test",
                occurred_at=dt.datetime.now(dt.UTC)))
        session.commit()
    response = client.post("/api/client/error-logs", json=payload())
    assert response.status_code == 429 and response.headers["Retry-After"] == "3600"
