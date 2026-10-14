"""The marketing site must not shadow the existing service and app routes."""

from fastapi.testclient import TestClient

from mollytime_server import config, db
from mollytime_server.main import create_app


def settings_for(tmp_path, monkeypatch, *, site=True, explicit=False):
    parent = tmp_path / "manage"
    tv = tmp_path / "tv"
    public = tmp_path / "public" if explicit else parent / "site"
    for directory, content in ((parent, "parent app"), (tv, "TV app")):
        directory.mkdir()
        (directory / "index.html").write_text(content)
    if site:
        public.mkdir(parents=True)
        (public / "index.html").write_text("<!doctype html><h1>MollyTime</h1>")
        (public / "_astro").mkdir()
        (public / "_astro/app.js").write_text("console.log('site')")
        (public / "robots.txt").write_text("User-agent: *")
    settings = config.Settings(
        _env_file=None, data_dir=tmp_path, parent_web_dir=parent, tv_web_dir=tv,
        site_web_dir=public if explicit else None, media_worker_enabled=False,
    )
    monkeypatch.setattr(config, "_settings", settings)
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_SessionLocal", None)
    db.init_db()
    return settings


def test_homepage_and_assets_preserve_apps_and_api(tmp_path, monkeypatch):
    settings_for(tmp_path, monkeypatch)
    client = TestClient(create_app())
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "MollyTime" in response.text
    assert client.get("/_astro/app.js").status_code == 200
    assert client.get("/robots.txt").status_code == 200
    assert client.get("/manage/").text == "parent app"
    assert client.get("/tv/").text == "TV app"
    assert client.get("/healthz").json()["ok"] is True
    assert client.get("/api/me").status_code == 401
    assert client.get("/missing-page").status_code == 404
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/../config.py").status_code == 404


def test_missing_site_keeps_service_root(tmp_path, monkeypatch):
    settings_for(tmp_path, monkeypatch, site=False)
    response = TestClient(create_app()).get("/")
    assert response.status_code == 200
    assert response.json()["apiBase"] == "/api"


def test_explicit_site_directory(tmp_path, monkeypatch):
    settings_for(tmp_path, monkeypatch, explicit=True)
    assert "MollyTime" in TestClient(create_app()).get("/").text
