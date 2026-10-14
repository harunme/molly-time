"""Move a live SQLite deployment's local media to permanent OSS objects.

Run inside the existing server container, where /data/server.db, /data/media,
and the configured OSS credentials are available. Files are uploaded and
verified before any database path changes. Re-running is safe after a network
failure; existing objects must carry the expected SHA-256 metadata.
"""

from __future__ import annotations

import hashlib
import sqlite3
import time
from pathlib import Path

import oss2

from mollytime_server.storage.settings import get_storage_settings


DATA = Path("/data")
MEDIA = DATA / "media"
CHECKPOINTS = DATA / ".oss-media-checkpoints"
MIME = {
    ".mp4": "video/mp4",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def upload_verified(bucket: oss2.Bucket, path: Path, key: str, size: int, digest: str) -> None:
    headers = {
        "Content-Type": MIME.get(path.suffix.lower(), "application/octet-stream"),
        "x-oss-meta-sha256": digest,
    }
    for attempt in range(1, 6):
        try:
            try:
                head = bucket.head_object(key)
            except oss2.exceptions.NoSuchKey:
                head = None
            if head is None:
                oss2.resumable_upload(
                    bucket,
                    key,
                    str(path),
                    store=oss2.ResumableStore(root=str(CHECKPOINTS)),
                    headers=headers,
                    multipart_threshold=8 * 1024 * 1024,
                    part_size=1024 * 1024,
                    num_threads=2,
                )
                head = bucket.head_object(key)
            remote_digest = head.headers.get("x-oss-meta-sha256", "")
            if head.content_length != size or remote_digest != digest:
                raise RuntimeError(f"OSS object mismatch: {key}")
            return
        except (oss2.exceptions.RequestError, TimeoutError, ConnectionError) as exc:
            if attempt == 5:
                raise
            print(f"retry {attempt}/5 for {key}: {exc}", flush=True)
            time.sleep(min(10 * attempt, 40))


def main() -> None:
    settings = get_storage_settings()
    if not all((settings.oss_endpoint, settings.oss_bucket,
                settings.oss_access_key_id, settings.oss_access_key_secret)):
        raise RuntimeError("OSS configuration is incomplete")
    bucket = oss2.Bucket(
        oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret),
        settings.oss_endpoint,
        settings.oss_bucket,
        connect_timeout=120,
    )
    db = sqlite3.connect(DATA / "server.db", timeout=30)
    db.row_factory = sqlite3.Row
    rows = [dict(row) for row in db.execute(
        "SELECT id, family_id, path, mime, size_bytes, sha256 "
        "FROM media_files WHERE storage='local' ORDER BY size_bytes, id"
    )]
    if not rows:
        (DATA / "local-media-to-oss-complete").touch()
        print("No local media records remain.", flush=True)
        return

    planned: list[tuple[dict, str]] = []
    by_path: dict[str, str] = {}
    for row in rows:
        relative = Path(row["path"])
        path = (MEDIA / relative).resolve()
        if not path.is_relative_to(MEDIA.resolve()) or not path.is_file():
            raise RuntimeError(f"missing or unsafe local media: {row['id']}")
        if path.stat().st_size != row["size_bytes"]:
            raise RuntimeError(f"local size mismatch: {row['id']}")
        key = f"families/{row['family_id']}/media/{row['id']}{path.suffix.lower()}"
        if key in by_path.values():
            raise RuntimeError(f"duplicate OSS key: {key}")
        planned.append((row, key))
        by_path[row["path"]] = key

    print(f"Uploading {len(planned)} catalog files before changing the database.", flush=True)
    for index, (row, key) in enumerate(planned, 1):
        path = MEDIA / row["path"]
        digest = digest_file(path)
        if row["sha256"] and row["sha256"] != digest:
            raise RuntimeError(f"local SHA-256 mismatch: {row['id']}")
        upload_verified(bucket, path, key, row["size_bytes"], digest)
        if index % 10 == 0 or index == len(planned):
            print(f"Verified {index}/{len(planned)} catalog files in OSS.", flush=True)

    # Preserve two legacy cover files that are present on disk but have no
    # catalog row. They are not referenced by the application.
    referenced = set(by_path)
    extras = sorted(path for path in MEDIA.rglob("*") if path.is_file()
                    and str(path.relative_to(MEDIA)) not in referenced)
    for path in extras:
        relative = path.relative_to(MEDIA)
        if len(relative.parts) != 3 or relative.parts[:1] != ("managed",):
            raise RuntimeError(f"unexpected unreferenced media: {relative}")
        family_id = relative.parts[1]
        key = f"families/{family_id}/media/legacy/{relative.name}"
        upload_verified(bucket, path, key, path.stat().st_size, digest_file(path))
    print(f"Verified {len(extras)} unreferenced legacy files in OSS.", flush=True)

    db.execute("BEGIN IMMEDIATE")
    try:
        for row, key in planned:
            updated = db.execute(
                "UPDATE media_files SET storage='oss', path=? "
                "WHERE id=? AND storage='local' AND path=?",
                (key, row["id"], row["path"]),
            )
            if updated.rowcount != 1:
                raise RuntimeError(f"media row changed during upload: {row['id']}")
            db.execute(
                "UPDATE upload_targets SET backend='oss', object_key=? "
                "WHERE upload_id=? AND backend='local'",
                (key, row["id"]),
            )
        remaining = db.execute(
            "SELECT count(*) FROM media_files WHERE storage='local'"
        ).fetchone()[0]
        if remaining:
            raise RuntimeError(f"{remaining} local media rows remain")
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    (DATA / "local-media-to-oss-complete").touch()
    print(f"Committed {len(planned)} media rows to OSS; local files remain for rollback.", flush=True)


if __name__ == "__main__":
    main()
