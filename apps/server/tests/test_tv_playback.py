import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from mollytime_server import config, db
from mollytime_server.auth import issue_access_token
from mollytime_server.main import create_app
from mollytime_server.models import ChildProfile, Family, Item, MediaFile, User
from mollytime_server.storage.factory import build_storage
from mollytime_server.storage.local import LocalStorage


@pytest.fixture
def client(tmp_path, monkeypatch):
    settings = config.Settings(data_dir=tmp_path, media_dir=tmp_path, tv_web_dir=tmp_path / "web", media_worker_enabled=False)
    settings.tv_web_dir.mkdir()
    (settings.tv_web_dir / "index.html").write_text("<html>TV</html>")
    (settings.tv_web_dir / "assets").mkdir()
    (settings.tv_web_dir / "assets/app-hash.js").write_text("window.tv=true")
    (settings.tv_web_dir / "web-release.json").write_text('{"webVersion":"abc123","minBridgeVersion":1,"maxBridgeVersion":1,"size":8,"sha256":"' + "a" * 64 + '"}')
    (settings.tv_web_dir / "web-bundle.zip").write_bytes(b"web-bundle")
    monkeypatch.setattr(config, "_settings", settings)
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_SessionLocal", None)
    engine = db.get_engine()
    db.init_db()
    with Session(engine) as session:
        session.add_all([Family(id="f1", name="One"), Family(id="f2", name="Two")])
        session.add_all([User(id="u1", family_id="f1", name="parent", password_hash="test"),
                         ChildProfile(id="c1", family_id="f1", name="Child"),
                         ChildProfile(id="c2", family_id="f2", name="Other")])
        session.add_all([Item(id="e1", family_id="f1", type="Episode", name="One"),
                         Item(id="e2", family_id="f2", type="Episode", name="Two")])
        (tmp_path / "video.mp4").write_bytes(b"0123456789")
        (tmp_path / "subtitle.srt").write_text("subtitle")
        session.add_all([MediaFile(id="v1", family_id="f1", item_id="e1", kind="video", storage="local", path="video.mp4"),
                         MediaFile(id="s1", family_id="f1", item_id="e1", kind="subtitle", storage="local", path="subtitle.srt"),
                         MediaFile(id="s2", family_id="f2", item_id="e2", kind="subtitle", storage="local", path="subtitle.srt")])
        session.commit()
    build_storage.cache_clear()
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="admin")
    with TestClient(create_app()) as test_client:
        test_client.headers["Authorization"] = f"Bearer {token}"
        yield test_client
    build_storage.cache_clear()
    engine.dispose()


@pytest.mark.parametrize("header, expected", [
    ("bytes=2-5", b"2345"), ("bytes=7-", b"789"), ("bytes=-3", b"789"),
    ("bytes=8-999", b"89"), ("bytes=-999", b"0123456789"),
])
def test_range(client, header, expected):
    res = client.get("/api/episodes/e1/play", headers={"Range": header})
    assert res.status_code == 206
    assert res.content == expected
    assert int(res.headers["content-length"]) == len(expected)


@pytest.mark.parametrize("header", ["bytes=10-", "bytes=-0", "bytes=8-2", "bytes=0-1,3-4", "bytes=-", "items=0-2"])
def test_invalid_range(client, header):
    res = client.get("/api/episodes/e1/play", headers={"Range": header})
    assert res.status_code == 416
    assert res.headers["content-range"] == "bytes */10"


def test_head_and_full(client):
    res = client.head("/api/episodes/e1/play", headers={"Range": "bytes=3-5"})
    assert res.status_code == 200 and res.content == b""
    assert res.headers["content-length"] == "10"
    assert client.get("/api/episodes/e1/play").content == b"0123456789"


def test_subtitle_and_child_isolation(client):
    assert client.get("/api/episodes/e1/subtitles/0").status_code == 200
    assert client.get("/api/episodes/e2/subtitles/0").status_code == 404
    assert client.get("/api/episodes/e2/progress").status_code == 404
    assert client.get("/api/episodes/e1/progress?childId=c2").status_code == 404
    assert client.post("/api/episodes/e1/progress", json={"positionMs": 10, "childId": "c2"}).status_code == 404


def test_resume_and_validation(client):
    path = "/api/episodes/e1/progress"
    assert client.get(path).json()["positionMs"] == 0
    assert client.post(path, json={"positionMs": 12, "childId": "c1"}).status_code == 200
    assert client.get(path + "?childId=c1").json() == {"positionMs": 12, "completed": False}
    assert client.get(path).json()["positionMs"] == 0
    assert client.post(path, json={"positionMs": -1}).status_code == 422
    assert client.post(path, json={"positionMs": 1, "event": "unknown"}).status_code == 422


def test_chunks_and_root_boundary(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    (root / "video.mp4").write_bytes(b"x" * 900000)
    storage = LocalStorage(root)
    chunks = list(storage.iter_range("video.mp4", 0, 899999))
    assert len(chunks) > 1 and max(map(len, chunks)) <= 256 * 1024
    assert sum(map(len, chunks)) == 900000
    assert storage.resolve(str(root / "video.mp4")).size_bytes == 900000
    with pytest.raises(ValueError):
        storage.resolve("../media-other/video.mp4")
    with pytest.raises(ValueError):
        storage.resolve(str(tmp_path / "outside.mp4"))


def test_tv_cache_and_origin_policy(client):
    html = client.get("/tv/")
    assert html.status_code == 200 and html.headers["cache-control"] == "no-store"
    assert "frame-src 'none'" in html.headers["content-security-policy"]
    assert "immutable" in client.get("/tv/assets/app-hash.js").headers["cache-control"]
    assert client.get("/tv/web-release.json").headers["cache-control"] == "no-store"
    assert client.get("/tv/web-bundle.zip").content == b"web-bundle"
    assert client.get("/tv/web-bundle.zip").headers["cache-control"] == "no-store"
    assert client.get("/tv/missing.js").status_code == 404
    assert "access-control-allow-origin" not in client.get("/healthz", headers={"Origin": "https://untrusted.test"}).headers
