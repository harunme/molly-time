import hashlib
import json

import pytest
from test_management import parent  # noqa: F401 -- operator fixture dependency
from test_operations import operator  # noqa: F401 -- superadmin cookie fixture
from test_tv_playback import client  # noqa: F401 -- shared isolated fixture

from mollytime_server.client_releases import (
    ClientRelease,
    archive_release,
    history_path,
    local_apk,
    manifest_path,
)
from mollytime_server.scripts import publish_tv_release as publisher


def record(package="com.molly.tv", storage="local", version=4):
    apk = b"signed-apk-fixture"
    digest = hashlib.sha256(apk).hexdigest()
    release = ClientRelease(
        packageName=package,
        versionCode=version,
        versionName="0.5.0",
        minSdk=23,
        size=len(apk),
        sha256=digest,
        notes="New player",
        storage=storage,
        key=f"releases/tv/{package}/{version}/{digest}.apk",
    )
    path = manifest_path(package)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(release.model_dump_json())
    if storage == "local":
        file = local_apk(release)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(apk)
    return release, apk


def test_public_discovery_and_download_are_channel_specific(client):  # noqa: F811 -- imported pytest fixture
    client.headers.pop("Authorization")
    assert client.get("/api/client/releases/latest").json() == {"release": None}
    release, apk = record()
    response = client.get("/api/client/releases/latest")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    data = response.json()["release"]
    assert data["sha256"] == release.sha256
    assert "key" not in data and "storage" not in data
    downloaded = client.get(data["url"])
    assert downloaded.status_code == 200 and downloaded.content == apk
    assert downloaded.headers["content-type"] == "application/vnd.android.package-archive"
    assert client.get(data["url"].replace("/4/", "/3/")).status_code == 404
    assert client.get("/api/client/releases/latest?packageName=com.molly.tv.debug").json() == {
        "release": None
    }
    assert client.get("/api/client/releases/latest?packageName=../../secret").status_code == 422
    record(package="com.molly.tv.debug")
    assert (
        client.get("/api/client/releases/latest?packageName=com.molly.tv.debug").json()["release"][
            "packageName"
        ]
        == "com.molly.tv.debug"
    )


def test_private_oss_urls_are_resigned_without_credentials(client, monkeypatch):  # noqa: F811 -- imported pytest fixture
    release, _ = record(storage="oss")
    calls = []

    class Cloud:
        def signed_url(self, key, ttl):
            calls.append((key, ttl))
            return f"https://bucket.example/{key}?signature={len(calls)}"

    from mollytime_server.api import client_updates

    monkeypatch.setattr(client_updates, "build_storage", lambda kind: Cloud())
    one = client.get("/api/client/releases/latest").json()["release"]
    two = client.get("/api/client/releases/latest").json()["release"]
    assert one["url"] != two["url"]
    assert calls[0][0] == release.key
    assert "access_key" not in json.dumps(one)


def test_corrupt_or_missing_release_fails_closed(client):  # noqa: F811 -- imported pytest fixture
    release, _ = record()
    local_apk(release).unlink()
    assert client.get("/api/client/releases/latest").status_code == 503
    data = release.model_dump()
    data["key"] = "../../server.db"
    manifest_path(release.packageName).write_text(json.dumps(data))
    assert client.get("/api/client/releases/latest").status_code == 503


