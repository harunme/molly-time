# ruff: noqa: F811 -- shared isolated fixtures
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_operations import operator  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.accounts import ensure_identity
from mollytime_server.models import Family, MediaFile, User
from mollytime_server.storage_quotas import DEFAULT_STORAGE_LIMIT_BYTES, storage_limit

ROOT = "/api/manage/operations/users"


def change(web, value, expected=DEFAULT_STORAGE_LIMIT_BYTES, user="u1"):
    return web.put(f"{ROOT}/{user}/storage", json={
        "limitBytes": value, "expectedLimitBytes": expected,
    })


def test_new_defaults_legacy_preservation_and_idempotent_migration(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE families (id VARCHAR(36) PRIMARY KEY, name VARCHAR(128), created_at DATETIME)")
        connection.exec_driver_sql("INSERT INTO families (id, name) VALUES ('old', 'Legacy')")
    db.upgrade_storage_quotas(engine)
    db.upgrade_storage_quotas(engine)
    # Family ORM writes trigger watch-rollup hooks. Complete the surrounding
    # schema after exercising the legacy ALTER, as normal startup does.
    db.Base.metadata.create_all(engine)
    with Session(engine) as session:
        assert session.get(Family, "old").storage_limit_bytes is None
        assert storage_limit(session, "old") == config.get_settings().family_storage_limit_bytes
        session.add(Family(id="new", name="New"))
        session.commit()
        assert storage_limit(session, "new") == DEFAULT_STORAGE_LIMIT_BYTES
        session.get(Family, "old").storage_limit_bytes = 10 * 1024**3
        session.commit()
    db.upgrade_storage_quotas(engine)
    with Session(engine) as session:
        assert storage_limit(session, "old") == 10 * 1024**3
    engine.dispose()


def test_list_search_pagination_and_shared_family_limits(operator):
    with Session(db.get_engine()) as session:
        session.add_all([
            User(id="same", family_id="f1", name="second-parent", password_hash="private", role="member"),
            User(id="other", family_id="f2", name="other-parent", password_hash="private"),
        ])
        session.flush()
        ensure_identity(session, session.get(User, "same")).email = "second@example.test"
        session.commit()
    result = operator.get(ROOT + "?pageSize=1").json()
    assert result["total"] == 3 and len(result["items"]) == 1
    assert "password" not in str(result)
    matched = operator.get(ROOT + "?q=second@example.test").json()["items"]
    assert len(matched) == 1 and matched[0]["id"] == "same"
    assert operator.get(ROOT + "?q=%25").json()["total"] == 0
    assert change(operator, 10 * 1024**3).status_code == 200
    rows = {row["id"]: row for row in operator.get(ROOT).json()["items"]}
    assert rows["same"]["storage"]["limitBytes"] == rows["u1"]["storage"]["limitBytes"] == 10 * 1024**3
    assert rows["other"]["storage"]["limitBytes"] == DEFAULT_STORAGE_LIMIT_BYTES
    assert operator.get("/api/manage/settings").json()["storage"]["limitBytes"] == 10 * 1024**3
    assert change(operator, 1).status_code == 409
    assert change(operator, 1, user="missing").status_code == 404


@pytest.mark.parametrize("value", [-1, 1.5, True, "5", None, 2**53])
def test_invalid_limits_cannot_change_storage(operator, value):
    assert change(operator, value).status_code == 422
    assert operator.get("/api/manage/settings").json()["storage"]["limitBytes"] == DEFAULT_STORAGE_LIMIT_BYTES


def test_permissions_csrf_and_legacy_override(parent):
    assert parent.get(ROOT).status_code == 403
    assert change(parent, 0).status_code == 403
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        session.commit()
    assert parent.get(ROOT).status_code == 403
    assert change(parent, 0).status_code == 403
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "superadmin"
        session.execute(text("UPDATE families SET storage_limit_bytes = NULL WHERE id = 'f1'"))
        session.commit()
    assert parent.put(ROOT + "/u1/storage", json={"limitBytes": 1, "expectedLimitBytes": 0}, headers={"X-CSRF-Token": ""}).status_code == 403
    config.get_settings().family_storage_limit_bytes = 100
    assert parent.get("/api/manage/settings").json()["storage"]["limitBytes"] == 100
    assert change(parent, 0, expected=100).status_code == 200
    assert parent.get("/api/manage/settings").json()["storage"]["limitBytes"] == 0


def test_upload_reservations_limit_and_lowering_do_not_delete_files(operator):
    usage = operator.get("/api/manage/settings").json()["storage"]
    used = usage["usedBytes"]
    assert change(operator, used + 10).status_code == 200
    first = operator.post("/api/manage/uploads", json={
        "itemId": "e1", "filename": "new.mp4", "size": 10, "kind": "video", "fingerprint": "quota-video",
    })
    assert first.status_code == 200, first.text
    second = operator.post("/api/manage/uploads", json={
        "itemId": "e1", "filename": "cover.jpg", "size": 1, "kind": "image", "fingerprint": "quota-image",
    })
    assert second.status_code == 507
    assert change(operator, 1, expected=used + 10).status_code == 200
    with Session(db.get_engine()) as session:
        assert session.get(MediaFile, "v1") is not None
    assert operator.get("/api/manage/settings").json()["storage"]["usedBytes"] == used
    assert change(operator, 0, expected=1).status_code == 200
    assert operator.post("/api/manage/uploads", json={
        "itemId": "e1", "filename": "cover.jpg", "size": 1, "kind": "image", "fingerprint": "quota-image",
    }).status_code == 200
