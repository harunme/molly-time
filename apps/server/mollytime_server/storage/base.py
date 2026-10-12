"""Storage backend interface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class StoredObject:
    """Pointer to a single media object regardless of backend."""

    backend: str          # 'local' | 'oss'
    key: str              # backend-relative path
    size_bytes: int = 0
    mime: str = ""


class StorageBackend(Protocol):
    name: str

    def resolve(self, key: str) -> StoredObject: ...

    # Direct streaming (used for local disk + range requests).
    def stream_range(self, key: str, start: int, end: int | None) -> bytes: ...

    def size(self, key: str) -> int: ...

    def open(self, key: str) -> bytes: ...

    # For OSS we prefer signed URLs over proxying.
    def signed_url(self, key: str, ttl_seconds: int) -> str | None: ...