"""Validated homepage drafts, immutable publications and child inheritance."""

import datetime as dt

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from ..deps import DbSession
from ..images import image_url
from ..manage_auth import Parent
from ..management_models import HomeConfig, HomeRevision, ResourceState, WatchProgress
from ..models import ChildProfile, Item
from ..resource_policy import published_episodes, published_series, visible
from .manage_resources import owned

router = APIRouter(prefix="/api/manage/home-config", tags=["manage-home"])
DEFAULT = {
    "schemaVersion": 1,
    "rows": [
        {
            "id": "library",
            "title": "我的媒体库",
            "source": "recent",
            "enabled": True,
            "limit": 24,
            "itemIds": [],
        }
    ],
}


class Row(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern="^[A-Za-z0-9-]+$")
    title: str = Field(min_length=1, max_length=40)
    source: str = Field(pattern="^(manual|recent|continue)$")
    enabled: bool = True
    limit: int = Field(default=12, ge=1, le=48)
    itemIds: list[str] = Field(default_factory=list, max_length=48)

    @model_validator(mode="after")
    def check(self):
        if not self.title.strip() or len(set(self.itemIds)) != len(self.itemIds):
            raise ValueError("栏目标题为空或内容重复")
        if self.source != "manual" and self.itemIds:
            raise ValueError("自动栏目不接受手选内容")
        return self


class Content(BaseModel):
    schemaVersion: int = Field(default=1, ge=1, le=1)
    rows: list[Row] = Field(max_length=12)

    @model_validator(mode="after")
    def check(self):
        if len({r.id for r in self.rows}) != len(self.rows):
            raise ValueError("栏目 ID 重复")
        return self


class Save(BaseModel):
    revision: int = Field(ge=0)
    content: Content


class Publish(BaseModel):
    revision: int = Field(ge=0)


def config_key(family, child):
    return f"{family}:{child or 'default'}"


def check_child(db, child, family):
    if child:
        owned(db, ChildProfile, child, family)


def effective_content(db, family, child=None):
    check_child(db, child, family)
    for key in ([config_key(family, child)] if child else []) + [config_key(family, None)]:
        config = db.get(HomeConfig, key)
        revision = (
            db.get(HomeRevision, config.published_id) if config and config.published_id else None
        )
        if revision:
            return revision.content, revision.id
    return DEFAULT, "default"


def validate_references(content, db, family, publishing=False):
    for row in content["rows"]:
        for key in row["itemIds"]:
            item = owned(db, Item, key, family)
            if item.type != "Series":
                raise HTTPException(422, "手选栏目只支持系列")
            if publishing and row["enabled"] and not published_episodes(db, key, family):
                raise HTTPException(409, f"{item.name} 还没有已发布且可播放的剧集")


@router.get("")
def read(user: Parent, db: DbSession, childId: str | None = None):
    check_child(db, childId, user.family_id)
    config = db.get(HomeConfig, config_key(user.family_id, childId))
    content, published = effective_content(db, user.family_id, childId)
    return {
        "revision": config.revision if config else 0,
        "content": config.draft if config else content,
        "publishedId": config.published_id if config else None,
        "followingFamily": bool(childId and (config is None or config.published_id is None)),
        "effectivePublishedId": published,
    }


@router.put("")
def save(body: Save, user: Parent, db: DbSession, childId: str | None = None):
    check_child(db, childId, user.family_id)
    content = body.content.model_dump()
    validate_references(content, db, user.family_id)
    key = config_key(user.family_id, childId)
    config = db.get(HomeConfig, key)
    if config is None:
        if body.revision != 0:
            raise HTTPException(409, "首页已被修改，请重新加载")
        config = HomeConfig(
            id=key, family_id=user.family_id, child_id=childId, revision=1, draft=content
        )
        db.add(config)
    else:
        result = db.execute(
            update(HomeConfig)
            .where(HomeConfig.id == key, HomeConfig.revision == body.revision)
            .values(draft=content, revision=body.revision + 1)
        )
        if result.rowcount != 1:
            raise HTTPException(409, "首页已被修改，请重新加载")
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "首页已被修改，请重新加载") from exc
    return read(user, db, childId)