def test_publisher_advances_only_after_upload_and_rejects_reused_versions(
    client,  # noqa: F811 -- imported pytest fixture
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(
        publisher,
        "inspect_apk",
        lambda apk, tools: {
            "packageName": "com.molly.tv",
            "versionCode": 4,
            "versionName": "0.5.0",
            "minSdk": 23,
        },
    )
    apk = tmp_path / "source.apk"
    apk.write_bytes(b"a-new-apk")
    release = publisher.publish(apk, "local", "Notes", tmp_path)
    assert local_apk(release).read_bytes() == apk.read_bytes()
    assert publisher.publish(apk, "local", "Notes", tmp_path) == release
    local_apk(release).unlink()
    assert publisher.publish(apk, "local", "Notes", tmp_path) == release
    assert local_apk(release).read_bytes() == apk.read_bytes()
    apk.write_bytes(b"changed-without-a-version-bump")
    with pytest.raises(ValueError, match="versionCode"):
        publisher.publish(apk, "local", "Notes", tmp_path)
    assert (
        manifest_path(release.packageName).read_text() == release.model_dump_json(indent=2) + "\n"
    )
    monkeypatch.setattr(
        publisher,
        "inspect_apk",
        lambda apk, tools: {
            "packageName": "com.molly.tv",
            "versionCode": 5,
            "versionName": "0.6.0",
            "minSdk": 23,
        },
    )

    class BrokenCloud:
        def put_file(self, *args):
            raise OSError("upload failed")

    monkeypatch.setattr(publisher, "build_storage", lambda kind: BrokenCloud())
    with pytest.raises(OSError):
        publisher.publish(apk, "oss", "", tmp_path)
    assert client.get("/api/client/releases/latest").json()["release"]["versionCode"] == 4


def test_same_apk_can_move_to_oss_without_version_reuse(client, tmp_path, monkeypatch):  # noqa: F811
    metadata = {
        "packageName": "com.molly.tv",
        "versionCode": 4,
        "versionName": "0.5.0",
        "minSdk": 23,
    }
    monkeypatch.setattr(publisher, "inspect_apk", lambda apk, tools: metadata)
    apk = tmp_path / "source.apk"
    apk.write_bytes(b"same-apk")
    publisher.publish(apk, "local", "Notes", tmp_path)

    class Cloud:
        def put_file(self, key, file, mime):
            assert file.read_bytes() == apk.read_bytes()

        def size(self, key):
            return apk.stat().st_size

    monkeypatch.setattr(publisher, "build_storage", lambda kind: Cloud())
    release = publisher.publish(apk, "oss", "Notes", tmp_path)
    assert release.storage == "oss"
    assert release.versionCode == 4


def test_operator_inventory_preserves_history_and_downloads(operator, tmp_path, monkeypatch):  # noqa: F811
    metadata = {
        "packageName": "com.molly.tv",
        "versionCode": 3,
        "versionName": "0.4.0",
        "minSdk": 23,
    }
    monkeypatch.setattr(publisher, "inspect_apk", lambda apk, tools: metadata.copy())
    apk = tmp_path / "source.apk"
    apk.write_bytes(b"old-apk")
    old = publisher.publish(apk, "local", "Old player", tmp_path)
    metadata.update(versionCode=4, versionName="0.5.0")
    apk.write_bytes(b"new-apk")
    new = publisher.publish(apk, "local", "New player", tmp_path)
    record(package="com.molly.tv.debug", version=5)
    path = "/api/manage/operations/client-releases"
    response = operator.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    assert result["total"] == 3
    assert [item["versionCode"] for item in result["items"]] == [4, 3, 5]
    assert [item["isCurrent"] for item in result["items"]] == [True, False, True]
    assert result["items"][0]["publishedAt"] and result["items"][1]["publishedAt"]
    assert result["items"][2]["publishedAt"] is None
    assert operator.get(path + "?packageName=com.molly.tv.debug").json()["total"] == 1
    assert operator.get(path + "?page=2&pageSize=1").json()["items"][0]["versionCode"] == 3
    assert operator.get(path + "?page=0").status_code == 422
    assert operator.get(path + "?packageName=other").status_code == 422
    old_path = f"{path}/{old.packageName}/{old.versionCode}/{old.sha256}"
    url = operator.get(old_path + "/download-url").json()["url"]
    assert operator.get(url).content == b"old-apk"
    assert operator.get(old_path.replace(old.sha256, "b" * 64) + "/file").status_code == 404
    local_apk(old).unlink()
    result = operator.get(path).json()
    assert not result["items"][1]["canDownload"]
    assert operator.get(old_path + "/download-url").status_code == 404
    # History remains independent of the current manifest.
    assert history_path(new).is_file() and history_path(old).is_file()


def test_inventory_and_historical_files_require_superadmin(parent):  # noqa: F811
    release, _ = record()
    path = "/api/manage/operations/client-releases"
    endpoints = [
        path,
        f"{path}/{release.packageName}/{release.versionCode}/{release.sha256}/download-url",
        f"{path}/{release.packageName}/{release.versionCode}/{release.sha256}/file",
    ]
    for endpoint in endpoints:
        assert parent.get(endpoint).status_code == 403
    parent.cookies.clear()
    for endpoint in endpoints:
        assert parent.get(endpoint).status_code == 401


def test_operator_oss_history_download_and_destination_guard(operator, monkeypatch):  # noqa: F811
    release, _ = record(storage="oss")
    archive_release(release)
    manifest_path(release.packageName).unlink()

    class Cloud:
        def size(self, key):
            assert key == release.key
            return release.size

        def signed_url(self, key, ttl):
            return f"https://bucket.example/{key}?temporary=signature"

    from mollytime_server.api import manage_client_releases

    monkeypatch.setattr(manage_client_releases, "build_storage", lambda backend: Cloud())
    path = f"/api/manage/operations/client-releases/{release.packageName}/{release.versionCode}/{release.sha256}"
    assert operator.get(path + "/download-url").json()["url"].startswith("https://bucket.example/")
    assert operator.get(path + "/file").status_code == 404
    # Even retired OSS APKs must keep their original bucket accessible.
    from test_operations import body

    assert operator.put("/api/manage/operations/storage", json=body()).status_code == 409


def test_inventory_survives_corrupt_history_without_exposing_paths(operator):  # noqa: F811
    release, _ = record()
    path = history_path(release)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"key":"../../server.db"}')
    result = operator.get("/api/manage/operations/client-releases").json()
    assert result["total"] == 1 and result["invalidRecords"] == 1
    assert "server.db" not in json.dumps(result)


