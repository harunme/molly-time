import io

from PIL import Image
from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.images import image_ref
from mollytime_server.models import Item, MediaFile
from mollytime_server.utils.image import preview_to_file, resize_to_file


def animation():
    output = io.BytesIO()
    frames = [Image.new("RGB", (64, 36), color) for color in ["red", "lime", "blue"]]
    frames[0].save(output, format="WEBP", save_all=True, append_images=frames[1:],
                   duration=[200, 300, 400], loop=0, lossless=True)
    return output.getvalue()


def test_poster_is_first_frame_and_preview_loops_only_motion_frames(tmp_path):
    poster, preview = tmp_path / "poster.jpg", tmp_path / "preview.webp"
    resize_to_file(animation(), poster, 32)
    preview_to_file(animation(), preview, 32)
    with Image.open(poster) as image:
        assert image.size == (32, 18)
        assert image.getpixel((0, 0))[0] > 240
    with Image.open(preview) as image:
        assert image.n_frames == 2
        assert image.info["loop"] == 0
        for index, (channel, duration) in enumerate([(1, 300), (2, 400)]):
            image.seek(index)
            frame = image.convert("RGB")
            assert frame.getpixel((0, 0))[channel] > 240
            assert image.info["duration"] == duration


def test_animated_cover_endpoints_and_references(client):  # noqa: F811
    root = config.get_settings().resolved_media_dir()
    (root / "cover.webp").write_bytes(animation())
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="animated", family_id="f1", item_id="e1", kind="image",
                              storage="local", path="cover.webp", mime="image/webp"))
        session.get(Item, "e1").primary_image_tag = "animated"
        session.commit()
        ref = image_ref(session, session.get(Item, "e1"))
        assert ref["previewUrl"] == ref["url"] + "&preview=1"
        # OSS originals must not auto-animate before hover; static catalogs must
        # still expose the optional online preview without signing any URLs.
        session.get(MediaFile, "animated").storage = "oss"
        assert "directUrl" not in image_ref(session, session.get(Item, "e1"))
        session.info["static_catalog"] = True
        assert image_ref(session, session.get(Item, "e1")) == ref
    poster = client.get(ref["url"] + "&w=320")
    preview = client.get(ref["previewUrl"] + "&w=320")
    assert poster.status_code == preview.status_code == 200
    assert poster.headers["content-type"] == "image/jpeg"
    assert preview.headers["content-type"] == "image/webp"
    with Image.open(io.BytesIO(poster.content)) as image:
        assert image.getpixel((0, 0))[0] > 240
    with Image.open(io.BytesIO(preview.content)) as image:
        assert image.n_frames == 2 and image.info["loop"] == 0
    assert client.get(ref["previewUrl"] + "&w=320").content == preview.content
    assert client.get("/api/items/e2/image?preview=1").status_code == 404


def test_still_cover_preview_keeps_the_static_poster(client):  # noqa: F811
    root = config.get_settings().resolved_media_dir()
    Image.new("RGB", (32, 18), "red").save(root / "still.png")
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="still", family_id="f1", item_id="e1", kind="image",
                              storage="local", path="still.png", mime="image/png"))
        session.commit()
    assert client.get("/api/items/e1/image?preview=1").status_code == 204
    assert client.get("/api/items/e1/image").headers["content-type"] == "image/jpeg"
