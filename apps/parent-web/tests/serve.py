"""Disposable real API fixture; never touches the household database."""

import os
import subprocess
import tempfile
from pathlib import Path

import uvicorn

workspace = tempfile.TemporaryDirectory(prefix="molly-parent-e2e-")
root = Path(workspace.name)
os.environ["MOLLY_DATA_DIR"] = str(root)
os.environ["MOLLY_MEDIA_DIR"] = str(root)

from molly_server.auth import hash_password
from molly_server.db import get_session_factory, init_db
from molly_server.main import create_app
from molly_server.models import ChildProfile, Family, Item, MediaFile, User

init_db()
subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0x237a70:s=480x270:d=2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(root / "sample.mp4")], check=True)
with get_session_factory()() as db:
    db.add(Family(id="family", name="我们的家庭"))
    db.add(User(id="parent", family_id="family", name="parent", password_hash=hash_password("parent-e2e")))
    db.add(ChildProfile(id="child", family_id="family", name="小米"))
    db.add_all([Item(id="series", family_id="family", type="Series", name="英语启蒙"),
                Item(id="season", family_id="family", type="Season", name="第 1 季", parent_id="series"),
                Item(id="episode", family_id="family", type="Episode", name="Hello", parent_id="season", runtime_ticks=20_000_000)])
    db.add(MediaFile(id="media", family_id="family", item_id="episode", kind="video", storage="local", path="sample.mp4", mime="video/mp4"))
    db.commit()

uvicorn.run(create_app(), host="127.0.0.1", port=8098, log_level="warning")
