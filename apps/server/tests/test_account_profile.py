import base64
import io

from PIL import Image
from sqlalchemy.orm import Session

from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401
from mollytime_server import db
from mollytime_server.accounts import AccountProfile
from mollytime_server.auth import hash_password
from mollytime_server.models import User


def avatar():
    output = io.BytesIO()
    Image.new("RGB", (400, 300), "gold").save(output, format="JPEG")
    return base64.b64encode(output.getvalue()).decode()


def test_profile_survives_login_without_changing_identity(parent):
    original = parent.get("/api/manage/auth/session").json()
    result = parent.put("/api/manage/auth/profile", json={"displayName": "  小茉莉  ", "avatarJPEGBase64": avatar()})
    assert result.status_code == 200
    user = result.json()["user"]
    assert user["displayName"] == "小茉莉"
    assert user["name"] == original["user"]["name"]
    assert user["accountId"] == original["user"]["accountId"]
    with Image.open(io.BytesIO(base64.b64decode(user["avatarJPEGBase64"]))) as image:
        assert image.size == (256, 256) and image.format == "JPEG"
        assert not image.getexif()
    parent.post("/api/manage/auth/logout")
    logged_in = parent.post("/api/manage/auth/login", json={"username": "parent", "password": "test-parent"})
    assert logged_in.json()["user"]["displayName"] == "小茉莉"
    assert logged_in.json()["user"]["avatarJPEGBase64"] == user["avatarJPEGBase64"]
    parent.headers["X-CSRF-Token"] = logged_in.json()["csrfToken"]
    reset = parent.put("/api/manage/auth/profile", json={"displayName": "家长", "avatarJPEGBase64": None})
    assert reset.status_code == 200 and reset.json()["user"]["avatarJPEGBase64"] is None


def test_profile_rejects_bad_input_and_csrf_without_overwriting(parent):
    assert parent.put("/api/manage/auth/profile", json={"displayName": "保留"}).status_code == 200
    assert parent.put("/api/manage/auth/profile", json={"displayName": "篡改"}, headers={"X-CSRF-Token": ""}).status_code == 403
    for payload in ({"displayName": "  "}, {"displayName": "a" * 65}, {"displayName": "bad\nname"},
                    {"displayName": "好", "avatarJPEGBase64": "invalid"},
                    {"displayName": "好", "avatarJPEGBase64": "a" * 200001},
                    {"displayName": "好", "userId": "u2"}):
        assert parent.put("/api/manage/auth/profile", json=payload).status_code == 422
    assert parent.get("/api/manage/auth/session").json()["user"]["displayName"] == "保留"
    parent.post("/api/manage/auth/logout")
    assert parent.put("/api/manage/auth/profile", json={"displayName": "未登录"}).status_code == 401


def test_member_can_only_edit_own_profile(parent):
    with Session(db.get_engine()) as session:
        session.add(User(id="profile-member", family_id="f1", name="profile-member", role="member", password_hash=hash_password("member-pass")))
        session.add(AccountProfile(user_id="u1", display_name="管理员"))
        session.commit()
    parent.post("/api/manage/auth/logout")
    login = parent.post("/api/manage/auth/login", json={"username": "profile-member", "password": "member-pass"})
    parent.headers["X-CSRF-Token"] = login.json()["csrfToken"]
    result = parent.put("/api/manage/auth/profile", json={"displayName": "成员"})
    assert result.status_code == 200
    assert result.json()["user"]["displayName"] == "成员"
    with Session(db.get_engine()) as session:
        assert session.get(AccountProfile, "u1").display_name == "管理员"
    assert parent.post("/api/manage/resources", json={"name": "test", "type": "Series"}).status_code == 403
