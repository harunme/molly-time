"""Account libraries share one exact byte limit per family."""

from .config import get_settings

DEFAULT_STORAGE_LIMIT_BYTES = 5 * 1024**3
MAX_STORAGE_LIMIT_BYTES = 2**53 - 1  # Exact in JSON clients as well as BIGINT storage.


def storage_limit(db, family_id):
    from .models import Family

    family = db.get(Family, family_id)
    if family is not None and family.storage_limit_bytes is not None:
        return family.storage_limit_bytes
    # NULL is reserved for libraries created before per-account quotas.
    return get_settings().family_storage_limit_bytes
