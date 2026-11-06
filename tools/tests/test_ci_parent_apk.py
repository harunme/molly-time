"""Parent builds have their own native inputs, history, package identity and force switch."""

import datetime as dt
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "ci_parent_apk", Path(__file__).resolve().parents[1] / "ci_tv_apk.py"
)
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


@pytest.fixture
def repository(tmp_path):
    files = {
        "apps/android/settings.gradle.kts": 'include(":app")',
        "apps/android/app/src/main/AndroidManifest.xml": "manifest",
        "apps/android/app/src/main/java/Main.kt": "parent",
        "apps/android/app/build.gradle.kts": "build",
        "apps/android/app/version.properties": "versionCode=2\nversionName=0.1.1\nversionEpoch=2026-11\n",
        "apps/android/gradle/wrapper/gradle-wrapper.jar": "wrapper",
        "tools/ci_tv_apk.py": "planner",
        "tools/parent-apk-build.json": "sdk",
        "tools/build-android.sh": "build",
        "tools/package-startup-sound.py": "sound",
        "tools/android-env.sh": "env",
    }
    for name, value in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    return tmp_path


def test_first_parent_build_has_independent_channel(repository):
    result = ci.plan(
        repository,
        {"current": None, "highestVersionCode": 0, "versionNames": []},
        "a" * 40,
        target="parent",
        release_date=dt.date(2026, 11, 6),
    )
    assert result["packageName"] == "com.molly.parent"
    assert (
        result["requiresApk"]
        and result["versionCode"] == 3
        and result["versionName"] == "0.1.1"
    )


@pytest.mark.parametrize(
    "name",
    [
        "apps/tv/client/src/main/java/Player.kt",
        "apps/web/src/Page.tsx",
        "apps/server/api.py",
        "apps/android/app/src/test/Test.kt",
        "apps/android/app/build/generated/BuildConfig.java",
        "apps/android/app/release.properties",
    ],
)
def test_web_tv_tests_and_private_files_do_not_trigger_parent_apk(repository, name):
    before = ci.fingerprint(repository, "parent")[0]
    path = repository / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("changed")
    assert ci.fingerprint(repository, "parent")[0] == before


def test_native_change_and_force_use_parent_history(repository):
    before = ci.fingerprint(repository, "parent")[0]
    state = {
        "current": {
            "versionCode": 8,
            "versionName": "0.1.2",
            "sha256": "a" * 64,
            "sourceFingerprint": before,
        },
        "highestVersionCode": 12,
        "versionNames": ["0.1.2", "0.1.5"],
    }
    assert not ci.plan(repository, state, "b" * 40, target="parent")["requiresApk"]
    (repository / "apps/android/app/src/main/java/Main.kt").write_text("new")
    result = ci.plan(
        repository, state, "b" * 40, target="parent", release_date=dt.date(2026, 11, 6)
    )
    assert (
        result["requiresApk"]
        and result["versionCode"] == 13
        and result["versionName"] == "0.1.6"
    )


def test_real_parent_recipe_and_private_key_exclusion():
    root = Path(__file__).resolve().parents[2]
    digest, files = ci.fingerprint(root, "parent")
    assert (
        len(digest) == 64 and "apps/android/app/src/main/AndroidManifest.xml" in files
    )
    assert all(
        ".local/" not in name
        and "/build/" not in name
        and not name.endswith((".jks", ".keystore"))
        for name in files
    )
