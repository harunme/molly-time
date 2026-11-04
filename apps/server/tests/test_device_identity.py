import datetime as dt
import secrets
import uuid

from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401
from mollytime_server import db
from mollytime_server.auth import hash_password
from mollytime_server.management_models import Device, DeviceIdentityBinding, WatchControl, WatchControlRound, WatchSession, WatchInterval
from mollytime_server.models import User


def proof():
    return {"id": str(uuid.uuid4()), "secret": secrets.token_hex(32)}


def pair(parent, identity=None):
    body = {"name": "客厅电视"}
    if identity:
        body["identity"] = identity
    started = parent.post("/api/auth/pairing/start", json=body)
    assert started.status_code == 200, started.text
    pairing = started.json()
    preview = parent.get(f"/api/manage/pairing/{pairing['userCode']}")
    assert preview.status_code == 200
    assert parent.post("/api/manage/pairing/confirm", json={"code": pairing["userCode"], "name": preview.json()["name"]}).status_code == 200
    polled = parent.post("/api/auth/pairing/poll", json={"deviceCode": pairing["deviceCode"]})
    assert polled.status_code == 200, polled.text
    return polled.json()["auth"], preview.json()


def register(parent, auth, identity):
    return parent.post("/api/auth/device-identity", json=identity, headers={"Authorization": "Bearer " + auth["accessToken"]})


def assert_invalid(parent, auth):
    assert parent.get("/api/me", headers={"Authorization": "Bearer " + auth["accessToken"]}).status_code == 401
    assert parent.post("/api/auth/refresh", json={"refreshToken": auth["refreshToken"]}).status_code == 401


def test_rebinding_restores_device_settings_and_invalidates_old_credentials(parent):
    identity = proof()
    original, preview = pair(parent, identity)
    assert preview["returningDevice"] is False
    device_id = original["deviceId"]
    control = parent.get("/api/manage/watch-control").json()["devices"][0]
    parent.put("/api/manage/watch-control/pin", json={"pin": "4826"})
    changed = parent.post(f"/api/manage/watch-control/{device_id}/commands", json={"requestId": str(uuid.uuid4()), "version": control["version"], "action": "settings", "enabled": True, "mode": "minutes", "amount": 35})
    assert changed.status_code == 200
    before = parent.get("/api/manage/watch-control").json()["devices"][0]
    now = dt.datetime.now(dt.UTC)
    day = now.astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
    with Session(db.get_engine()) as session:
        control_row = session.get(WatchControl, device_id)
        session.add(WatchControlRound(id="kept-round", device_id=device_id, mode="minutes", amount=35, played_ms=60000, limit_ms=2100000))
        control_row.round_id = "kept-round"
        control_row.quota_day = day
        session.add(WatchSession(id="kept-watch", family_id="f1", user_id="u1", device_id=device_id, item_id="e1", item_name="历史视频", purpose="family_watch", started_at=now, last_reported_at=now))
        session.flush()
        session.add(WatchInterval(session_id="kept-watch", seq=0, start_ms=0, end_ms=1000, played_ms=1000, position_ms=1000))
        session.commit()
    assert parent.post(f"/api/manage/devices/{device_id}/revoke").status_code == 200
    assert_invalid(parent, original)
    restored, preview = pair(parent, identity)
    assert restored["deviceId"] == device_id
    assert preview["returningDevice"] is True
    after = parent.get("/api/manage/watch-control").json()["devices"][0]
    assert (after["amount"], after["version"], after["enabled"]) == (before["amount"], before["version"], before["enabled"])
    with Session(db.get_engine()) as session:
        assert session.get(WatchControl, device_id).round_id == "kept-round"
        assert session.get(WatchControlRound, "kept-round").played_ms == 60000
    report = parent.get("/api/manage/reports/watch-time", params={"start": day, "end": day, "deviceId": device_id}).json()
    assert report["totalPlayedMs"] == 1000
    assert report["sessions"][0]["id"] == "kept-watch"
    assert_invalid(parent, original)
    refreshed = parent.post("/api/auth/refresh", json={"refreshToken": restored["refreshToken"]})
    assert refreshed.status_code == 200
    assert parent.get("/api/me", headers={"Authorization": "Bearer " + refreshed.json()["accessToken"]}).status_code == 200
    assert parent.get("/api/manage/devices", params={"activeOnly": True, "page": 1}).json()["total"] == 1


def test_existing_device_adopts_identity_without_changing_authorization(parent):
    original, _ = pair(parent)
    identity = proof()
    assert register(parent, original, identity).status_code == 200
    assert register(parent, original, identity).status_code == 200
    assert register(parent, original, proof()).status_code == 409
    assert parent.post("/api/auth/device-identity", json=identity).status_code == 403
    reset = parent.post("/api/auth/pairing/reset", headers={"Authorization": "Bearer " + original["accessToken"]})
    assert reset.status_code == 200
    restored, preview = pair(parent, identity)
    assert restored["deviceId"] == original["deviceId"]
    assert preview["returningDevice"]
    assert_invalid(parent, original)


def test_wrong_identity_secret_cannot_claim_device(parent):
    identity = proof()
    original, _ = pair(parent, identity)
    forged = {**identity, "secret": secrets.token_hex(32)}
    assert parent.post("/api/auth/pairing/start", json={"identity": forged}).status_code == 401
    assert register(parent, original, forged).status_code == 401
    other, _ = pair(parent)
    assert register(parent, other, identity).status_code == 409
    with Session(db.get_engine()) as session:
        assert session.get(DeviceIdentityBinding, original["deviceId"]).identity_id == identity["id"]


def test_same_installation_other_family_has_separate_history_identity(parent):
    identity = proof()
    original, _ = pair(parent, identity)
    with Session(db.get_engine()) as session:
        session.add(User(id="other-parent", family_id="f2", name="other-parent", password_hash=hash_password("pass"), role="admin"))
        session.commit()
    login = parent.post("/api/manage/auth/login", json={"username": "other-parent", "password": "pass"}).json()
    parent.headers["X-CSRF-Token"] = login["csrfToken"]
    other, preview = pair(parent, identity)
    assert other["deviceId"] != original["deviceId"]
    assert not preview["returningDevice"]
    assert_invalid(parent, original)
    devices = parent.get("/api/manage/devices", params={"page": 1}).json()["items"]
    assert [d["id"] for d in devices] == [other["deviceId"]]
    login = parent.post("/api/manage/auth/login", json={"username": "parent", "password": "test-parent"}).json()
    parent.headers["X-CSRF-Token"] = login["csrfToken"]
    restored, preview = pair(parent, identity)
    assert restored["deviceId"] == original["deviceId"] and preview["returningDevice"]
    assert_invalid(parent, other)
    assert_invalid(parent, original)


def test_legacy_clients_without_identity_keep_pairing(parent):
    first, _ = pair(parent)
    second, _ = pair(parent)
    assert first["deviceId"] != second["deviceId"]
    assert parent.get("/api/me", headers={"Authorization": "Bearer " + first["accessToken"]}).status_code == 200


def test_additive_schema_upgrade_keeps_existing_binding(parent):
    from mollytime_server.management_models import PairingIdentity, DeviceAuthorizationVersion, DeviceIdentity
    original, _ = pair(parent)
    engine = db.get_engine()
    for table in (PairingIdentity, DeviceIdentityBinding, DeviceAuthorizationVersion, DeviceIdentity):
        table.__table__.drop(engine)
    db.init_db()
    db.init_db()
    assert parent.get("/api/me", headers={"Authorization": "Bearer " + original["accessToken"]}).status_code == 200
    assert register(parent, original, proof()).status_code == 200