@router.post("/publish")
def publish(body: Publish, user: Parent, db: DbSession, childId: str | None = None):
    check_child(db, childId, user.family_id)
    config = db.get(HomeConfig, config_key(user.family_id, childId))
    if config is None:
        raise HTTPException(409, "请先保存草稿")
    validate_references(config.draft, db, user.family_id, publishing=True)
    revision = HomeRevision(config_id=config.id, content=config.draft, user_id=user.id)
    db.add(revision)
    db.flush()
    result = db.execute(
        update(HomeConfig)
        .where(HomeConfig.id == config.id, HomeConfig.revision == body.revision)
        .values(published_id=revision.id, revision=body.revision + 1)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(409, "首页已被修改，请重新加载")
    db.commit()
    return read(user, db, childId)


@router.get("/revisions")
def revisions(user: Parent, db: DbSession, childId: str | None = None):
    check_child(db, childId, user.family_id)
    rows = (
        db.query(HomeRevision)
        .filter(HomeRevision.config_id == config_key(user.family_id, childId))
        .order_by(HomeRevision.created_at.desc())
        .limit(20)
        .all()
    )
    return [
        {"id": r.id, "createdAt": r.created_at.isoformat() + "Z", "content": r.content}
        for r in rows
    ]


@router.delete("")
def follow_family(user: Parent, db: DbSession, childId: str):
    if not childId:
        raise HTTPException(422, "请选择儿童档案")
    check_child(db, childId, user.family_id)
    config = db.get(HomeConfig, config_key(user.family_id, childId))
    if config:
        config.published_id = None
        config.revision += 1
        config.draft = effective_content(db, user.family_id)[0]
        db.commit()
    return read(user, db, childId)


def render_home(content, db, family, child=None, modern=True):
    from .catalog import EpisodeSummary, ImageRef, SeriesSummary

    # Hold containers for the duration of the request to avoid weak-identity-map N+1 reads.
    db.info["home_containers"] = (
        db.query(Item).filter(Item.family_id == family, Item.type.in_(["Series", "Season"])).all()
    )
    available = published_series(db, family)
    lookup = {s.id: s for s in available}
    result = []
    for row in content["rows"]:
        if not row["enabled"]:
            continue
        if row["source"] == "continue":
            if not modern or not child:
                continue
            progresses = (
                db.query(WatchProgress)
                .filter(
                    WatchProgress.family_id == family,
                    WatchProgress.child_id == child,
                    WatchProgress.completed.is_(False),
                    WatchProgress.position_ms > 0,
                )
                .order_by(WatchProgress.session_started_at.desc())
                .limit(100)
                .all()
            )
            positions = {p.item_id: p.position_ms for p in progresses}
            episodes = [db.get(Item, p.item_id) for p in progresses]
            episodes = [e for e in episodes if e and visible(db, e)][: row["limit"]]
            items = [
                dict(
                    EpisodeSummary(
                        id=e.id,
                        name=e.name,
                        runtimeMs=(e.runtime_ticks or 0) // 10000,
                        image=ImageRef(url=image_url(db, e)),
                    ).model_dump(),
                    type="episode",
                    positionMs=positions[e.id],
                )
                for e in episodes
            ]
        else:
            if row["source"] == "manual":
                selected = [lookup[key] for key in row["itemIds"] if key in lookup]
            else:

                def published_at(item):
                    state = db.get(ResourceState, item.id)
                    return state.published_at if state and state.published_at else dt.datetime.min

                selected = sorted(available, key=published_at, reverse=True)
            items = [
                SeriesSummary(
                    id=s.id,
                    name=s.name,
                    episodeCount=len(published_episodes(db, s.id, family)),
                    image=ImageRef(url=image_url(db, s)),
                ).model_dump()
                for s in selected[: row["limit"]]
            ]
        if items:
            result.append({"title": row["title"], "items": items})
    return {"rows": result}


class Preview(BaseModel):
    content: Content
    childId: str | None = None


@router.post("/preview")
def preview(body: Preview, user: Parent, db: DbSession):
    check_child(db, body.childId, user.family_id)
    content = body.content.model_dump()
    validate_references(content, db, user.family_id)
    return render_home(content, db, user.family_id, body.childId)
