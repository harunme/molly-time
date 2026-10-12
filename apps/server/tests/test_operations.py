import json

import pytest
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.api import operations
from mollytime_server.management_models import OperationsStorage
from mollytime_server.models import MediaFile, User
from mollytime_server.storage.factory import build_storage
from mollytime_server.storage.settings import get_storage_settings


@pytest.fixture
def operator(parent):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "superadmin"
        session.commit()
    return parent


def body(**extra):
    return dict(
        revision=0,
        storage_backend="oss",
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
        oss_bucket="molly-private",
        oss_access_key_id="private-id",
        oss_access_key_secret="private-secret",
        **extra,
    )


def test_family_admin_cannot_operate(parent):  # noqa: F811
    for method, path in [("get", "/storage"), ("put", "/storage"), ("post", "/storage/test")]:
        res = getattr(parent, method)(
            "/api/manage/operations" + path, **({"json": body()} if method != "get" else {})
        )
        assert res.status_code == 403
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        session.commit()
    assert parent.get("/api/manage/operations/storage").status_code == 403


def test_encrypted_persistence_live_factory_and_revision(operator, monkeypatch):
    checked = []
    monkeypatch.setattr(operations, "test_connection", lambda value: checked.append(value))
    res = operator.put("/api/manage/operations/storage", json=body())
    assert res.status_code == 200
    assert res.json()["credentialsConfigured"] and res.json()["revision"] == 1
    assert "private-id" not in res.text and "private-secret" not in res.text
    assert "oss_access_key_secret" not in res.json()
    with Session(db.get_engine()) as session:
        stored = json.dumps(session.get(OperationsStorage, "storage").config)
        assert "private-secret" not in stored and "private-id" not in stored
    key = config.get_settings().data_dir / "operations-storage.key"
    assert key.stat().st_mode & 0o777 == 0o600
    assert get_storage_settings().oss_access_key_secret == "private-secret"
    assert build_storage().bucket == "molly-private"
    # Fresh DB session / uncached client see the same override, including after restart.
    build_storage.cache_clear()
    assert build_storage().access_key_id == "private-id"
    assert operator.put("/api/manage/operations/storage", json=body()).status_code == 409
    changed = body()
    changed.update(
        revision=1,
        oss_access_key_id="",
        oss_access_key_secret="",
        oss_signed_url_ttl=120,
        storage_backend="local",
    )
    assert operator.put("/api/manage/operations/storage", json=changed).status_code == 200
    assert get_storage_settings().oss_access_key_secret == "private-secret"
    assert build_storage().name == "local"
    assert build_storage("oss").access_key_secret == "private-secret"
    assert len(checked) == 1


def test_superadmin_csrf_and_family_editing(operator):
    assert operator.get("/api/manage/auth/session").json()["user"]["role"] == "superadmin"
    assert operator.post("/api/manage/children", json={"name": "New child"}).status_code == 200
    assert (
        operator.put(
            "/api/manage/operations/storage", json=body(), headers={"X-CSRF-Token": ""}
        ).status_code
        == 403
    )
    assert (
        operator.post(
            "/api/manage/operations/storage/test",
            json=body(),
            headers={"Origin": "https://evil.example"},
        ).status_code
        == 403
    )


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://oss-cn-hangzhou.aliyuncs.com",
        "https://127.0.0.1",
        "https://oss-cn-hangzhou.aliyuncs.com.evil.example",
        "https://user:pass@oss-cn-hangzhou.aliyuncs.com",
        "https://oss-cn-hangzhou.aliyuncs.com/path",
    ],
)
def test_invalid_endpoint_rejected(operator, endpoint):
    data = body()
    data["oss_endpoint"] = endpoint
    assert operator.post("/api/manage/operations/storage/test", json=data).status_code == 422


def test_existing_cloud_files_block_destination_change(operator, monkeypatch):
    monkeypatch.setattr(operations, "test_connection", lambda value: None)
    assert operator.put("/api/manage/operations/storage", json=body()).status_code == 200
    with Session(db.get_engine()) as session:
        session.query(MediaFile).filter(MediaFile.item_id == "e1").update({"storage": "oss"})
        session.commit()
    data = body()
    data.update(revision=1, oss_bucket="another-bucket")
    assert operator.put("/api/manage/operations/storage", json=data).status_code == 409
    data["oss_bucket"] = "molly-private"
    data["storage_backend"] = "local"
    assert operator.put("/api/manage/operations/storage", json=data).status_code == 200


def test_connection_round_trip_and_clean_up(operator, monkeypatch):
    events = []

    class Response:
        def read(self):
            return b"MollyTime OSS connection check"

        def close(self):
            events.append("close")

    class Client:
        def put_object(self, key, data):
            events.append("put")

        def get_object(self, key):
            events.append("get")
            return Response()

        def delete_object(self, key):
            events.append("delete")

    monkeypatch.setattr(operations.OssStorage, "_client", lambda self, internal=False: Client())
    assert operator.post("/api/manage/operations/storage/test", json=body()).status_code == 200
    assert events == ["put", "get", "close", "delete"]

    def fail(self, key):
        raise RuntimeError("private-secret signed-url")

    monkeypatch.setattr(Client, "get_object", fail)
    events.clear()
    res = operator.put("/api/manage/operations/storage", json=body())
    assert res.status_code == 422 and "private-secret" not in res.text
    assert events == ["put", "delete"]
    assert get_storage_settings().revision == 0
