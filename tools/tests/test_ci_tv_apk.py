"""Native build decisions are independent of web changes, CI run numbers and secrets."""

import base64
import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("ci_tv_apk", Path(__file__).resolve().parents[1] / "ci_tv_apk.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


@pytest.fixture
def repository(tmp_path):
    files = {
        "apps/tv/settings.gradle.kts": 'include(":client")',
        "apps/tv/client/src/main/AndroidManifest.xml": "manifest",
        "apps/tv/client/src/main/java/Player.kt": "native-player",
        "apps/tv/client/src/main/res/raw/icon.xml": "icon",
        "apps/tv/client/version.properties": "versionCode=3\nversionName=0.1.1\nversionEpoch=2026-10\n",
        "apps/tv/client/build.gradle.kts": "android-build",
        "apps/tv/gradle/libs.versions.toml": "dependency-versions",
        "apps/tv/gradle/wrapper/gradle-wrapper.jar": "gradle-wrapper",
        "apps/tv/buildSrc/src/main/kotlin/Build.kt": "build-helper",
        "tools/ci_tv_apk.py": "decision-recipe",
        "tools/tv-apk-build.json": "sdk-recipe",
        "tools/build-tv-client.sh": "build-recipe",
        "tools/android-env.sh": "build-environment",
    }
    for name, content in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return tmp_path


def state(digest, code=8, highest=8):
    return {"current": {"versionCode": code, "versionName": "0.4.0+8", "sha256": "a" * 64, "sourceFingerprint": digest}, "highestVersionCode": highest, "versionNames": ["0.4.0+8"]}


def test_first_build_unknown_baseline_and_failed_build_retry(repository):
    initial = {"current": None, "highestVersionCode": 0, "versionNames": []}
    first = ci.plan(repository, initial, "a" * 40, release_date=dt.date(2026, 10, 14))
    assert first["requiresApk"] and first["versionCode"] == 4
    assert first["versionName"] == "0.1.1"
    assert ci.plan(repository, initial, "a" * 40, release_date=dt.date(2026, 10, 14)) == first
    assert ci.plan(repository, initial, "b" * 40)["versionCode"] == 4
    legacy = ci.plan(repository, state(None, 8, 11), "a" * 40)
    assert legacy["requiresApk"] and legacy["versionCode"] == 12


def test_web_api_docs_tests_and_build_outputs_do_not_require_apk(repository):
    digest, _ = ci.fingerprint(repository)
    for name in ("apps/web/src/main.tsx", "apps/tv/web/src/main.tsx", "apps/server/api.py", "docs/readme.md", "apps/tv/client/README.md", "apps/tv/client/src/test/PlayerTest.kt", "apps/tv/client/build/generated/Player.kt", "apps/tv/app/src/main/Legacy.kt", "apps/tv/client/local.properties", "apps/tv/client/release.properties"):
        path = repository / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("changed")
    result = ci.plan(repository, state(digest), "b" * 40)
    assert not result["requiresApk"] and result["versionCode"] == 8
    assert result["versionName"] == "0.4.0+8"
    assert result["sourceFingerprint"] == digest


@pytest.mark.parametrize("name", [
    "apps/tv/client/src/main/java/Player.kt", "apps/tv/client/src/main/res/raw/icon.xml",
    "apps/tv/client/src/main/AndroidManifest.xml", "apps/tv/client/build.gradle.kts",
    "apps/tv/gradle/libs.versions.toml", "apps/tv/gradle/wrapper/gradle-wrapper.jar",
    "apps/tv/buildSrc/src/main/kotlin/Build.kt", "tools/tv-apk-build.json", "tools/build-tv-client.sh",
])
def test_native_input_changes_allocate_above_history(repository, name):
    digest, _ = ci.fingerprint(repository)
    (repository / name).write_text("new-input")
    result = ci.plan(repository, state(digest, 8, 12), "a" * 40)
    assert result["requiresApk"] and result["versionCode"] == 13


def test_adding_deleting_sources_and_force_rebuild(repository):
    digest, _ = ci.fingerprint(repository)
    source = repository / "apps/tv/client/src/main/java/New.kt"
    source.write_text("new-source")
    assert ci.fingerprint(repository)[0] != digest
    source.unlink()
    assert ci.fingerprint(repository)[0] == digest
    assert ci.plan(repository, state(digest), "a" * 40, force=True)["versionCode"] == 9
    with pytest.raises(ValueError):
        ci.plan(repository, state(digest, 2100000000, 2100000000), "a" * 40, force=True)


def test_rejects_unknown_module_mapping_and_invalid_baseline(repository):
    with pytest.raises(ValueError):
        ci.plan(repository, state("bad-fingerprint"), "a" * 40)
    (repository / "apps/tv/settings.gradle.kts").write_text('include(":client")\nproject(":client").projectDir = file("other")')
    with pytest.raises(ValueError):
        ci.fingerprint(repository)


def test_signing_material_is_private_and_not_overwritten(tmp_path, monkeypatch):
    monkeypatch.setenv("MOLLYTIME_TV_KEYSTORE_BASE64", base64.b64encode(b"private-keystore-fixture").decode())
    monkeypatch.setenv("MOLLYTIME_TV_STORE_PASSWORD", "space password=\\\n☀")
    monkeypatch.setenv("MOLLYTIME_TV_KEY_PASSWORD", "test-password")
    ci.signing_files(tmp_path)
    assert (tmp_path / "release.jks").stat().st_mode & 0o777 == 0o600
    properties = tmp_path / "release.properties"
    assert properties.stat().st_mode & 0o777 == 0o600
    assert "\\n" in properties.read_text() and "\\u2600" in properties.read_text()
    assert "space password" not in properties.read_text()
    with pytest.raises(FileExistsError):
        ci.signing_files(tmp_path)


def test_source_recipe_is_a_real_json_file():
    recipe = json.loads((Path(__file__).resolve().parents[1] / "tv-apk-build.json").read_text())
    assert recipe["javaVersion"] == "21" and recipe["buildTools"] == "36.0.0"


@pytest.mark.parametrize("date, expected", [
    (dt.date(2026, 10, 31), "0.1.4"),
    (dt.date(2026, 11, 1), "0.2.1"),
    (dt.date(2027, 1, 1), "0.4.1"),
])
def test_monthly_versions_use_history_after_rollback(repository, date, expected):
    published = state(None, code=8, highest=12)
    published["current"]["versionName"] = "0.1.1"
    published["versionNames"] = ["0.4.0+7", "0.1.1", "0.1.3", "0.1.3"]
    result = ci.plan(repository, published, "a" * 40, release_date=date)
    assert result["versionName"] == expected
    assert result["versionCode"] == 13


def test_major_upgrade_starts_new_sequence(repository):
    properties = repository / "apps/tv/client/version.properties"
    properties.write_text("versionCode=3\nversionName=1.1.1\nversionEpoch=2026-10\n")
    published = state(None)
    published["versionNames"] = ["0.1.9"]
    result = ci.plan(repository, published, "a" * 40, release_date=dt.date(2026, 10, 14))
    assert result["versionName"] == "1.1.1"


@pytest.mark.parametrize("names, date", [
    (["1.1.1"], dt.date(2026, 10, 14)),
    (["0.2.1"], dt.date(2026, 10, 14)),
    ([], dt.date(2026, 9, 30)),
])
def test_rejects_major_or_calendar_regression(repository, names, date):
    published = state(None)
    published["versionNames"] = names
    with pytest.raises(ValueError):
        ci.plan(repository, published, "a" * 40, release_date=date)


def test_old_receiver_fails_with_actionable_error(repository):
    published = state(None)
    del published["versionNames"]
    with pytest.raises(ValueError, match="update the deployment receiver"):
        ci.plan(repository, published, "a" * 40)
