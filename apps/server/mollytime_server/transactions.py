"""SQLite write serialization for read-check-write business invariants."""

from sqlalchemy import text


def serialize_sqlite_write(db):
    if db.bind.dialect.name == "sqlite":
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
