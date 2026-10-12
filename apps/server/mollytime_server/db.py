"""SQLAlchemy engine + session helpers."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event, inspect
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


def init_db() -> None:
    """Create tables. Idempotent."""
    # Import models so they register with Base.metadata.
    from . import (
        management_models,
        models,  # noqa: F401
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
    # Storage tables are additive: existing uploads/files need no ALTER or backfill.
    # Existing scan resources remain available; explicit state rows govern new uploads.
    with get_session_factory()() as session:
        if session.get(management_models.SchemaRevision, "management-v1") is None:
            session.add(management_models.SchemaRevision(id="management-v1"))
            session.commit()
        if session.get(management_models.SchemaRevision, "storage-v2") is None:
            session.add(management_models.SchemaRevision(id="storage-v2"))
            session.commit()


def session_scope() -> Iterator[Session]:
    """FastAPI-style session dependency."""
    factory = get_session_factory()
    db = factory()
    try:
        yield db
    finally:
        db.close()
