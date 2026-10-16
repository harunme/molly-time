"""Short database transactions and explicit boundaries around external I/O."""

from contextlib import contextmanager

from sqlalchemy import text


@contextmanager
def external_io(db, *resume):
    """Release a read snapshot before filesystem/network work, without committing.

    Loaded objects stay readable but detached, so accidental lazy SQL during I/O
    fails instead of silently opening another transaction. Explicitly listed rows
    are reattached on success for a subsequent short write transaction. Callers
    must keep their application lock across validation, I/O and the final write.
    Never use this to split uncommitted changes.
    """
    if db.new or db.deleted or any(db.is_modified(row) for row in db.dirty):
        raise RuntimeError("External I/O cannot interrupt pending database changes")
    db.expunge_all()
    db.rollback()
    yield
    db.add_all(row for row in resume if row is not None)


def serialize_sqlite_write(db):
    if db.bind.dialect.name == "sqlite":
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
