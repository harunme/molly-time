import datetime as dt

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from mollytime_server.api.manage_home import render_home
from mollytime_server.db import Base
from mollytime_server.images import image_url
from mollytime_server.management_models import ResourceState, WatchProgress
from mollytime_server.models import ChildProfile, Family, Item, MediaFile


@pytest.fixture
def catalog():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add_all([Family(id="f", name="Home"), Family(id="other", name="Other")])
        db.add(ChildProfile(id="child", family_id="f", name="Child"))
        db.add_all([
            Item(id="series", family_id="f", type="Series", name="Series"),
            Item(id="season", family_id="f", parent_id="series", type="Season", name="Season"),
            Item(id="draft", family_id="f", parent_id="season", type="Episode", name="A draft", primary_image_tag="draft-cover"),
            Item(id="episode", family_id="f", parent_id="season", type="Episode", name="B episode", runtime_ticks=1200000000, primary_image_tag="frame"),
            Item(id="foreign", family_id="other", parent_id="season", type="Episode", name="A foreign", primary_image_tag="foreign-cover"),
        ])
        db.flush()
        db.add(ResourceState(item_id="draft", status="draft", ready=True))
        for key, family in [("draft", "f"), ("episode", "f"), ("foreign", "other")]:
            db.add(MediaFile(id=f"image-{key}", item_id=key, family_id=family, kind="image", path=f"{key}.jpg", storage="local"))
        db.add(MediaFile(id="video", item_id="episode", family_id="f", kind="video", path="episode.mp4", storage="local"))
        db.commit()
        yield db
    engine.dispose()


def test_containers_reuse_only_published_family_artwork(catalog):
    for key in ["series", "season"]:
        assert image_url(catalog, catalog.get(Item, key)) == "/api/items/episode/image?v=frame"
    series = catalog.get(Item, "series")
    series.primary_image_tag = "custom"
    catalog.flush()
    assert image_url(catalog, series) == "/api/items/series/image?v=custom"
    assert image_url(catalog, catalog.get(Item, "season")) == "/api/items/season/image?v=custom"


def test_continue_row_exposes_real_position_for_selected_child(catalog):
    catalog.add(WatchProgress(id="progress", session_id="session", seq=1, family_id="f", child_id="child", item_id="episode", position_ms=30000,
                             completed=False, session_started_at=dt.datetime.now(dt.UTC)))
    catalog.commit()
    content = {"rows": [{"enabled": True, "source": "continue", "title": "Continue", "limit": 10}]}
    result = render_home(content, catalog, "f", "child")
    assert result["rows"][0]["items"][0]["positionMs"] == 30000
    assert result["rows"][0]["items"][0]["runtimeMs"] == 120000
    assert render_home(content, catalog, "f")["rows"] == []
    assert render_home(content, catalog, "f", "child", modern=False)["rows"] == []


def test_recently_played_includes_completed_and_isolates_profiles(catalog):
    now = dt.datetime.now(dt.UTC)
    for key, item, child, completed, started in [
        ("older", "episode", "child", False, now - dt.timedelta(days=1)),
        ("latest", "episode", "child", True, now),
        ("draft-progress", "draft", "child", False, now),
        ("foreign-progress", "foreign", "child", False, now),
        ("family-progress", "episode", None, False, now),
    ]:
        catalog.add(WatchProgress(id=key, session_id=key, seq=1, family_id="f",
                                  child_id=child, item_id=item, position_ms=30000,
                                  completed=completed, session_started_at=started))
    catalog.commit()
    content = {"rows": [{"enabled": True, "source": "recently-played", "title": "最近播放", "limit": 24}]}
    items = render_home(content, catalog, "f", "child")["rows"][0]["items"]
    assert [item["id"] for item in items] == ["episode"]
    assert items[0]["completed"] is True
    assert render_home(content, catalog, "f")["rows"][0]["items"][0]["completed"] is False
    assert render_home(content, catalog, "other")["rows"] == []
    assert render_home(content, catalog, "f", "child", modern=False)["rows"] == []
