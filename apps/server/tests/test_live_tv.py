import datetime as dt
import io
import socket

import pytest
from sqlalchemy.orm import Session
from test_management import native_token, parent  # noqa: F401
from test_operations import operator  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.api import live_tv
from mollytime_server.auth import issue_access_token
from mollytime_server.live_tv import MAX_BYTES, download_playlist, parse_playlist
from mollytime_server.management_models import (
    Device,
    DeviceBootState,
    DeviceReminder,
    WatchInterval,
    WatchProgress,
    WatchSession,
)
from mollytime_server.models import User

PATH = "/api/manage/operations/live-tv"
PLAYLIST = """#EXTM3U
#EXTINF:-1 tvg-name="CCTV1" group-title="央视频道",央视一套
https://media.example.com/live.m3u8
#EXTINF:-1 group-title="地方台",地方频道
http://media.example.com/local.m3u8
"""


def test_parse_real_formats_and_deterministic_ids():
    values, skipped = parse_playlist(
        PLAYLIST
        + "#EXTINF:-1,重复\nhttps://media.example.com/live.m3u8\n#EXTINF:-1,无效\nfile:///etc/passwd",
        "platform",
    )
    assert skipped == 2
    assert [v["name"] for v in values] == ["央视一套", "地方频道"]
    assert values == parse_playlist("\ufeff" + PLAYLIST, "platform")[0]
    txt, _ = parse_playlist("央视,#genre#\n央视一套,https://example.com/a.m3u8", "platform")
    assert txt[0]["group"] == "央视"
    assert (
        txt[0]["id"] != parse_playlist("央视一套,https://example.com/a.m3u8", "other")[0][0]["id"]
    )
    comma, _ = parse_playlist(
        '#EXTM3U\n#EXTINF:-1 group-title="News, TV",News, live\nhttps://example.com/a', "platform"
    )
    assert comma[0]["name"] == "News, live"
    assert comma[0]["group"] == "News, TV"


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "http://127.0.0.1/tv",
        "http://169.254.169.254/",
        "http://[::1]/",
        "https://user:pass@example.com/a",
        "http://localhost/a",
        "https://example.com:bad/a",
    ],
)
def test_private_and_invalid_sources_rejected(url):
    with pytest.raises(ValueError):
        download_playlist(url)


def test_dns_private_address_rejected(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443))],
    )
    with pytest.raises(ValueError, match="公网"):
        download_playlist("https://example.com/tv")


def test_download_pins_public_ip_and_revalidates_redirect(monkeypatch):
    connections = []

    class Socket:
        def __init__(self, response):
            self.response = response
            self.sent = b""

        def sendall(self, data):
            self.sent += data

        def makefile(self, *args):
            return io.BytesIO(self.response)

        def close(self):
            pass

        def settimeout(self, timeout):
            pass

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))],
    )
    content = PLAYLIST.encode("utf-8-sig")
    response = (
        b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: "
        + str(len(content)).encode()
        + b"\r\n\r\n"
        + content
    )
    sock = Socket(response)

    def connect(address, **kwargs):
        connections.append(address)
        return sock

    monkeypatch.setattr(socket, "create_connection", connect)
    assert download_playlist("http://playlist.example.com/list.m3u") == PLAYLIST
    assert connections == [("93.184.216.34", 80)]
    assert b"Host: playlist.example.com" in sock.sent
    sock.response = b"HTTP/1.1 302 Found\r\nConnection: close\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n"
    with pytest.raises(ValueError, match="公网"):
        download_playlist("http://playlist.example.com/list.m3u")
    assert len(connections) == 2  # Redirect target never receives a connection.


def test_import_is_operator_only(parent):  # noqa: F811
    for method, suffix, body in [
        ("get", "", None),
        ("post", "/import", {"content": PLAYLIST}),
        ("put", "", {"enabled": True}),
    ]:
        response = getattr(parent, method)(PATH + suffix, **({"json": body} if body else {}))
        assert response.status_code == 403
    # Native device / access tokens cannot operate, including a superadmin token.
    with Session(db.get_engine()) as s:
        s.get(User, "u1").role = "superadmin"
        s.commit()
    parent.cookies.clear()
    assert (
        parent.post(
            PATH + "/import", headers=native_token(), json={"content": PLAYLIST}
        ).status_code
        == 401
    )


def test_import_refresh_toggle_and_failed_import_preserves_list(operator, monkeypatch):  # noqa: F811
    assert operator.get("/api/live-tv", headers=native_token()).json()["enabled"] is False
    initial = operator.post(PATH + "/import", json={"content": PLAYLIST})
    assert initial.status_code == 200
    assert len(initial.json()["channels"]) == 2
    assert "url" not in initial.json()["channels"][0]
    assert operator.post(PATH + "/import", json={"content": "garbage"}).status_code == 422
    assert operator.get(PATH).json()["channels"] == initial.json()["channels"]
    assert (
        operator.post(
            PATH + "/import", json={"content": PLAYLIST, "sourceUrl": "https://example.com"}
        ).status_code
        == 422
    )
    monkeypatch.setattr(live_tv, "download_playlist", lambda url: PLAYLIST)
    assert (
        operator.post(PATH + "/import", json={"sourceUrl": "https://example.com/tv.m3u"}).json()[
            "sourceUrl"
        ]
        == "https://example.com/tv.m3u"
    )
    operator.put(PATH, json={"enabled": False})
    assert operator.get("/api/live-tv", headers=native_token()).json()["channels"] == []
    channel = initial.json()["channels"][0]["id"]
    assert (
        operator.post(
            f"/api/live-tv/channels/{channel}/sessions", headers=native_token()
        ).status_code
        == 403
    )


