"""SQLAlchemy engine + session helpers."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import BigInteger, create_engine, event, func, inspect, select
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


def upgrade_watch_control_daily(engine) -> None:
    """Keep existing allowances; their first sync adopts them as today's quota."""
    with engine.begin() as connection:
        mysql = engine.dialect.name == "mysql"
        if engine.dialect.name == "sqlite":
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        if mysql and connection.exec_driver_sql(
            "SELECT GET_LOCK('mollytime_daily_quota', 30)"
        ).scalar() != 1:
            raise RuntimeError("Cannot acquire daily quota migration lock")
        try:
            columns = inspect(connection).get_columns("watch_controls")
            if "quota_day" not in {column["name"] for column in columns}:
                connection.exec_driver_sql("ALTER TABLE watch_controls ADD COLUMN quota_day VARCHAR(10)")
        finally:
            if mysql:
                connection.exec_driver_sql("SELECT RELEASE_LOCK('mollytime_daily_quota')")


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
            "ALTER TABLE trash_entries ADD COLUMN deleted_objects JSON NOT NULL DEFAULT '[]'"
        )


def upgrade_share_credentials(engine) -> None:
    """Remove the separate token credential while preserving snapshots and claims."""
    from sqlalchemy import MetaData
    from sqlalchemy.schema import CreateTable

    from .models import Family, User
    from .share_models import ContentShare

    with engine.connect() as connection:
        sqlite = engine.dialect.name == "sqlite"
        mysql = engine.dialect.name == "mysql"
        if mysql:
            acquired = connection.exec_driver_sql(
                "SELECT GET_LOCK('mollytime_share_code_schema', 30)"
            ).scalar()
            connection.commit()
            if acquired != 1:
                raise RuntimeError("Cannot acquire content sharing schema migration lock")
        if sqlite:
            # Rebuilding a UNIQUE column requires temporarily disabling FK enforcement
            # on this connection. The write lock excludes concurrent initializers.
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            connection.commit()
            connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            inspector = inspect(connection)
            if "content_shares" in inspector.get_table_names() and "token_hash" in {
                column["name"] for column in inspector.get_columns("content_shares")
            }:
                if sqlite:
                    metadata = MetaData()
                    Family.__table__.to_metadata(metadata)
                    User.__table__.to_metadata(metadata)
                    replacement = ContentShare.__table__.to_metadata(
                        metadata, name="content_shares_code_migration"
                    )
                    connection.execute(CreateTable(replacement))
                    names = ", ".join(column.name for column in ContentShare.__table__.columns)
                    connection.exec_driver_sql(
                        f"INSERT INTO content_shares_code_migration ({names}) SELECT {names} FROM content_shares"
                    )
                    connection.exec_driver_sql("DROP TABLE content_shares")
                    connection.exec_driver_sql(
                        "ALTER TABLE content_shares_code_migration RENAME TO content_shares"
                    )
                    for index in ContentShare.__table__.indexes:
                        index.create(connection, checkfirst=True)
                else:
                    connection.exec_driver_sql("ALTER TABLE content_shares DROP COLUMN token_hash")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            if sqlite:
                connection.exec_driver_sql("PRAGMA foreign_keys=ON")
                connection.commit()
            if mysql:
                connection.exec_driver_sql("SELECT RELEASE_LOCK('mollytime_share_code_schema')")
                connection.commit()


def upgrade_query_schema(engine):
    """Add report indexes and widen counters without rewriting application data."""
    from .management_models import (
        DeviceDownload,
        UploadSession,
        WatchInterval,
        WatchProgress,
        WatchSession,
    )
    from .models import Item, MediaFile

    tables = [Item.__table__, MediaFile.__table__, UploadSession.__table__,
              WatchSession.__table__, WatchInterval.__table__, WatchProgress.__table__,
              DeviceDownload.__table__]
    with engine.begin() as connection:
        mysql = engine.dialect.name == "mysql"
        if mysql:
            acquired = connection.exec_driver_sql(
                "SELECT GET_LOCK('mollytime_query_schema', 30)"
            ).scalar()
            if acquired != 1:
                raise RuntimeError("Cannot acquire query schema migration lock")
        try:
            inspector = inspect(connection)
            for table in tables:
                if engine.dialect.name == "mysql":
                    columns = {column["name"]: column for column in inspector.get_columns(table.name)}
                    quote = connection.dialect.identifier_preparer.quote_identifier
                    for column in table.columns:
                        existing = columns[column.name]
                        if not isinstance(column.type, BigInteger) or isinstance(existing["type"], BigInteger):
                            continue
                        nullable = "NULL" if existing["nullable"] else "NOT NULL"
                        default = existing.get("default")
                        default_sql = f" DEFAULT {default}" if default is not None else ""
                        connection.exec_driver_sql(
                            f"ALTER TABLE {quote(table.name)} MODIFY COLUMN {quote(column.name)} "
                            f"BIGINT {nullable}{default_sql}"
                        )
                existing_indexes = {index["name"] for index in inspector.get_indexes(table.name)}
                for index in sorted(table.indexes, key=lambda index: index.name):
                    if index.name not in existing_indexes:
                        index.create(bind=connection, checkfirst=True)
        finally:
            if mysql:
                connection.exec_driver_sql("SELECT RELEASE_LOCK('mollytime_query_schema')")


def init_db() -> None:
    """Create tables. Idempotent."""
    # Import models so they register with Base.metadata.
    from . import (
        accounts,
        catalog_versions,  # noqa: F401 -- register transactional catalog clocks
        management_models,
        models,
        share_models,  # noqa: F401 -- register additive sharing tables
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
    upgrade_share_credentials(engine)
    Base.metadata.create_all(bind=engine)
    # create_all creates new tables but does not upgrade columns in existing ones.
    upgrade_watch_control_daily(engine)
    upgrade_reminder_sessions(engine)
    upgrade_trash_entries(engine)
    upgrade_query_schema(engine)
    # create_all does not add indexes to existing tables. Enforce the same global
    # username invariant on legacy databases without rewriting users or their IDs.
    with engine.begin() as connection:
        username_index = next(
            index for index in models.User.__table__.indexes if index.name == "uq_user_name"
        )
        existing = next(
            (
                index
                for index in inspect(connection).get_indexes("users")
                if index["name"] == username_index.name
            ),
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
                    "Cannot enforce globally unique usernames: "
                    + names
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
        if session.get(management_models.SchemaRevision, "content-sharing-v1") is None:
            session.add(management_models.SchemaRevision(id="content-sharing-v1"))
            session.commit()
        if session.get(management_models.SchemaRevision, "content-sharing-code-v2") is None:
            session.add(management_models.SchemaRevision(id="content-sharing-code-v2"))
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
