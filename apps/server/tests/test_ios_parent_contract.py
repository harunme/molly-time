"""Contracts used by the native parent client; all data is isolated test data."""
import hashlib

from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401


def test_native_parent_session_catalog_and_preview(parent):
    assert "Origin" not in parent.headers
    assert "Authorization" not in parent.headers
    session = parent.get("/api/manage/auth/session").json()
    assert session["csrfToken"] and session["user"]["accountId"]
    catalog = parent.get("/api/manage/resources", params={"page": 1, "pageSize": 30}).json()
    assert {"items", "page", "pageSize", "total"} <= catalog.keys()
    assert catalog["items"][0]["name"] == "Stories"
    playback = parent.get("/api/episodes/e1/playback")
    assert playback.status_code == 200
    assert playback.json()["url"].startswith("/api/episodes/e1/play?")
    assert isinstance(playback.json()["subtitles"], list)
    assert parent.get(playback.json()["url"], headers={"Range": "bytes=0-3"}).content == b"0123"
    assert parent.get("/api/episodes/e2/playback").status_code == 404
    assert parent.post("/api/playback/sessions", json={"episodeId": "e1"}).status_code == 403


def test_native_pairing_preview_confirm_and_controls(parent):
    pairing = parent.post("/api/auth/pairing/start", json={"name": "客厅电视"}).json()
    code = pairing["userCode"]
    assert len(code) == 4 and code.isascii() and code.isdigit()
    preview = parent.get(f"/api/manage/pairing/{code}")
    assert preview.status_code == 200 and preview.json()["name"] == "客厅电视"
    assert parent.post("/api/manage/pairing/confirm", json={"code": code, "name": "客厅"}).status_code == 200
    authorized = parent.post("/api/auth/pairing/poll", json={"deviceCode": pairing["deviceCode"]}).json()
    assert authorized["status"] == "authorized"
    devices = parent.get("/api/manage/devices", params={"page": 1, "activeOnly": True}).json()
    assert devices["items"][0]["name"] == "客厅"
    control = parent.get("/api/manage/watch-control").json()["devices"][0]
    assert parent.put("/api/manage/watch-control/pin", json={"pin": "4826"}).status_code == 200
    command = {"requestId": "ios-contract-1", "version": control["version"], "action": "settings", "enabled": True, "mode": "minutes", "amount": 20}
    changed = parent.post(f"/api/manage/watch-control/{control['deviceId']}/commands", json=command)
    assert changed.status_code == 200
    assert changed.json()["amount"] == 20


def test_native_local_upload_metadata_and_csrf(parent):
    item = parent.post("/api/manage/resources", json={"name": "手机上传", "type": "Episode", "parentId": "series"}).json()
    size = 10
    started = parent.post("/api/manage/uploads", json={"itemId": item["id"], "filename": "phone.mp4", "size": size, "kind": "video", "fingerprint": "ios-contract-fixture"})
    assert started.status_code == 200
    upload = started.json()
    assert upload["transport"] == "local" and upload["partSize"] > 0
    path = f"/api/manage/uploads/{upload['id']}/chunks?offset=0"
    data = b"0123456789"
    headers = {"Content-Type": "application/octet-stream", "X-Chunk-SHA256": hashlib.sha256(data).hexdigest()}
    assert parent.put(path, content=data, headers={**headers, "X-CSRF-Token": ""}).status_code == 403
    result = parent.put(path, content=data, headers=headers)
    assert result.status_code == 200 and result.json()["offset"] == size
    # Lost acknowledgement can be retried without corrupting the file.
    assert parent.put(path, content=data, headers=headers).status_code == 200
    completed = parent.post(f"/api/manage/uploads/{upload['id']}/complete", json={"runtimeMs": 1000, "cover": None})
    assert completed.status_code == 200 and completed.json()["status"] == "processing"
    detail = parent.get(f"/api/manage/resources/{item['id']}").json()
    assert detail["status"] == "draft"


def test_parent_child_visibility_requires_ready_content(parent):
    """The mobile toggle must never expose an unfinished upload to children."""
    folder = parent.post("/api/manage/resources", json={"name": "手机添加", "type": "Series"})
    assert folder.status_code == 200
    item = parent.post("/api/manage/resources", json={"name": "未上传视频", "type": "Episode", "parentId": folder.json()["id"]}).json()
    assert item["status"] == "draft" and not item["ready"]
    assert parent.post(f"/api/manage/resources/{item['id']}/publish", json={}).status_code == 409
    hidden = parent.post("/api/manage/resources/e1/unpublish", json={})
    assert hidden.status_code == 200 and hidden.json()["status"] == "draft"
    # Parents can still preview their own ready videos before allowing child access.
    assert parent.get("/api/episodes/e1/playback").status_code == 200
    published = parent.post("/api/manage/resources/e1/publish", json={})
    assert published.status_code == 200 and published.json()["status"] == "published"


