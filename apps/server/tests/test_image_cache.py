import io

from PIL import Image
from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.images import image_url
from mollytime_server.models import Item, MediaFile


def seed_cover(version="cover", color="blue"):
    output = io.BytesIO()
    Image.new("RGB", (64, 36), color).save(output, "JPEG")
    (config.get_settings().resolved_media_dir() / f"{version}.jpg").write_bytes(output.getvalue())
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id=version, family_id="f1", item_id="e1", kind="image",
                              storage="local", path=f"{version}.jpg", mime="image/jpeg"))
        session.commit()
        # Older and inherited artwork must be versioned even without an item tag.
        return image_url(session, session.get(Item, "e1"))


def test_versioned_cover_is_privately_cached_and_head_matches(client):
    url = seed_cover()
    assert url == "/api/items/e1/image?v=cover"
    response = client.get(url)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, max-age=86400"
    assert {"authorization", "cookie"} <= {value.strip().lower() for value in response.headers["vary"].split(",")}
    head = client.head(url)
    assert head.status_code == 200 and head.content == b""
    assert head.headers["etag"] == response.headers["etag"]
    assert head.headers["content-length"] == response.headers["content-length"]
    assert client.get("/api/episodes/e1/progress").headers["cache-control"] == "no-store"


def test_unchanged_cover_returns_304_without_reading_storage(client, monkeypatch):
    url = seed_cover()
    response = client.get(url)

    def unexpected_storage(*args):
        raise AssertionError("A matching validator must not read or resize the image")

    monkeypatch.setattr("mollytime_server.api.playback.build_storage", unexpected_storage)
    for validator in [response.headers["etag"], "W/" + response.headers["etag"],
                      '"other", ' + response.headers["etag"], "*"]:
        cached = client.get(url, headers={"If-None-Match": validator})
        assert cached.status_code == 304 and cached.content == b""
        assert cached.headers["etag"] == response.headers["etag"]
        assert cached.headers["cache-control"] == "private, max-age=86400"


def test_legacy_and_stale_version_urls_revalidate(client):
    seed_cover()
    for url in ["/api/items/e1/image", "/api/items/e1/image?v=old"]:
        response = client.get(url)
        assert response.headers["cache-control"] == "private, no-cache"
        assert client.get(url, headers={"If-None-Match": response.headers["etag"]}).status_code == 304


def test_replacing_cover_changes_url_and_validator(client):
    url = seed_cover()
    old = client.get(url)
    with Session(db.get_engine()) as session:
        session.get(MediaFile, "cover").kind = "retired_image"
        session.commit()
    new_url = seed_cover("replacement", "red")
    assert new_url != url
    response = client.get(new_url, headers={"If-None-Match": old.headers["etag"]})
    assert response.status_code == 200 and response.content != old.content
    assert response.headers["etag"] != old.headers["etag"]
    assert client.get(url).headers["cache-control"] == "private, no-cache"


def test_validator_is_specific_to_size_and_preview(client):
    url = seed_cover()
    small = client.get(url + "&w=320")
    large = client.get(url + "&w=960", headers={"If-None-Match": small.headers["etag"]})
    assert large.status_code == 200 and large.headers["etag"] != small.headers["etag"]
    preview = client.get(url + "&preview=1", headers={"If-None-Match": small.headers["etag"]})
    assert preview.status_code == 204


def test_cached_validator_does_not_bypass_auth_or_family_checks(client):
    url = seed_cover()
    etag = client.get(url).headers["etag"]
    forbidden = client.get("/api/items/e2/image?v=cover", headers={"If-None-Match": etag})
    assert forbidden.status_code == 404 and forbidden.headers["cache-control"] == "no-store"
    client.headers.pop("Authorization")
    anonymous = client.get(url, headers={"If-None-Match": etag})
    assert anonymous.status_code == 401 and anonymous.headers["cache-control"] == "no-store"
