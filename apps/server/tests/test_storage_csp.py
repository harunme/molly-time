import pytest
from test_tv_playback import client  # noqa: F401

from mollytime_server import config


def test_html_allows_only_configured_oss_destination(client, monkeypatch):  # noqa: F811
    settings = config.get_settings()
    monkeypatch.setattr(settings, "oss_endpoint", "https://oss-cn-beijing.aliyuncs.com")
    monkeypatch.setattr(settings, "oss_bucket", "molly-time")
    response = client.get("/tv/")
    assert response.status_code == 200
    assert (
        "connect-src 'self' https://molly-time.oss-cn-beijing.aliyuncs.com;"
        in response.headers["Content-Security-Policy"]
    )
    assert "connect-src 'self' https:;" not in response.headers["Content-Security-Policy"]
    monkeypatch.setattr(settings, "oss_bucket", "another-bucket")
    assert (
        "https://another-bucket.oss-cn-beijing.aliyuncs.com"
        in client.get("/tv/").headers["Content-Security-Policy"]
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
def test_csp_rejects_invalid_configuration(client, monkeypatch, endpoint, bucket):  # noqa: F811
    monkeypatch.setattr(config.get_settings(), "oss_endpoint", endpoint)
    monkeypatch.setattr(config.get_settings(), "oss_bucket", bucket)
    assert "connect-src 'self';" in client.get("/tv/").headers["Content-Security-Policy"]
