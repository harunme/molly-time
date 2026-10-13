import io
import shutil
import sqlite3
import subprocess
import uuid

import pytest
from PIL import Image
from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.covers import extract_cover, is_black_cover
from mollytime_server.management_models import UploadSession
from mollytime_server.models import Item, MediaFile
from mollytime_server.repair_covers import main, repair


def picture(color):
    output = io.BytesIO()
    Image.new("RGB", (64, 36), color).save(output, "JPEG")
    return output.getvalue()


def test_black_detection_preserves_dark_and_bright_scenes():
    assert is_black_cover(picture("black"))
    assert is_black_cover(picture((8, 8, 8)))
    assert not is_black_cover(picture((30, 30, 30)))
    assert not is_black_cover(picture("blue"))
    assert not is_black_cover(picture("white"))


def test_cover_process_cannot_read_the_controlling_terminal(tmp_path, monkeypatch):
    def run(command, **kwargs):
        assert "-nostdin" in command
        assert kwargs["stdin"] == subprocess.DEVNULL
        # An extraction result lets the worker finish without an interactive process.
        from pathlib import Path

        Path(command[-1]).write_bytes(picture("blue"))

    monkeypatch.setattr("mollytime_server.covers.subprocess.run", run)
    assert extract_cover(tmp_path / "sample.mp4", 10_000_000) == picture("blue")


@pytest.mark.parametrize("ending, expected", [("blue", True), ("black", False)])
def test_real_extraction_skips_black_intro(tmp_path, ending, expected):
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg required")
    source = tmp_path / "intro.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=160x90:d=4",
            "-f",
            "lavfi",
            "-i",
            f"color={ending}:s=160x90:d=4",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        timeout=20,
    )
    data = extract_cover(source, 80_000_000)
    assert (data is not None) is expected
    if data:
        assert not is_black_cover(data)


def seed_automatic_cover(session):
    root = config.get_settings().resolved_media_dir()
    cover_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "molly-cover:upload"))
    (root / "black.jpg").write_bytes(picture("black"))
    session.add(
        UploadSession(
            id="upload",
            family_id="f1",
            item_id="e1",
            filename="video.mp4",
            kind="video",
            size=10,
            fingerprint="test",
            status="ready",
        )
    )
    session.add(
        MediaFile(
            id=cover_id,
            family_id="f1",
            item_id="e1",
            kind="image",
            storage="local",
            path="black.jpg",
        )
    )
    item = session.get(Item, "e1")
    item.primary_image_tag, item.runtime_ticks = cover_id, 80_000_000
    session.commit()
    return cover_id


def test_repair_dry_run_replacement_and_resize_cache(client, monkeypatch):  # noqa: F811
    with Session(db.get_engine()) as session:
        cover_id = seed_automatic_cover(session)
        before = client.get("/api/items/e1/image?w=480").content
        assert is_black_cover(before)
        monkeypatch.setattr(
            "mollytime_server.repair_covers.extract_cover", lambda *_: picture("blue")
        )
        assert repair(session)[0]["status"] == "would-repair"
        assert session.get(MediaFile, cover_id).path == "black.jpg"
        assert repair(session, apply=True)[0]["status"] == "repaired"
        assert session.get(Item, "e1").primary_image_tag != cover_id
        assert (config.get_settings().resolved_media_dir() / "black.jpg").is_file()
        assert not is_black_cover(client.get("/api/items/e1/image?w=480").content)
        assert repair(session, apply=True) == []


def test_repair_all_black_uses_placeholder(client, monkeypatch):  # noqa: F811
    with Session(db.get_engine()) as session:
        cover_id = seed_automatic_cover(session)
        monkeypatch.setattr("mollytime_server.repair_covers.extract_cover", lambda *_: None)
        assert repair(session, apply=True)[0]["status"] == "use-placeholder"
        assert session.get(MediaFile, cover_id).kind == "retired_image"
        assert session.get(Item, "e1").primary_image_tag == ""
        assert client.get("/api/items/e1/image?w=480").status_code == 404


def test_repair_preserves_manual_covers(client):  # noqa: F811
    with Session(db.get_engine()) as session:
        seed_automatic_cover(session)
        session.add(
            MediaFile(
                id="manual",
                family_id="f1",
                item_id="e1",
                kind="image",
                storage="local",
                path="black.jpg",
            )
        )
        session.get(Item, "e1").primary_image_tag = "manual"
        session.commit()
        assert repair(session, apply=True) == []
        assert session.get(Item, "e1").primary_image_tag == "manual"


def test_repair_cli_backs_up_database_before_applying(client, monkeypatch, capsys):  # noqa: F811
    with Session(db.get_engine()) as session:
        cover_id = seed_automatic_cover(session)
    monkeypatch.setattr("mollytime_server.repair_covers.extract_cover", lambda *_: None)
    assert main(["--item-id", "e1"]) == 0
    assert "would-repair" in capsys.readouterr().out
    assert list(config.get_settings().data_dir.glob("covers-backup-*.sqlite")) == []
    assert main(["--apply", "--item-id", "e1"]) == 0
    backup = next(config.get_settings().data_dir.glob("covers-backup-*.sqlite"))
    with sqlite3.connect(backup) as original:
        assert original.execute(
            "SELECT kind FROM media_files WHERE id=?", (cover_id,)
        ).fetchone() == ("image",)
    with Session(db.get_engine()) as session:
        assert session.get(MediaFile, cover_id).kind == "retired_image"
