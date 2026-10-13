"""Local-disk storage backend."""

from __future__ import annotations

from pathlib import Path

from .base import StoredObject


class LocalStorage:
    name = "local"

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _abspath(self, key: str) -> Path:
        # Resolve relative or existing absolute media keys within the configured root.
        p = Path(key)
        target = p.resolve() if p.is_absolute() else (self.root / key).resolve()
        # Reject path traversal: keys must resolve under root.
        if not target.is_relative_to(self.root):
            raise ValueError(f"unsafe key outside root: {key!r}")
        return target

    def iter_range(self, key: str, start: int, end: int, chunk_size: int = 256 * 1024):
        with self._abspath(key).open("rb") as stream:
            stream.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = stream.read(min(chunk_size, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    def resolve(self, key: str) -> StoredObject:
        target = self._abspath(key)
        size = target.stat().st_size if target.exists() else 0
        mime = _guess_mime(target)
        return StoredObject(backend=self.name, key=key, size_bytes=size, mime=mime)

    def stream_range(self, key: str, start: int, end: int | None) -> bytes:
        target = self._abspath(key)
        with target.open("rb") as f:
            f.seek(start)
            if end is None:
                return f.read()
            return f.read(end - start + 1)

    def size(self, key: str) -> int:
        return self._abspath(key).stat().st_size

    def open(self, key: str) -> bytes:
        return self._abspath(key).read_bytes()

    def delete(self, key: str) -> None:
        self._abspath(key).unlink(missing_ok=True)

    def signed_url(self, key: str, ttl_seconds: int) -> str | None:
        # Local backend cannot issue CDN-style signed URLs. Caller decides
        # whether to fall back to direct streaming.
        return None


def _guess_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".srt": "application/x-subrip",
        ".vtt": "text/vtt",
        ".ass": "text/x-ssa",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")
