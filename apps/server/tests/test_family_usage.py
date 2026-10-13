# ruff: noqa: F811 -- shared isolated fixtures
import csv
import datetime as dt
import io

import pytest
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_operations import operator  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.accounts import ensure_identity
from mollytime_server.auth import hash_password
from mollytime_server.management_models import UploadSession, UploadTarget
from mollytime_server.models import Family, MediaFile, User
from mollytime_server.usage import family_usage
from mollytime_server.usage_meter import UsageMeter
from mollytime_server.usage_models import TrafficEvent


def test_storage_dedup_retained_versions_pending_and_account_family(parent):
    with Session(db.get_engine()) as session:
        session.add(User(id="another-parent", family_id="f1", name="another",
                         password_hash=hash_password("another-password")))
        session.add_all([
            MediaFile(id="duplicate", family_id="f1", item_id="e1", kind="retired_video",
                      storage="local", path="video.mp4", size_bytes=10),
            MediaFile(id="old-oss", family_id="f1", item_id="e1", kind="retired_video",
                      storage="oss", path="families/f1/old.mp4", size_bytes=2048),
            MediaFile(id="unknown", family_id="f1", item_id="e1", kind="image",
                      storage="oss", path="families/f1/unknown.jpg", size_bytes=0),
        ])
        session.add(UploadSession(id="pending", family_id="f1", item_id="e1", filename="bad.mp4",
                                  size=30, fingerprint="x", kind="video", status="failed", offset=30))
        session.flush()
        session.add(UploadTarget(upload_id="pending", backend="oss", object_key="families/f1/pending",
                                 expires_at=dt.datetime.now(dt.UTC)))
        session.commit()
    result = parent.get("/api/manage/usage?month=2026-10").json()
    assert result["id"] == "f1" and result["accountCount"] == 2
    assert result["storage"] == {"usedBytes": 2066, "localBytes": 18, "ossBytes": 2048,
                                 "objectCount": 4, "unknownSizeCount": 1,
                                 "pendingBytes": 30, "reservedBytes": 30}
    # A second account gets the same family's combined usage, never an account subtotal.
    login = parent.post("/api/manage/auth/login",
                        json={"username": "another", "password": "another-password"})
    assert login.status_code == 200
    assert parent.get("/api/manage/usage?month=2026-10").json()["storage"] == result["storage"]


def test_local_range_head_errors_subtitles_and_url_resolution(parent):
    assert parent.get("/api/episodes/e1/playback").status_code == 200
    assert parent.head("/api/episodes/e1/play").status_code == 200
    assert parent.get("/api/episodes/e1/play", headers={"Range": "bytes=99-"}).status_code == 416
    assert parent.get("/api/episodes/e2/play").status_code == 404
    assert parent.get("/api/episodes/e1/play", headers={"Range": "bytes=2-5"}).content == b"2345"
    assert parent.get("/api/episodes/e1/play").content == b"0123456789"
    assert parent.get("/api/episodes/e1/subtitles/0").content == b"subtitle"
    traffic = parent.get("/api/manage/usage").json()["traffic"]
    assert traffic["totalBytes"] == traffic["localBytes"] == 22
    assert traffic["ossBytes"] == 0 and traffic["requestCount"] == 3


def test_private_image_meter(parent):
    from PIL import Image
    path = config.get_settings().resolved_media_dir() / "cover.jpg"
    Image.new("RGB", (5, 5)).save(path)
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="cover", family_id="f1", item_id="e1", kind="image",
                              storage="local", path="cover.jpg"))
        session.commit()
    assert parent.head("/api/items/e1/image").status_code == 200
    response = parent.get("/api/items/e1/image")
    assert response.status_code == 200
    assert parent.get("/api/manage/usage").json()["traffic"]["localBytes"] == len(response.content)


@pytest.mark.asyncio
async def test_meter_counts_only_successfully_sent_partial_body(client):
    async def app(scope, receive, send):
        scope.setdefault("state", {})["usage_family_id"] = "f1"
        await send({"type": "http.response.start", "status": 206, "headers": []})
        await send({"type": "http.response.body", "body": b"abc", "more_body": True})
        await send({"type": "http.response.body", "body": b"lost", "more_body": True})

    async def send(message):
        if message.get("body") == b"lost":
            raise OSError("disconnected")

    with pytest.raises(OSError):
        await UsageMeter(app)({"type": "http", "method": "GET"}, None, send)
    with Session(db.get_engine()) as session:
        assert session.query(TrafficEvent.bytes_sent).scalar() == 3


def test_existing_oss_traffic_remains_visible_in_usage_reports(operator):
    with Session(db.get_engine()) as session:
        session.add(TrafficEvent(id="existing-oss", family_id="f1", source="oss",
                                 occurred_at=dt.datetime(2026, 10, 13, tzinfo=dt.UTC),
                                 bytes_sent=108))
        session.commit()
    own = operator.get("/api/manage/usage?month=2026-10").json()
    assert own["traffic"]["ossBytes"] == own["traffic"]["totalBytes"] == 108
    rows = operator.get("/api/manage/operations/usage?month=2026-10").json()["items"]
    assert {row["id"]: row["traffic"]["ossBytes"] for row in rows} == {"f1": 108, "f2": 0}
    assert operator.post("/api/manage/operations/usage/oss-logs", content=b"log").status_code == 404


@pytest.mark.parametrize("month", ["2026-00", "2026-13", "26-01", "0000-01", "9999-12", "2026-1"])
def test_invalid_month(parent, month):
    assert parent.get(f"/api/manage/usage?month={month}").status_code == 422


def test_permissions_csrf_pagination_search_and_export(parent):
    assert parent.get("/api/manage/operations/usage").status_code == 403
    assert parent.get("/api/manage/operations/usage/export").status_code == 403
    # Adding a familyId query cannot change the own-family report.
    assert parent.get("/api/manage/usage?familyId=f2").json()["id"] == "f1"
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "superadmin"
        session.get(Family, "f2").name = "=SUM(1,2)"
        identity = ensure_identity(session, session.get(User, "u1"))
        identity.email = "owner@example.test"
        session.commit()
    rows = parent.get("/api/manage/operations/usage?pageSize=1&page=2").json()
    assert rows["total"] == 2 and rows["items"][0]["id"] == "f2"
    rows = parent.get("/api/manage/operations/usage?q=owner@example.test").json()
    assert rows["total"] == 1 and rows["items"][0]["id"] == "f1"
    response = parent.get("/api/manage/operations/usage/export?month=2026-10")
    exported = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert len(exported) == 2
    assert exported[1]["family_name"] == "'=SUM(1,2)"
    assert exported[0]["storage_bytes_current"] == "18"
    assert "family-usage-2026-10.csv" in response.headers["content-disposition"]


def test_restart_keeps_ledger_and_schema_is_additive(operator):
    with Session(db.get_engine()) as session:
        session.add(TrafficEvent(id="existing-oss", family_id="f1", source="oss",
                                 occurred_at=dt.datetime(2026, 10, 13, tzinfo=dt.UTC),
                                 bytes_sent=100))
        session.commit()
    db.init_db()
    db.init_db()
    assert operator.get("/api/manage/usage?month=2026-10").json()["traffic"]["totalBytes"] == 100
    with Session(db.get_engine()) as session:
        assert len(family_usage(session, [], "2026-10")) == 0
