import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_tv_playback import client as database_client  # noqa: F401

from mollytime_server import config
from mollytime_server.tv_web import TvWebFiles


@pytest.fixture
def client(tmp_path, database_client):
    (tmp_path / "index.html").write_text("<html>Share</html>")
    app = FastAPI()
    for path in ("/tv", "/manage"):
        app.mount(path, TvWebFiles(directory=tmp_path, html=True))
    with TestClient(app) as test_client:
        yield test_client


@pytest.mark.parametrize("path", ["/tv/", "/manage/"])
def test_html_allows_only_configured_oss_destination(client, monkeypatch, path):
    settings = config.get_settings()
    monkeypatch.setattr(settings, "oss_endpoint", "https://oss-cn-beijing.aliyuncs.com")
    monkeypatch.setattr(settings, "oss_bucket", "molly-time")
    response = client.get(path)
    assert response.status_code == 200
    assert (
        "img-src 'self' blob: https://molly-time.oss-cn-beijing.aliyuncs.com;"
        in response.headers["Content-Security-Policy"]
    )
    monkeypatch.setattr(settings, "oss_bucket", "another-bucket")
    assert (
        "img-src 'self' blob: https://another-bucket.oss-cn-beijing.aliyuncs.com;"
        in client.get(path).headers["Content-Security-Policy"]
    )


@pytest.mark.parametrize(
    "endpoint,bucket",
    [
        (None, None),
        ("http://oss-cn-beijing.aliyuncs.com", "molly-time"),
        ("https://evil.example", "molly-time"),
        ("https://oss-cn-beijing.aliyuncs.com", "bad'; connect-src *"),
    ],
)
@pytest.mark.parametrize("path", ["/tv/", "/manage/"])
def test_csp_rejects_invalid_configuration(client, monkeypatch, endpoint, bucket, path):
    monkeypatch.setattr(config.get_settings(), "oss_endpoint", endpoint)
    monkeypatch.setattr(config.get_settings(), "oss_bucket", bucket)
    assert "img-src 'self' blob:;" in client.get(path).headers["Content-Security-Policy"]
