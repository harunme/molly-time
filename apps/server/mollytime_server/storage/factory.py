"""Storage clients cached by configuration, including across live configuration changes."""

from functools import lru_cache

from ..config import get_settings
from .base import StorageBackend
from .local import LocalStorage
from .oss import OssStorage
from .settings import get_storage_settings


@lru_cache(maxsize=8)
def _storage(backend, media_dir, endpoint, bucket, access_key_id, access_key_secret, internal):
    if backend == "local":
        return LocalStorage(media_dir)
    if backend == "oss":
        return OssStorage(
            endpoint=endpoint,
            bucket=bucket,
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            internal_endpoint=internal,
        )
    raise ValueError(f"unknown storage backend: {backend!r}")


def build_storage(backend: str | None = None) -> StorageBackend:
    s = get_storage_settings()
    return _storage(
        backend or s.storage_backend,
        get_settings().resolved_media_dir(),
        s.oss_endpoint,
        s.oss_bucket,
        s.oss_access_key_id,
        s.oss_access_key_secret,
        s.oss_internal_endpoint,
    )


build_storage.cache_clear = _storage.cache_clear
