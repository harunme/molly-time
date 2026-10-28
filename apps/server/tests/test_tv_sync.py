import hashlib
import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.orm import Session
from test_management import event, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.auth import issue_access_token
from mollytime_server.management_models import Device, DeviceDownload, ResourceState
from mollytime_server.models import Item, MediaFile


@pytest.fixture
def tv(parent):  # noqa: F811 -- shared fixture
    with Session(db.get_engine()) as s:
        s.add(Device(id="tv1", family_id="f1", user_id="u1", name="TV"))
        media = s.get(MediaFile, "v1")
        media.size_bytes = 10
        media.sha256 = hashlib.sha256(b"0123456789").hexdigest()
        s.add(
            DeviceDownload(
                id="download1",
                family_id="f1",
                device_id="tv1",
                media_id="v1",
                desired="saved",
                status="saved",
            )
        )
        s.commit()
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="admin", device_id="tv1")
    parent.headers["Authorization"] = "Bearer " + token
    return parent


def state(tv):
    result = tv.get("/api/tv/sync-state")
    assert result.status_code == 200, result.text
    return result.json()


def folder(tv, info):
    result = tv.get("/api/tv/catalog/manifest", params={"version": info["catalogVersion"]})
    assert result.status_code == 200, result.text
    return result.json()["folders"][0]


def test_static_versions_pages_and_stale_read(tv):
    before = state(tv)
    assert state(tv)["catalogVersion"] == before["catalogVersion"]
    f = folder(tv, before)
    page = tv.get("/api/tv/catalog/folders/series", params={"version": f["version"]})
    assert page.status_code == 200, page.text
    assert [e["id"] for e in page.json()["episodes"]] == ["e1"]
    assert "positionMs" not in page.json()["episodes"][0]
    assert (
        tv.get("/api/tv/catalog/home", params={"version": before["homeVersion"]}).status_code == 200
    )
    with Session(db.get_engine()) as s:
        s.get(Item, "e1").name = "Updated"
        s.commit()
    after = state(tv)
    assert after["catalogVersion"] != before["catalogVersion"]
    assert after["playbackVersion"] == before["playbackVersion"]
    assert (
        tv.get("/api/tv/catalog/folders/series", params={"version": f["version"]}).status_code
        == 409
    )


def test_one_shot_reminder_does_not_revoke_offline_permissions(tv):
    from mollytime_server.api.tv_sync import read_grant
    from mollytime_server.management_models import DeviceReminder

    before = read_grant(state(tv)["offlineGrant"]["token"])["permissions"]
    assert before
    with Session(db.get_engine()) as session:
        session.add(DeviceReminder(device_id="tv1", family_id="f1", phase="done"))
        session.commit()
    after = state(tv)
    assert after["offlineBlocked"] is False
    assert read_grant(after["offlineGrant"]["token"])["permissions"] == before


def test_progress_does_not_invalidate_static_catalog(tv):
    before = state(tv)
    session = tv.post("/api/playback/sessions", json={"episodeId": "e1"}).json()["sessionId"]
    assert tv.post(f"/api/playback/sessions/{session}/events", json=event()).status_code == 200
    after = state(tv)
    assert after["catalogVersion"] == before["catalogVersion"]
    assert after["homeVersion"] == before["homeVersion"]
    assert after["playbackVersion"] != before["playbackVersion"]


def test_separate_preview_keeps_its_own_version_in_static_catalog(tv):
    from mollytime_server.api.tv_sync import static_images
    from mollytime_server.images import image_ref

    with Session(db.get_engine()) as session:
        session.add_all([
            MediaFile(id="poster", family_id="f1", item_id="e1", kind="image",
                      storage="local", path="poster.jpg", mime="image/jpeg"),
            MediaFile(id="motion", family_id="f1", item_id="e1", kind="preview",
                      storage="local", path="motion.webp", mime="image/webp"),
        ])
        session.get(Item, "e1").primary_image_tag = "poster"
        session.commit()
        ref = image_ref(session, session.get(Item, "e1"))
        rendered = static_images(session, {"image": ref})["image"]
        assert rendered["version"] in rendered["url"]
        assert rendered["previewUrl"] == "/api/items/e1/image?v=motion&preview=1"


