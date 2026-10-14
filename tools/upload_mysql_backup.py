"""Encrypt a MySQL dump and upload it to the configured private OSS bucket."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import oss2
from cryptography.fernet import Fernet

from mollytime_server.storage.settings import get_storage_settings


def main() -> None:
    source = Path(sys.argv[1])
    if source.parent != Path("/data/backups") or source.suffix != ".gz":
        raise SystemExit("expected a MySQL dump in /data/backups")
    key_file = Path("/data/backup-fernet.key")
    encrypted = source.with_name(source.name + ".fernet")
    payload = Fernet(key_file.read_bytes()).encrypt(source.read_bytes())
    with encrypted.open("wb") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())

    settings = get_storage_settings()
    if not all(
        (settings.oss_endpoint, settings.oss_bucket,
         settings.oss_access_key_id, settings.oss_access_key_secret)
    ):
        raise RuntimeError("OSS backup target is not configured")
    bucket = oss2.Bucket(
        oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret),
        settings.oss_endpoint,
        settings.oss_bucket,
    )
    object_key = f"mollytime-backups/mysql/{encrypted.name}"
    bucket.put_object_from_file(object_key, str(encrypted))
    if bucket.head_object(object_key).content_length != encrypted.stat().st_size:
        raise RuntimeError("OSS backup size mismatch")
    source.unlink()
    print(f"Encrypted backup uploaded: {object_key}")


if __name__ == "__main__":
    main()
