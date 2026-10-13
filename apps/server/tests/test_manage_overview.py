# Imported pytest fixtures are intentionally reused as test arguments.
# ruff: noqa: F811
import datetime as dt
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from sqlalchemy import event
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.api import manage_overview
from mollytime_server.management_models import (
    Device,
    FamilySettings,
    ResourceState,
    UploadSession,
    WatchInterval,
    WatchSession,
)
from mollytime_server.models import Item, MediaFile, User


def test_overview_aggregates_only_the_current_family_and_real_watch_sessions(parent, monkeypatch):
    fixed = dt.datetime(2026, 10, 13, 0, 0, tzinfo=dt.UTC)
    zone = ZoneInfo("Pacific/Kiritimati")
    today = fixed.astimezone(zone).date()
    lower = dt.datetime.combine(today - dt.timedelta(days=6), dt.time.min, zone).astimezone(dt.UTC)
    upper = dt.datetime.combine(today + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)

    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

    monkeypatch.setattr(manage_overview, "dt", SimpleNamespace(
        datetime=Clock, timedelta=dt.timedelta, time=dt.time, UTC=dt.UTC,
    ))
    with Session(db.get_engine()) as session:
        session.add(FamilySettings(family_id="f1", timezone=str(zone)))
        for key, state in [("draft-video", "draft"), ("archived-video", "archived")]:
            session.add(Item(id=key, family_id="f1", type="Episode", name=key, parent_id="series"))
            session.flush()
            session.add(ResourceState(item_id=key, status=state, ready=False))
        session.add(Item(id="other-folder", family_id="f2", type="Series", name="Other family"))
        session.add_all([
            Device(id="active-tv", family_id="f1", user_id="u1", name="Active"),
            Device(id="revoked-tv", family_id="f1", user_id="u1", name="Revoked", revoked=True),
            Device(id="other-tv", family_id="f2", user_id="u1", name="Other"),
        ])
        for file_id, size in [("v1", 10), ("s1", 4), ("s2", 9000)]:
            session.get(MediaFile, file_id).size_bytes = size
        for index, state in enumerate(["uploading", "processing", "failed", "ready"]):
            session.add(UploadSession(id=f"upload-{index}", family_id="f1", item_id="e1",
                filename="test.mp4", kind="video", size=100, fingerprint=str(index), status=state))
        session.add(UploadSession(id="other-upload", family_id="f2", item_id="e2",
            filename="other.mp4", kind="video", size=100, fingerprint="other"))
        session.flush()
        cases = [
            ("recent", "f1", fixed - dt.timedelta(hours=1), "family_watch", None, 1000),
            ("lower-edge", "f1", lower, "child_watch", None, 1000),
            ("too-old", "f1", lower - dt.timedelta(microseconds=1), "child_watch", None, 1000),
            ("future", "f1", upper, "family_watch", None, 1000),
            ("preview", "f1", fixed, "parent_preview", None, 1000),
            ("legacy-tv", "f1", fixed, "parent_preview", "active-tv", 1000),
            ("not-played", "f1", fixed, "child_watch", None, 0),
            ("other-watch", "f2", fixed, "family_watch", "other-tv", 1000),
        ]
        for key, family, started, purpose, device, played in cases:
            session.add(WatchSession(id=key, family_id=family, user_id="u1", item_id="e1" if family == "f1" else "e2",
                item_name="Story", started_at=started, purpose=purpose, device_id=device, last_seq=0))
            session.flush()
            session.add(WatchInterval(session_id=key, seq=0, start_ms=0, end_ms=played,
                played_ms=played, position_ms=played))
        session.add(WatchInterval(session_id="recent", seq=1, start_ms=1000, end_ms=2000,
            played_ms=1000, position_ms=2000))
        session.commit()
    response = parent.get("/api/manage/overview")
    assert response.status_code == 200
    data = response.json()
    assert data["media"] == {"folders": 1, "videos": 3, "published": 1, "draft": 1, "archived": 1}
    assert data["uploads"] == {"active": 2, "failed": 1, "ready": 1}
    assert data["devices"] == {"active": 1, "revoked": 1}
    assert data["children"] == 1 and data["storageBytes"] == 14
    assert data["watch"] == {"last7DaysSessions": 3, "timezone": str(zone)}
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        session.commit()
    assert parent.get("/api/manage/overview").json() == data


def test_overview_query_count_stays_constant_as_media_grows(parent):
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    engine = db.get_engine()
    event.listen(engine, "before_cursor_execute", capture)
    try:
        assert parent.get("/api/manage/overview").status_code == 200
        baseline = len(statements)
        with Session(engine) as session:
            session.add_all([Item(id=f"video-{index}", family_id="f1", type="Episode", name="Video", parent_id="series") for index in range(400)])
            session.commit()
        statements.clear()
        data = parent.get("/api/manage/overview").json()
        assert data["media"]["videos"] == 401
        assert len(statements) == baseline
        assert not any("SELECT items.id," in statement for statement in statements)
    finally:
        event.remove(engine, "before_cursor_execute", capture)
