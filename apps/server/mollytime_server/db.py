"""SQLAlchemy engine + session helpers."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event, func, inspect, select
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def get_engine():
    global _engine
    if _engine is None:
        url = get_settings().resolved_db_url()
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(url, future=True, connect_args=connect_args)
        if url.startswith("sqlite"):

            @event.listens_for(_engine, "connect")
            def _sqlite_connection(connection, _record):
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("PRAGMA busy_timeout=5000")
                connection.execute("PRAGMA journal_mode=WAL")

    return _engine


def get_session_factory() -> sessionmaker[Session]:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False, autoflush=False)
    return _SessionLocal


def upgrade_reminder_sessions(engine) -> None:
    """Add session binding to early reminder tables without replacing existing rows."""
    with engine.begin() as connection:
        # Startup and the media worker may initialize the same SQLite database.
        # Lock before checking the schema so only one initializer adds the column.
        if engine.dialect.name == "sqlite":
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = inspect(connection).get_columns("device_reminders")
        if "session_id" in {column["name"] for column in columns}:
            return
        connection.exec_driver_sql(
            "ALTER TABLE device_reminders ADD COLUMN "
            "session_id VARCHAR(36) REFERENCES watch_sessions(id)"
        )
        # Preserve requests already attached to a currently active episode.
        # Idle requests stay unbound until their first playback session starts.
        connection.exec_driver_sql("""
            UPDATE device_reminders SET session_id = (
                SELECT id FROM watch_sessions
                WHERE watch_sessions.family_id = device_reminders.family_id
                  AND watch_sessions.device_id = device_reminders.device_id
                  AND watch_sessions.item_id = device_reminders.episode_id
                  AND watch_sessions.ended = false
                ORDER BY watch_sessions.started_at DESC, watch_sessions.id DESC
                LIMIT 1
            ) WHERE phase IN ('pending', 'watching')
        """)


def upgrade_trash_entries(engine) -> None:
    """Add deletion progress to early recycle-bin tables, preserving existing entries."""
    with engine.begin() as connection:
        # API and standalone worker startup may overlap. Check under the write lock.
        if engine.dialect.name == "sqlite":
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = inspect(connection).get_columns("trash_entries")
        if "deleted_objects" in {column["name"] for column in columns}:
            return
        connection.exec_driver_sql(
            "ALTER TABLE trash_entries ADD COLUMN "
            "deleted_objects JSON NOT NULL DEFAULT '[]'"
        )


def init_db() -> None:
    """Create tables. Idempotent."""
    # Import models so they register with Base.metadata.
    from . import (
        accounts,
        catalog_versions,  # noqa: F401 -- register transactional catalog clocks
        management_models,
        models,
        usage_models,  # noqa: F401 -- register usage tables with Base.metadata
    )

    engine = get_engine()
    if (
        engine.dialect.name == "sqlite"
        and "items" in inspect(engine).get_table_names()
        and "schema_revisions" not in inspect(engine).get_table_names()
    ):
        database = engine.url.database
        if database and database != ":memory:":
            backup = Path(database).with_suffix(".pre-management-v1.sqlite")
            if not backup.exists():
                with sqlite3.connect(database) as source, sqlite3.connect(backup) as target:
                    source.backup(target)
    Base.metadata.create_all(bind=engine)
    # create_all creates new tables but does not upgrade columns in existing ones.
    upgrade_reminder_sessions(engine)
    upgrade_trash_entries(engine)
    # create_all does not add indexes to existing tables. Enforce the same global
    # username invariant on legacy databases without rewriting users or their IDs.
    with engine.begin() as connection:
        username_index = next(
            index for index in models.User.__table__.indexes if index.name == "uq_user_name"
        )
        existing = next(
            (index for index in inspect(connection).get_indexes("users")
             if index["name"] == username_index.name),
            None,
        )
        if existing is not None:
            if not existing["unique"] or existing["column_names"] != ["name"]:
                raise RuntimeError("users.uq_user_name must be a unique index on name")
        else:
            duplicates = connection.execute(
                select(models.User.name, func.count())
                .group_by(models.User.name)
                .having(func.count() > 1)
                .order_by(models.User.name)
            ).all()
            if duplicates:
                names = ", ".join(f"{name!r} ({count} accounts)" for name, count in duplicates)
                raise RuntimeError(
                    "Cannot enforce globally unique usernames: " + names
                    + ". Rename the conflicting users before restarting; "
                    "no accounts have been renamed or merged."
                )
            username_index.create(bind=connection, checkfirst=True)
    # Storage tables are additive: existing uploads/files need no ALTER or backfill.
    # Existing scan resources remain available; explicit state rows govern new uploads.
    with get_session_factory()() as session:
        from .trash import backfill_trash

        backfill_trash(session)
        accounts.backfill_identities(session)
        if session.get(management_models.SchemaRevision, "management-v1") is None:
            session.add(management_models.SchemaRevision(id="management-v1"))
            session.commit()
        if session.get(management_models.SchemaRevision, "storage-v2") is None:
            session.add(management_models.SchemaRevision(id="storage-v2"))
            session.commit()
        if session.get(management_models.SchemaRevision, "global-usernames-v1") is None:
            session.add(management_models.SchemaRevision(id="global-usernames-v1"))
            session.commit()
        if session.get(management_models.SchemaRevision, "email-accounts-v1") is None:
            session.add(management_models.SchemaRevision(id="email-accounts-v1"))
            session.commit()
        if session.get(management_models.SchemaRevision, "family-usage-v1") is None:
            session.add(management_models.SchemaRevision(id="family-usage-v1"))
            session.commit()


def session_scope() -> Iterator[Session]:
    """FastAPI-style session dependency."""
    factory = get_session_factory()
    db = factory()
    try:
        yield db
    finally:
        db.close()
