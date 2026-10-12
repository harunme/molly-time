"""Factory: pick storage backend from settings."""

from __future__ import annotations

from functools import lru_cache

from ..config import get_settings
from .base import StorageBackend
from .local import LocalStorage
from .oss import OssStorage


@lru_cache(maxsize=3)
def build_storage(backend: str | None = None) -> StorageBackend:
    s = get_settings()
    backend = backend or s.storage_backend
    if backend == "local":
        return LocalStorage(s.resolved_media_dir())
    if backend == "oss":
        return OssStorage(
            endpoint=s.oss_endpoint,
            bucket=s.oss_bucket,
            access_key_id=s.oss_access_key_id,
            access_key_secret=s.oss_access_key_secret,
            internal_endpoint=s.oss_internal_endpoint,
        )
    raise ValueError(f"unknown storage backend: {backend!r}")
