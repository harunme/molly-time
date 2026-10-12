"""Disposable real API fixture; never touches the household database."""

import os
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
    db.add_all([Item(id="series", family_id="family", type="Series", name="英语启蒙"),
                Item(id="season", family_id="family", type="Season", name="第 1 季", parent_id="series"),
                Item(id="episode", family_id="family", type="Episode", name="Hello", parent_id="season", runtime_ticks=20_000_000)])
    db.add(MediaFile(id="media", family_id="family", item_id="episode", kind="video", storage="local", path="sample.mp4", mime="video/mp4"))
    db.add(Item(id="browser-episode", family_id="family", type="Episode", name="Browser fixture", parent_id="season", runtime_ticks=50_000_000))
    db.add(MediaFile(id="browser-media", family_id="family", item_id="browser-episode", kind="video", storage="local", path="browser.webm", mime="video/webm", size_bytes=(root / "browser.webm").stat().st_size))
    db.commit()

uvicorn.run(create_app(), host="127.0.0.1", port=8098, log_level="warning")