def test_sessions_metering_no_episode_progress_and_expiry(operator):  # noqa: F811
    data = operator.post(PATH + "/import", json={"content": PLAYLIST}).json()
    channel = data["channels"][0]["id"]
    route = f"/api/live-tv/channels/{channel}/sessions"
    assert operator.post(route).status_code == 403  # Parent preview cannot create viewing history.
    source = operator.post(route, headers=native_token()).json()
    key = source["sessionId"]
    assert source["url"] == "https://media.example.com/live.m3u8"
    assert operator.get(f"/api/live-tv/sessions/{key}", headers=native_token()).status_code == 200
    assert (
        operator.post("/api/live-tv/channels/unknown/sessions", headers=native_token()).status_code
        == 404
    )
    with Session(db.get_engine()) as s:
        s.get(WatchSession, key).started_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=10)
        s.add(User(id="u2", family_id="f2", name="other", password_hash="test"))
        s.commit()
    token, _ = issue_access_token(user_id="u2", family_id="f2", role="admin")
    assert (
        operator.get(
            f"/api/live-tv/sessions/{key}", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 404
    )
    body = {"seq": 0, "startMs": 0, "endMs": 1000, "playedMs": 1000, "positionMs": 0}
    events = f"/api/playback/sessions/{key}/events"
    assert operator.post(events, headers=native_token(), json=body).status_code == 200
    assert operator.post(events, headers=native_token(), json=body).json()["duplicate"] is True
    with Session(db.get_engine()) as s:
        assert s.query(WatchProgress).count() == 0
        assert s.get(WatchSession, key).purpose == "live_tv"
        s.get(WatchSession, key).started_at = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=31)
        s.commit()
    assert operator.get(f"/api/live-tv/sessions/{key}", headers=native_token()).status_code == 403


def test_live_time_excluded_from_reports_overview_and_boot_totals(operator):  # noqa: F811
    data = operator.post(PATH + "/import", json={"content": PLAYLIST}).json()
    channel = data["channels"][0]["id"]
    key = operator.post(f"/api/live-tv/channels/{channel}/sessions", headers=native_token()).json()[
        "sessionId"
    ]
    at = dt.datetime.now(dt.UTC)
    with Session(db.get_engine()) as s:
        s.add(Device(id="tv-live", family_id="f1", user_id="u1", name="TV", last_seen=at))
        s.flush()
        s.add(
            DeviceBootState(
                device_id="tv-live", boot_id="test-boot", started_at=at - dt.timedelta(minutes=5)
            )
        )
        live = s.get(WatchSession, key)
        live.device_id = "tv-live"
        live.started_at = at - dt.timedelta(seconds=10)
        live.last_reported_at = at
        s.add(
            WatchInterval(
                session_id=key, seq=0, start_ms=0, end_ms=2000, played_ms=2000, position_ms=0
            )
        )
        s.add(
            WatchSession(
                id="normal-watch",
                family_id="f1",
                user_id="u1",
                device_id="tv-live",
                item_id="e1",
                item_name="One",
                purpose="family_watch",
                started_at=at - dt.timedelta(seconds=20),
                last_reported_at=at,
            )
        )
        s.flush()
        s.add(
            WatchInterval(
                session_id="normal-watch",
                seq=0,
                start_ms=0,
                end_ms=1000,
                played_ms=1000,
                position_ms=1000,
            )
        )
        s.commit()
    day = at.astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
    for purpose in ("live_tv", "family_watch", "parent_preview"):
        with Session(db.get_engine()) as s:
            s.get(WatchSession, key).purpose = purpose
            s.commit()
        for suffix in ("", "&deviceId=tv-live"):
            response = operator.get(f"/api/manage/reports/watch-time?start={day}&end={day}{suffix}")
            assert response.status_code == 200, response.text
            report = response.json()
            assert report["totalPlayedMs"] == 1000
            assert [row["id"] for row in report["sessions"]] == ["normal-watch"]
        overview = operator.get("/api/manage/overview").json()["watch"]
        assert overview["todayPlayedMs"] == 1000
        assert overview["weekPlayedMs"] == 1000
        assert overview["last7DaysSessions"] == 1
        devices = operator.get("/api/manage/reminders/devices").json()
        assert (
            next(device for device in devices if device["id"] == "tv-live")["bootPlayedMs"] == 1000
        )


def test_old_episode_reminder_does_not_block_a_new_live_session(operator):  # noqa: F811
    data = operator.post(PATH + "/import", json={"content": PLAYLIST}).json()
    channel = data["channels"][0]["id"]
    with Session(db.get_engine()) as s:
        s.add(Device(id="d1", family_id="f1", user_id="u1", name="TV"))
        s.commit()
    token, _ = issue_access_token(user_id="u1", family_id="f1", role="admin", device_id="d1")
    headers = {"Authorization": f"Bearer {token}"}
    route = f"/api/live-tv/channels/{channel}/sessions"
    response = operator.post(route, headers=headers)
    assert response.status_code == 200, response.text
    with Session(db.get_engine()) as s:
        s.add(DeviceReminder(device_id="d1", family_id="f1", phase="pending"))
        s.commit()
    assert operator.post(route, headers=headers).status_code == 200
    assert (
        operator.get(
            "/api/live-tv/sessions/" + response.json()["sessionId"], headers=headers
        ).status_code
        == 200
    )


def test_import_size_limit():
    with pytest.raises(ValueError, match="2 MB"):
        parse_playlist("x" * (MAX_BYTES + 1), "platform")