def test_rollback_and_bulk_updates(tv):
    before = state(tv)
    with Session(db.get_engine()) as s:
        s.get(Item, "e1").name = "Rollback"
        s.flush()
        s.rollback()
    assert state(tv)["catalogVersion"] == before["catalogVersion"]
    with Session(db.get_engine()) as s:
        s.execute(update(Item).where(Item.id == "e1").values(name="Bulk"))
        s.commit()
    assert state(tv)["catalogVersion"] != before["catalogVersion"]


def test_unpublish_removes_folder_and_offline_permission(tv):
    before = state(tv)
    assert folder(tv, before)["id"] == "series"
    with Session(db.get_engine()) as s:
        s.add(ResourceState(item_id="series", status="draft", ready=True))
        s.commit()
    after = state(tv)
    assert after["catalogVersion"] != before["catalogVersion"]
    assert (
        tv.get("/api/tv/catalog/manifest", params={"version": after["catalogVersion"]}).json()[
            "folders"
        ]
        == []
    )
    from mollytime_server.api.tv_sync import read_grant

    assert read_grant(after["offlineGrant"]["token"])["permissions"] == []


def test_offline_ingest_is_signed_and_idempotent(tv):
    info = state(tv)
    from mollytime_server.api.tv_sync import read_grant

    permission = read_grant(info["offlineGrant"]["token"])["permissions"][0]
    entry = dict(
        permission,
        id=str(uuid.uuid4()),
        startedAt=info["serverTime"],
        grant=info["offlineGrant"]["token"],
        events=[event()],
    )
    body = {"sessions": [entry]}
    result = tv.post("/api/tv/offline-events", json=body)
    assert result.status_code == 200, result.text
    assert tv.post("/api/tv/offline-events", json=body).json() == result.json()
    entry["grant"] += "broken"
    assert tv.post("/api/tv/offline-events", json=body).status_code == 403


def test_sync_requires_device(parent):  # noqa: F811 -- shared fixture
    assert parent.get("/api/tv/sync-state").status_code in (401, 403)


def test_move_invalidates_both_folders_and_other_family_isolated(tv):
    with Session(db.get_engine()) as s:
        s.add(Item(id="other-series", family_id="f1", type="Series", name="Other"))
        s.commit()
    from mollytime_server.catalog_versions import version

    with Session(db.get_engine()) as s:
        old = version(s, "f1", "folder:series")
        new = version(s, "f1", "folder:other-series")
        foreign = version(s, "f2", "catalog")
        s.execute(update(Item).where(Item.id == "e1").values(parent_id="other-series"))
        s.commit()
    with Session(db.get_engine()) as s:
        assert version(s, "f1", "folder:series") != old
        assert version(s, "f1", "folder:other-series") != new
        assert version(s, "f2", "catalog") == foreign


def test_home_draft_does_not_invalidate_published_content(tv):
    before = state(tv)
    from mollytime_server.management_models import HomeConfig, HomeRevision

    with Session(db.get_engine()) as s:
        config = HomeConfig(id="config1", family_id="f1", draft={"rows": []})
        s.add(config)
        s.flush()
        s.add(HomeRevision(id="revision1", config_id=config.id, content={"rows": []}, user_id="u1"))
        s.commit()
    assert state(tv)["homeVersion"] == before["homeVersion"]


def test_late_offline_session_cannot_roll_back_newer_resume(tv):
    info = state(tv)
    from mollytime_server.api.tv_sync import read_grant

    permission = read_grant(info["offlineGrant"]["token"])["permissions"][0]
    online = tv.post("/api/playback/sessions", json={"episodeId": "e1"}).json()["sessionId"]
    assert (
        tv.post(f"/api/playback/sessions/{online}/events", json=event(position=9000)).status_code
        == 200
    )
    offline = dict(
        permission,
        id=str(uuid.uuid4()),
        startedAt=info["serverTime"],
        grant=info["offlineGrant"]["token"],
        events=[event(position=1000)],
    )
    result = tv.post("/api/tv/offline-events", json={"sessions": [offline]})
    assert result.status_code == 200, result.text
    projection = tv.get("/api/tv/playback-state").json()
    assert next(p for p in projection["progress"] if p["episodeId"] == "e1")["positionMs"] == 9000


def test_revocation_never_serves_an_offline_grant(tv):
    state(tv)
    with Session(db.get_engine()) as s:
        s.get(Device, "tv1").revoked = True
        s.commit()
    assert tv.get("/api/tv/sync-state").status_code == 401