def test_ci_publication_checks_plan_and_preserves_provenance_on_manual_reupload(
    operator,  # noqa: F811
    tmp_path,
    monkeypatch,
):
    from mollytime_server.ci_release_plan import CiReleasePlan

    metadata = {
        "packageName": "com.molly.tv",
        "versionCode": 4,
        "versionName": "0.4.0+4",
        "minSdk": 23,
    }
    monkeypatch.setattr(publisher, "inspect_apk", lambda file, tools: metadata.copy())
    apk = tmp_path / "signed.apk"
    apk.write_bytes(b"ci-apk")
    plan = CiReleasePlan(
        schemaVersion=1,
        requiresApk=True,
        sourceCommit="a" * 40,
        sourceFingerprint="b" * 64,
        versionCode=4,
        versionName="0.4.0+4",
        expectedRelease=None,
        reason="no-baseline",
        inputCount=20,
    )
    release = publisher.publish(apk, "local", "CI", tmp_path, plan)
    assert release.sourceFingerprint == "b" * 64 and release.sourceCommit == "a" * 40
    manual = publisher.publish(apk, "local", "Changed notes", tmp_path)
    assert manual.sourceFingerprint == release.sourceFingerprint
    assert manual.sourceCommit == release.sourceCommit
    with pytest.raises(ValueError, match="changed after CI planning"):
        publisher.publish(apk, "local", "CI", tmp_path, plan)
    assert publisher.read_release("com.molly.tv") == manual


def test_ci_does_not_publish_an_apk_with_wrong_version_or_channel(operator, tmp_path, monkeypatch):  # noqa: F811
    from mollytime_server.ci_release_plan import CiReleasePlan

    monkeypatch.setattr(
        publisher,
        "inspect_apk",
        lambda file, tools: {
            "packageName": "com.molly.tv.debug",
            "versionCode": 4,
            "versionName": "0.4.0+4",
            "minSdk": 23,
        },
    )
    apk = tmp_path / "signed.apk"
    apk.write_bytes(b"wrong-channel")
    plan = CiReleasePlan(
        schemaVersion=1,
        requiresApk=True,
        sourceCommit="a" * 40,
        sourceFingerprint="b" * 64,
        versionCode=4,
        versionName="0.4.0+4",
        expectedRelease=None,
        reason="no-baseline",
        inputCount=20,
    )
    with pytest.raises(ValueError, match="does not match"):
        publisher.publish(apk, "local", "CI", tmp_path, plan)
    assert publisher.read_release("com.molly.tv") is None
