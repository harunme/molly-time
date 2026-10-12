"""Factory: pick storage backend from settings."""

from __future__ import annotations

from functools import lru_cache

from ..config import get_settings
from .base import StorageBackend
from .local import LocalStorage
from .oss import OssStorage


@lru_cache(maxsize=1)
def build_storage() -> StorageBackend:
    s = get_settings()
    if s.storage_backend == "local":
        return LocalStorage(s.resolved_media_dir())
    if s.storage_backend == "oss":
        return OssStorage(
            endpoint=s.oss_endpoint,
            bucket=s.oss_bucket,
            access_key_id=s.oss_access_key_id,
            access_key_secret=s.oss_access_key_secret,
            cdn_domain=s.oss_cdn_domain,
        )
    raise ValueError(f"unknown storage backend: {s.storage_backend!r}")