def test_native_member_changes_only_own_password_with_current_password_and_csrf(parent):
    from sqlalchemy.orm import Session
    from mollytime_server import db
    from mollytime_server.auth import verify_password
    from mollytime_server.models import User

    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        others = {u.id: u.password_hash for u in session.query(User).filter(User.id != "u1")}
        session.commit()
    body = {"currentPassword": "test-parent", "newPassword": "new-parent-password"}
    assert parent.post("/api/manage/password", json=body, headers={"X-CSRF-Token": ""}).status_code == 403
    assert parent.post("/api/manage/password", json={**body, "currentPassword": "wrong"}).status_code == 403
    assert parent.post("/api/manage/password", json=body).status_code == 200
    with Session(db.get_engine()) as session:
        assert verify_password(body["newPassword"], session.get(User, "u1").password_hash)
        assert not verify_password(body["currentPassword"], session.get(User, "u1").password_hash)
        assert {u.id: u.password_hash for u in session.query(User).filter(User.id != "u1")} == others
    # Being allowed to change your own password does not grant family management.
    assert parent.put("/api/manage/watch-control/pin", json={"pin": "4826"}).status_code == 403
    assert parent.put("/api/manage/settings", json={"defaultSubtitle": "off"}).status_code == 403
    assert parent.post("/api/manage/reminders/farewell/upload-target").status_code == 403


def test_native_rest_reminder_works_without_warning_and_stays_private(parent):
    from sqlalchemy.orm import Session
    from mollytime_server import db
    from mollytime_server.auth import issue_access_token
    from mollytime_server.management_models import Device, ResourceState, WatchControl
    from mollytime_server.models import MediaFile

    target = parent.post("/api/manage/reminders/farewell/upload-target")
    assert target.status_code == 200
    item_id = target.json()["itemId"]
    with Session(db.get_engine()) as session:
        session.add(Device(id="reminder-tv", family_id="f1", user_id="u1", name="TV"))
        session.flush()
        session.add(WatchControl(device_id="reminder-tv", family_id="f1", enabled=True))
        session.add(MediaFile(id="farewell-file", family_id="f1", item_id=item_id, kind="video", storage="local", path="video.mp4"))
        session.get(ResourceState, item_id).ready = True
        session.commit()
    state = parent.get("/api/manage/reminders").json()
    assert state["farewell"]["ready"] and not state["warning"]["ready"]
    assert parent.get("/api/reminders/farewell/playback").status_code == 200
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="device", device_id="reminder-tv")
    headers = {"Authorization": f"Bearer {token}"}
    controls = parent.get("/api/watch-control", headers=headers).json()
    assert controls["farewellPath"] == "/api/reminders/farewell/playback"
    assert controls["warningPath"] is None
    assert parent.get(controls["farewellPath"], headers=headers).status_code == 200
    items = parent.get("/api/manage/resources", params={"page": 1, "pageSize": 100}).json()["items"]
    assert item_id not in {item["id"] for item in items}
    with Session(db.get_engine()) as session:
        assert session.get(ResourceState, item_id).status == "draft"


def test_native_account_switch_keeps_other_session_and_family_isolated(parent):
    from sqlalchemy.orm import Session
    from mollytime_server import db
    from mollytime_server.auth import hash_password
    from mollytime_server.models import User

    original_cookie = parent.cookies.get("molly_parent")
    original_csrf = parent.headers["X-CSRF-Token"]
    with Session(db.get_engine()) as session:
        session.add(User(id="switch-user", family_id="f2", name="switch-parent", role="admin", password_hash=hash_password("switch-example")))
        session.commit()
    failed = parent.post("/api/manage/auth/login", headers={"Cookie": ""}, json={"username": "switch-parent", "password": "wrong"})
    assert failed.status_code == 401
    assert parent.get("/api/manage/auth/session", headers={"Cookie": f"molly_parent={original_cookie}"}).json()["user"]["id"] == "u1"
    other = parent.post("/api/manage/auth/login", headers={"Cookie": ""}, json={"username": "switch-parent", "password": "switch-example"})
    assert other.status_code == 200
    other_cookie = parent.cookies.get("molly_parent")
    other_headers = {"Cookie": f"molly_parent={other_cookie}", "X-CSRF-Token": other.json()["csrfToken"]}
    original_headers = {"Cookie": f"molly_parent={original_cookie}", "X-CSRF-Token": original_csrf}
    assert parent.get("/api/manage/auth/session", headers=original_headers).json()["user"]["id"] == "u1"
    assert parent.get("/api/manage/auth/session", headers=other_headers).json()["user"]["id"] == "switch-user"
    assert parent.get("/api/manage/resources/e1", headers=other_headers).status_code == 404
    assert parent.post("/api/manage/auth/logout", headers=other_headers).status_code == 200
    assert parent.get("/api/manage/auth/session", headers=other_headers).status_code == 401
    assert parent.get("/api/manage/auth/session", headers=original_headers).status_code == 200
