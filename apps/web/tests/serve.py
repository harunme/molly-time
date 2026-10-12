"""Disposable real API fixture; never touches the household database."""

import os
import hashlib
import subprocess
import tempfile
from pathlib import Path

import uvicorn

workspace = tempfile.TemporaryDirectory(prefix="mollytime-parent-e2e-")
root = Path(workspace.name)
os.environ["MOLLYTIME_DATA_DIR"] = str(root)
os.environ["MOLLYTIME_MEDIA_DIR"] = str(root)

from mollytime_server.auth import hash_password
from mollytime_server.db import get_session_factory, init_db
from mollytime_server.main import create_app
from mollytime_server.models import ChildProfile, Family, Item, MediaFile, User
from mollytime_server.client_releases import ClientRelease, archive_release, local_apk, manifest_path

init_db()
subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0x237a70:s=480x270:d=2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(root / "sample.mp4")], check=True)
# Open-source headless Chromium may omit H.264. A legacy WebM fixture exercises
# the browser playback/reporting path without changing the MP4 upload policy.
subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0x237a70:s=320x180:d=5",
                "-c:v", "libvpx", "-y", str(root / "browser.webm")], check=True)
with get_session_factory()() as db:
    db.add(Family(id="family", name="我们的家庭"))
    db.add(User(id="parent", family_id="family", name="parent", password_hash=hash_password("parent-e2e")))
    db.add(User(id="operator", family_id="family", name="operator", role="superadmin", password_hash=hash_password("operator-e2e")))
    db.add(ChildProfile(id="child", family_id="family", name="小米"))
    db.add(ChildProfile(id="autoplay-child", family_id="family", name="连播测试"))
    db.add_all([Item(id="series", family_id="family", type="Series", name="英语启蒙"),
                Item(id="season", family_id="family", type="Season", name="第 1 季", parent_id="series"),
                Item(id="episode", family_id="family", type="Episode", name="Hello", parent_id="season", runtime_ticks=20_000_000)])
    db.add(MediaFile(id="media", family_id="family", item_id="episode", kind="video", storage="local", path="sample.mp4", mime="video/mp4"))
    db.add(Item(id="browser-episode", family_id="family", type="Episode", name="Browser fixture", parent_id="season", index_number=1, runtime_ticks=50_000_000))
    db.add(MediaFile(id="browser-media", family_id="family", item_id="browser-episode", kind="video", storage="local", path="browser.webm", mime="video/webm", size_bytes=(root / "browser.webm").stat().st_size))
    db.add(Item(id="browser-next", family_id="family", type="Episode", name="Browser next", parent_id="season", index_number=2, runtime_ticks=50_000_000))
    db.add(MediaFile(id="browser-next-media", family_id="family", item_id="browser-next", kind="video", storage="local", path="browser.webm", mime="video/webm", size_bytes=(root / "browser.webm").stat().st_size))
    db.commit()

for package, versions in [("com.molly.tv", [(2, "0.3.0"), (3, "0.4.0")]), ("com.molly.tv.debug", [(1, "0.2.0")])]:
    for version, name in versions:
        apk = f"APK fixture {package}/{version}".encode()
        digest = hashlib.sha256(apk).hexdigest()
        release = ClientRelease(
            packageName=package, versionCode=version, versionName=name, minSdk=23,
            size=len(apk), sha256=digest, notes="新增客户端自动更新\n保留家庭配对信息",
            storage="local", key=f"releases/tv/{package}/{version}/{digest}.apk",
            publishedAt="2026-10-12T08:00:00+00:00",
        )
        file = local_apk(release)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(apk)
        archive_release(release)
        manifest_path(package).write_text(release.model_dump_json())

uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("MOLLYTIME_E2E_PORT", "8098")), log_level="warning")
