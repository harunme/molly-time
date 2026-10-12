import json
import subprocess
from types import SimpleNamespace

import pytest
from test_management import parent  # noqa: F401
from test_operations import operator  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server.api import client_release_uploads
from mollytime_server.client_releases import local_apk, read_release, release_dir
from mollytime_server.scripts import publish_tv_release as publisher

PREFIX = "/api/manage/operations/client-releases"


@pytest.fixture
def upload_enabled(monkeypatch):
    monkeypatch.setattr(client_release_uploads, "tools_ready", lambda: True)
    metadata = {
        "packageName": "com.molly.tv",
        "versionCode": 4,
        "versionName": "0.5.0",
        "minSdk": 23,
        "signerSha256": ["a" * 64],
    }
    monkeypatch.setattr(publisher, "inspect_apk", lambda file, tools: metadata.copy())
    return metadata


def begin(connection, data=b"valid-fixture-apk", **extra):
    response = connection.post(
        PREFIX + "/uploads",
        json={
            "filename": "molly.apk",
            "size": len(data),
            "storage": "local",
            "notes": "更新播放器",
            **extra,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_upload_permissions_and_csrf(operator, upload_enabled):  # noqa: F811
    assert (
        operator.post(
            PREFIX + "/uploads",
            headers={"X-CSRF-Token": ""},
            json={"filename": "molly.apk", "size": 4},
        ).status_code
        == 403
    )
    identifier = begin(operator, b"test")
    assert (
        operator.put(
            PREFIX + "/uploads/" + identifier, content=b"test", headers={"X-CSRF-Token": ""}
        ).status_code
        == 403
    )
    assert (
        operator.put(
            PREFIX + "/uploads/" + identifier,
            content=b"test",
            headers={"Origin": "https://evil.example"},
        ).status_code
        == 403
    )


def test_family_admin_cannot_initialize_or_upload(parent, upload_enabled):  # noqa: F811
    assert parent.get(PREFIX + "/upload-options").status_code == 403
    assert (
        parent.post(PREFIX + "/uploads", json={"filename": "molly.apk", "size": 4}).status_code
        == 403
    )
    assert parent.put(PREFIX + "/uploads/" + "b" * 32, content=b"test").status_code == 403


def test_upload_publishes_and_cleans_staging(operator, upload_enabled):  # noqa: F811
    data = b"valid-fixture-apk"
    identifier = begin(operator, data)
    response = operator.put(PREFIX + "/uploads/" + identifier, content=data)
    assert response.status_code == 200, response.text
    release = read_release("com.molly.tv")
    assert local_apk(release).read_bytes() == data
    assert release.signerSha256 == ["a" * 64]
    assert release.notes == "更新播放器" and release.publishedAt
    assert not list((release_dir() / "uploads").iterdir())
    assert operator.get(PREFIX).json()["total"] == 1
    assert operator.put(PREFIX + "/uploads/" + identifier, content=data).status_code == 404


def test_rejects_changed_signer_and_reused_build_number(operator, upload_enabled):  # noqa: F811
    first = begin(operator, b"first")
    assert operator.put(PREFIX + "/uploads/" + first, content=b"first").status_code == 200
    original = read_release("com.molly.tv")
    repeated = begin(operator, b"other")
    assert operator.put(PREFIX + "/uploads/" + repeated, content=b"other").status_code == 409
    upload_enabled.update(versionCode=5, signerSha256=["b" * 64])
    wrong_signer = begin(operator, b"other")
    assert operator.put(PREFIX + "/uploads/" + wrong_signer, content=b"other").status_code == 422
    assert read_release("com.molly.tv") == original
    assert local_apk(original).read_bytes() == b"first"


def test_stream_limits_and_incomplete_upload_cleanup(operator, upload_enabled):  # noqa: F811
    identifier = begin(operator, b"12345")
    oversized = operator.put(PREFIX + "/uploads/" + identifier, content=iter([b"123", b"456"]))
    assert oversized.status_code == 413
    assert not list((release_dir() / "uploads").iterdir())
    identifier = begin(operator, b"12345")
    incomplete = operator.put(PREFIX + "/uploads/" + identifier, content=iter([b"123"]))
    assert incomplete.status_code == 422
    assert read_release("com.molly.tv") is None
    assert not list((release_dir() / "uploads").iterdir())


def test_invalid_signature_tools_and_expired_ticket(operator, upload_enabled, monkeypatch):  # noqa: F811
    identifier = begin(operator)

    def invalid(file, tools):
        raise subprocess.CalledProcessError(1, ["apksigner", "verify"])

    monkeypatch.setattr(publisher, "inspect_apk", invalid)
    assert (
        operator.put(PREFIX + "/uploads/" + identifier, content=b"valid-fixture-apk").status_code
        == 422
    )
    assert read_release("com.molly.tv") is None
    identifier = begin(operator)
    ticket = release_dir() / "uploads" / f"{identifier}.json"
    value = json.loads(ticket.read_text())
    value["expiresAt"] = "2000-01-01T00:00:00+00:00"
    ticket.write_text(json.dumps(value))
    assert (
        operator.put(PREFIX + "/uploads/" + identifier, content=b"valid-fixture-apk").status_code
        == 410
    )
    monkeypatch.setattr(client_release_uploads, "tools_ready", lambda: False)
    assert not operator.get(PREFIX + "/upload-options").json()["canUpload"]
    assert (
        operator.post(PREFIX + "/uploads", json={"filename": "molly.apk", "size": 4}).status_code
        == 503
    )


def test_rejects_invalid_files_size_and_unconfigured_oss(operator, upload_enabled):  # noqa: F811
    for body in (
        {"filename": "molly.zip", "size": 4},
        {"filename": "molly.apk", "size": 0},
        {"filename": "molly.apk", "size": 512 * 1024**2 + 1},
        {"filename": "molly.apk", "size": 4, "storage": "oss"},
    ):
        assert operator.post(PREFIX + "/uploads", json=body).status_code == 422


def test_cancel_unstarted_upload_removes_ticket(operator, upload_enabled):  # noqa: F811
    identifier = begin(operator)
    assert operator.delete(PREFIX + "/uploads/" + identifier).status_code == 200
    assert (
        operator.put(PREFIX + "/uploads/" + identifier, content=b"valid-fixture-apk").status_code
        == 404
    )
    assert not list((release_dir() / "uploads").iterdir())


def test_oss_upload_and_failed_publication_keep_current_version(
    operator,  # noqa: F811
    upload_enabled,
    monkeypatch,
):
    monkeypatch.setattr(
        client_release_uploads,
        "get_storage_settings",
        lambda: SimpleNamespace(
            oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com",
            oss_bucket="test-bucket",
            oss_access_key_id="test-id",
            oss_access_key_secret="test-secret",
        ),
    )
    objects = {}

    class Cloud:
        def put_file(self, key, path, mime):
            objects[key] = path.read_bytes()

        def size(self, key):
            return len(objects[key])

    monkeypatch.setattr(publisher, "build_storage", lambda backend: Cloud())
    identifier = begin(operator, storage="oss")
    response = operator.put(PREFIX + "/uploads/" + identifier, content=b"valid-fixture-apk")
    assert response.status_code == 200, response.text
    original = read_release("com.molly.tv")
    assert original.storage == "oss" and objects[original.key] == b"valid-fixture-apk"
    upload_enabled.update(versionCode=5)

    class BrokenCloud(Cloud):
        def put_file(self, *args):
            raise OSError("test-secret failed-upload")

    monkeypatch.setattr(publisher, "build_storage", lambda backend: BrokenCloud())
    identifier = begin(operator, storage="oss")
    response = operator.put(PREFIX + "/uploads/" + identifier, content=b"valid-fixture-apk")
    assert response.status_code == 503 and "test-secret" not in response.text
    assert read_release("com.molly.tv") == original
