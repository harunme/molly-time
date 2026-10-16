"""Transactional TV catalog clocks. Progress never invalidates static content."""

import uuid

from sqlalchemy import BigInteger, String, event, inspect, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from .db import Base
from .management_models import (
    DeviceDownload,
    DeviceReminder,
    FamilyReminders,
    HomeConfig,
    HomeRevision,
    MediaOptions,
    ResourceState,
    WatchProgress,
)
from .models import Item, MediaFile, PlaybackEvent


class CatalogVersion(Base):
    __tablename__ = "tv_catalog_versions"
    scope: Mapped[str] = mapped_column(String(200), primary_key=True)
    generation: Mapped[str] = mapped_column(String(36))
    revision: Mapped[int] = mapped_column(BigInteger, default=0)


def scope(family, collection):
    return f"{family}:{collection}"


def version(db, family, collection):
    row = db.execute(
        select(CatalogVersion.generation, CatalogVersion.revision).where(
            CatalogVersion.scope == scope(family, collection)
        )
    ).first()
    return f"v1-{row.generation}-{row.revision}" if row else "v1-initial"


def bump(db, keys):
    seen = db.info.setdefault("tv_clock_bumped", set())
    for key in sorted(keys - seen):
        table = CatalogVersion.__table__
        values = {"scope": key, "generation": str(uuid.uuid4()), "revision": 1}
        connection = db.connection()
        if connection.dialect.name == "sqlite":
            statement = (
                sqlite_insert(table)
                .values(**values)
                .on_conflict_do_update(
                    index_elements=[table.c.scope], set_={"revision": table.c.revision + 1}
                )
            )
        elif connection.dialect.name == "mysql":
            statement = (
                mysql_insert(table)
                .values(**values)
                .on_duplicate_key_update(revision=table.c.revision + 1)
            )
        else:
            raise RuntimeError("TV catalog clocks require SQLite or MySQL")
        connection.execute(statement)
        seen.add(key)


def item_scopes(db, item):
    if not item or not item.family_id:
        return set()
    family = item.family_id
    keys = {scope(family, "catalog"), scope(family, "home"), scope(family, "policy")}
    parents = [item.parent_id]
    if inspect(item).persistent:
        parents += list(inspect(item).attrs.parent_id.history.deleted)
    if item.type == "Series":
        keys.add(scope(family, "folder:" + item.id))
    for parent_id in parents:
        visited = set()
        while parent_id and parent_id not in visited:
            visited.add(parent_id)
            parent = db.get(Item, parent_id)
            if not parent or parent.family_id != family:
                break
            if parent.type == "Series":
                keys.add(scope(family, "folder:" + parent.id))
            parent_id = parent.parent_id
    return keys


def changed_scopes(db, obj):
    if isinstance(obj, Item):
        return item_scopes(db, obj) if obj.id else set()
    if isinstance(obj, (MediaFile, ResourceState)):
        keys = item_scopes(db, db.get(Item, obj.item_id))
        if isinstance(obj, MediaFile):
            for old in inspect(obj).attrs.item_id.history.deleted:
                keys |= item_scopes(db, db.get(Item, old))
        return keys
    if isinstance(obj, MediaOptions):
        media = db.get(MediaFile, obj.media_id)
        return item_scopes(db, db.get(Item, media.item_id)) if media else set()
    if isinstance(obj, (WatchProgress, PlaybackEvent)):
        return {scope(obj.family_id, "playback")} if obj.family_id else set()
    if isinstance(obj, HomeRevision):
        config = db.get(HomeConfig, obj.config_id)
        return (
            {scope(config.family_id, name) for name in ("catalog", "home")}
            if config and config.published_id == obj.id
            else set()
        )
    if isinstance(obj, HomeConfig) and (
        inspect(obj).attrs.published_id.history.has_changes()
        or (obj.published_id and (obj in db.new or obj in db.deleted))
    ):
        return {scope(obj.family_id, name) for name in ("catalog", "home")}
    if isinstance(obj, (DeviceReminder, FamilyReminders, DeviceDownload)):
        if (
            isinstance(obj, DeviceDownload)
            and obj not in db.new
            and not any(
                inspect(obj).attrs[key].history.has_changes() for key in ("desired", "media_id")
            )
        ):
            return set()
        return {scope(obj.family_id, "policy")} if obj.family_id else set()
    return set()


@event.listens_for(Session, "before_flush")
def collect_versions(db, _context, _instances):
    keys = db.info.setdefault("tv_clock_pending", set())
    objects = list(db.new) + list(db.dirty) + list(db.deleted)
    for obj in objects:
        if obj in db.dirty and not db.is_modified(obj, include_collections=False):
            continue
        keys.update(changed_scopes(db, obj))
    db.info["tv_clock_new"] = [obj for obj in db.new if isinstance(obj, Item)]


@event.listens_for(Session, "after_flush_postexec")
def write_versions(db, _context):
    keys = db.info.pop("tv_clock_pending", set())
    for obj in db.info.pop("tv_clock_new", []):
        keys.update(changed_scopes(db, obj))
    bump(db, keys)


@event.listens_for(Session, "do_orm_execute")
def bulk_versions(state):
    # Management publication uses conditional SQL UPDATEs rather than ORM setters.
    if not (state.is_update or state.is_delete):
        return
    table = getattr(state.statement, "table", None)
    if table is None or table.name not in {
        "items",
        "media_files",
        "resource_states",
        "home_configs",
        "home_revisions",
    }:
        return
    model = {
        "items": Item,
        "media_files": MediaFile,
        "resource_states": ResourceState,
        "home_configs": HomeConfig,
        "home_revisions": HomeRevision,
    }[table.name]
    keys = set()
    for obj in state.session.scalars(select(model).where(*state.statement._where_criteria)).all():
        keys.update(changed_scopes(state.session, obj))
        values = getattr(state.statement, "_values", {}) or {}
        changed = {
            getattr(key, "key", key): getattr(value, "value", None) for key, value in values.items()
        }
        if isinstance(obj, Item) and changed.get("parent_id"):
            keys.update(item_scopes(state.session, state.session.get(Item, changed["parent_id"])))
        if isinstance(obj, HomeConfig) and (state.is_delete or "published_id" in changed):
            keys.update(scope(obj.family_id, name) for name in ("catalog", "home"))
    bump(state.session, keys)


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
def clear_versions(db):
    for key in ("tv_clock_bumped", "tv_clock_pending", "tv_clock_new"):
        db.info.pop(key, None)
