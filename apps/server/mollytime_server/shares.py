"""Share retention and retryable cleanup, coordinated with media/trash writers."""

import datetime as dt
import hashlib
import logging

from .db import get_session_factory
from .share_models import ContentShare, ObjectCleanup, ShareFile
from .storage import build_storage
from .transactions import serialize_sqlite_write

logger = logging.getLogger(__name__)


def retained_files(db, now=None):
    return (
        db.query(ShareFile)
        .join(ContentShare)
        .filter(
            ContentShare.expires_at > (now or dt.datetime.now(dt.UTC)),
        )
    )


def retained_identities(db, now=None):
    from .trash import object_identity

    return {object_identity(file.storage, file.path) for file in retained_files(db, now)}


def enqueue_cleanup(db, storage, path):
    from .trash import object_identity

    if storage not in ("oss", "local") or not path:
        return
    identity = object_identity(storage, path)
    key = hashlib.sha256(repr(identity).encode()).hexdigest()
    # autoflush=False: also check objects queued earlier in the current transaction.
    if db.get(ObjectCleanup, key) is None and not any(
        isinstance(row, ObjectCleanup) and row.id == key for row in db.new
    ):
        db.add(ObjectCleanup(id=key, storage=storage, path=path))


def cleanup_shares(now=None):
    from .trash import deletion_lock, object_identity, outside_references

    now = now or dt.datetime.now(dt.UTC)
    deleted = 0
    with deletion_lock(), get_session_factory()() as db:
        serialize_sqlite_write(db)
        expired = (
            db.query(ShareFile).join(ContentShare).filter(ContentShare.expires_at <= now).all()
        )
        for file in expired:
            enqueue_cleanup(db, file.storage, file.path)
            db.delete(file)
        db.commit()  # Expired pins and cleanup candidates change atomically.
        protected = outside_references(db, set()) | retained_identities(db, now)
        for candidate in db.query(ObjectCleanup).all():
            if object_identity(candidate.storage, candidate.path) in protected:
                continue
            try:
                build_storage(candidate.storage).delete(candidate.path)
                db.delete(candidate)
                db.commit()
                deleted += 1
            except Exception:
                db.rollback()
                candidate.error = "文件清理失败，将在下一轮重试"
                db.commit()
                logger.exception("Shared object cleanup failed: %s", candidate.id)
    return deleted
