"""Storage abstraction: local disk (P0) + OSS/S3 (stub)."""

from .base import StorageBackend, StoredObject
from .factory import build_storage

__all__ = ["StorageBackend", "StoredObject", "build_storage"]