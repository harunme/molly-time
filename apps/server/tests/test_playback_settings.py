import pytest
from sqlalchemy.orm import Session
from test_management import parent, native_token  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.auth import issue_access_token
from mollytime_server.models import MediaFile, User
from mollytime_server.playback_settings import subtitle_type


def seed_subtitles():
    with Session(db.get_engine()) as session:
        session.get(MediaFile, "s1").language = "zh-CN"
        session.get(MediaFile, "s1").is_default = False
        for index, language in enumerate(["en-US", "zh-en", "en"], start=1):
            session.add(MediaFile(id=f"track-{index}", family_id="f1", item_id="e1", kind="subtitle",
                                  storage="local", path="subtitle.srt", index=index, language=language,
                                  is_default=True))
        session.commit()


def test_shared_preferences_sync_across_admin_tv_and_playback(parent):
    seed_subtitles()
    tv = native_token()
    assert parent.get("/api/manage/settings").json()["defaultSubtitle"] == "zh"
    assert parent.get("/api/settings/playback", headers=tv).json() == {"defaultSubtitle": "zh"}
    for preference, selected in [("zh", 0), ("en", 1), ("zh-en", 2), ("off", None)]:
        assert parent.put("/api/manage/settings", json={"defaultSubtitle": preference}).status_code == 200
        result = parent.get("/api/episodes/e1/playback", headers=tv).json()
        assert result["defaultSubtitle"] == preference
        assert [s["index"] for s in result["subtitles"] if s["isDefault"]] == ([] if selected is None else [selected])
        catalog = parent.get("/api/episodes/e1", headers=tv).json()["sources"][0]["subtitles"]
        assert [s["index"] for s in catalog if s["isDefault"]] == ([] if selected is None else [selected])
    assert parent.put("/api/settings/playback", headers=tv, json={"defaultSubtitle": "zh-en"}).json() == {"defaultSubtitle": "zh-en"}
    assert parent.get("/api/manage/settings").json()["defaultSubtitle"] == "zh-en"
    assert parent.put("/api/manage/settings", json={"timezone": "UTC"}).status_code == 200
    assert parent.get("/api/manage/settings").json()["defaultSubtitle"] == "zh-en"
    assert parent.put("/api/settings/playback", headers=tv, json={"defaultSubtitle": "en"}).status_code == 200
    assert parent.get("/api/manage/settings").json()["timezone"] == "UTC"


def test_missing_preferred_track_stays_off_and_preferences_are_family_scoped(client):
    assert not any(s["isDefault"] for s in client.get("/api/episodes/e1/playback").json()["subtitles"])
    assert client.put("/api/settings/playback", json={"defaultSubtitle": "en"}).status_code == 200
    with Session(db.get_engine()) as session:
        session.add(User(id="u2", family_id="f2", name="other", password_hash="test"))
        session.commit()
    token, _ = issue_access_token(user_id="u2", family_id="f2", role="admin")
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/settings/playback", headers=headers).json() == {"defaultSubtitle": "zh"}
    assert client.put("/api/settings/playback", headers=headers, json={"defaultSubtitle": "off"}).status_code == 200
    assert client.get("/api/settings/playback").json() == {"defaultSubtitle": "en"}
    assert client.get("/api/episodes/e1/playback", headers=headers).status_code == 404


def test_settings_validation_and_auth(parent):
    for value in ["fr", "", "bilingual", None, 3]:
        assert parent.put("/api/settings/playback", headers=native_token(), json={"defaultSubtitle": value}).status_code == 422
        assert parent.put("/api/manage/settings", json={"defaultSubtitle": value}).status_code == (200 if value is None else 422)
    assert parent.put("/api/settings/playback", headers=native_token(), json={"defaultSubtitle": "zh", "familyId": "f2"}).status_code == 422
    assert parent.put("/api/settings/playback", json={"defaultSubtitle": "en"}, headers={"X-CSRF-Token": "wrong"}).status_code == 403
    parent.cookies.clear()
    parent.headers.pop("X-CSRF-Token")
    assert parent.get("/api/settings/playback").status_code == 401
    assert parent.put("/api/settings/playback", json={"defaultSubtitle": "en"}).status_code == 401


@pytest.mark.parametrize("language, expected", [("zh_TW", "zh"), ("chi", "zh"), ("zho", "zh"), ("eng", "en"), ("en-GB", "en"), ("zh-en", "zh-en"), ("en-zh", "zh-en"), (None, "und")])
def test_language_codes(language, expected):
    assert subtitle_type(language) == expected
