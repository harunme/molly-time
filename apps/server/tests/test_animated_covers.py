import hashlib
import io

import pytest
from PIL import Image
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
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


def test_poster_is_first_frame_and_preview_loops_all_frames(tmp_path):
    poster, preview = tmp_path / "poster.jpg", tmp_path / "preview.webp"
    resize_to_file(animation(), poster, 32)
    preview_to_file(animation(), preview, 32)
    with Image.open(poster) as image:
        assert image.size == (32, 18)
        assert image.getpixel((0, 0))[0] > 240
    with Image.open(preview) as image:
        assert image.n_frames == 3
        assert image.info["loop"] == 0
        for index, (channel, duration) in enumerate([(0, 200), (1, 300), (2, 400)]):
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
        assert image.n_frames == 3 and image.info["loop"] == 0
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


def upload_artwork(web, kind, data, filename):
    result = web.post("/api/manage/uploads", json={
        "itemId": "series", "filename": filename, "kind": kind,
        "size": len(data), "fingerprint": hashlib.sha256(data).hexdigest(),
    })
    assert result.status_code == 200, result.text
    row = result.json()
    url = f"/api/manage/uploads/{row['id']}"
    assert web.put(url + "/chunks?offset=0", content=data,
                      headers={"X-Chunk-SHA256": hashlib.sha256(data).hexdigest()}).status_code == 200
    return row["id"], web.post(url + "/complete")


def still(color="blue"):
    output = io.BytesIO()
    Image.new("RGB", (64, 36), color).save(output, "PNG")
    return output.getvalue()


def test_static_cover_and_preview_replace_independently_and_inherit(parent):  # noqa: F811
    preview_id, uploaded = upload_artwork(parent, "preview", animation(), "motion.webp")
    assert uploaded.status_code == 200
    # A preview alone still supplies its first frame as a fallback poster.
    with Image.open(io.BytesIO(parent.get("/api/items/series/image").content)) as poster:
        assert poster.getpixel((0, 0))[0] > 240
    image_id, uploaded = upload_artwork(parent, "image", still(), "poster.png")
    assert uploaded.status_code == 200
    resource = parent.get("/api/manage/resources/series").json()
    assert resource["hasOwnPreview"]
    assert f"v={preview_id}" in resource["imagePreviewUrl"]
    with Image.open(io.BytesIO(parent.get(resource["imageUrl"]).content)) as poster:
        assert poster.getpixel((0, 0))[2] > 240
    # Episodes inherit both roles from the same ancestor.
    with Session(db.get_engine()) as session:
        inherited = image_ref(session, session.get(Item, "e1"))
        assert f"v={preview_id}" in inherited["previewUrl"]
    replacement, result = upload_artwork(parent, "preview", animation(), "updated.webp")
    assert result.status_code == 200
    updated = parent.get("/api/manage/resources/series").json()
    assert f"v={replacement}" in updated["imagePreviewUrl"]
    with Session(db.get_engine()) as session:
        assert session.get(MediaFile, image_id).kind == "image"
        assert session.get(MediaFile, preview_id).kind == "retired_preview"
    assert parent.delete("/api/manage/resources/series/preview").status_code == 200
    assert not parent.get("/api/manage/resources/series").json()["hasOwnPreview"]
    with Session(db.get_engine()) as session:
        assert session.get(MediaFile, image_id).kind == "image"
        assert session.get(MediaFile, replacement).kind == "retired_preview"
    with Image.open(io.BytesIO(parent.get("/api/items/series/image").content)) as poster:
        assert poster.getpixel((0, 0))[2] > 240


@pytest.mark.parametrize("data,filename", [(b"not-an-image", "bad.webp"), (still(), "still.png")])
def test_invalid_preview_cannot_replace_a_valid_one(parent, data, filename):  # noqa: F811
    preview_id, result = upload_artwork(parent, "preview", animation(), "motion.webp")
    assert result.status_code == 200
    bad_id, result = upload_artwork(parent, "preview", data, filename)
    assert result.status_code == 422
    with Session(db.get_engine()) as session:
        assert session.get(MediaFile, preview_id).kind == "preview"
        assert session.get(MediaFile, bad_id) is None


@pytest.mark.parametrize("format,extension", [("WEBP", "webp"), ("GIF", "gif"), ("PNG", "png")])
def test_preview_accepts_supported_animation_formats(parent, format, extension):  # noqa: F811
    output = io.BytesIO()
    Image.new("RGB", (64, 36), "red").save(output, format, save_all=True,
        append_images=[Image.new("RGB", (64, 36), "blue")], duration=[200, 300], loop=0)
    _, result = upload_artwork(parent, "preview", output.getvalue(), "motion." + extension)
    assert result.status_code == 200, result.text
    response = parent.get("/api/items/series/image?preview=1")
    assert response.status_code == 200
    with Image.open(io.BytesIO(response.content)) as motion:
        assert motion.n_frames == 2 and motion.info["loop"] == 0
