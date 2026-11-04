"""Native invite registration uses anonymous requests and a separate login client."""
from test_email_accounts import operator  # noqa: F401
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401


def test_native_registration_creates_private_library_and_preserves_current_account(operator):
    original_cookie = operator.cookies.get("molly_parent")
    original_user = operator.get("/api/manage/auth/session").json()["user"]["id"]
    invite = operator.post("/api/manage/operations/invitations", json={}).json()
    anonymous = {"Cookie": ""}
    preview = operator.post("/api/manage/auth/invitation/preview", headers=anonymous, json={"code": invite["code"]})
    assert preview.status_code == 200 and preview.json()["familyName"] is None
    activated = operator.post("/api/manage/auth/invitation/activate", headers=anonymous, json={
        "code": invite["code"], "email": "ios-new@example.com", "password": "example-password", "familyName": "我的片库",
    })
    assert activated.status_code == 200 and activated.json()["familyName"] == "我的片库"
    # Registration has not switched or revoked the current parent session.
    assert operator.get("/api/manage/auth/session").json()["user"]["id"] == original_user
    login = operator.post("/api/manage/auth/login", headers=anonymous, json={"username": "ios-new@example.com", "password": "example-password"})
    assert login.status_code == 200
    assert login.json()["user"]["accountId"] == activated.json()["accountId"]
    assert login.json()["user"]["name"] == "ios-new"
    assert operator.get("/api/manage/resources", params={"page": 1}).json()["total"] == 0
    assert operator.get("/api/manage/devices", params={"page": 1}).json()["total"] == 0
    original_header = {"Cookie": "molly_" + "parent=" + original_cookie}
    assert operator.get("/api/manage/auth/session", headers=original_header).json()["user"]["id"] == original_user


def test_registration_success_can_login_later_without_reusing_invite(operator):
    code = operator.post("/api/manage/operations/invitations", json={}).json()["code"]
    anonymous = {"Cookie": ""}
    body = {"code": code, "email": "ios-retry@example.com", "password": "example-password", "familyName": "我的片库"}
    assert operator.post("/api/manage/auth/invitation/activate", headers=anonymous, json=body).status_code == 200
    assert operator.post("/api/manage/auth/login", headers=anonymous, json={"username": body["email"], "password": "wrong"}).status_code == 401
    assert operator.post("/api/manage/auth/invitation/preview", headers=anonymous, json={"code": code}).status_code == 404
    assert operator.post("/api/manage/auth/login", headers=anonymous, json={"username": body["email"], "password": body["password"]}).status_code == 200
