"""Database overrides shared by API processes and workers; secrets never leave the server."""

import os
import tempfile
from types import SimpleNamespace

from cryptography.fernet import Fernet

from ..config import get_settings
from ..db import get_session_factory
from ..management_models import OperationsStorage

FIELDS = (
    "storage_backend",
    "oss_endpoint",
    "oss_bucket",
    "oss_access_key_id",
    "oss_access_key_secret",
    "oss_internal_endpoint",
    "oss_upload_ttl",
    "oss_signed_url_ttl",
)
SECRETS = ("oss_access_key_id", "oss_access_key_secret")


def cipher(create=False):
    path = get_settings().data_dir / "operations-storage.key"
    if create and not path.exists():
        # Publish a complete key atomically, even when multiple API processes save at once.
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = handle.name
            handle.write(Fernet.generate_key())
            handle.flush()
            os.fsync(handle.fileno())
        try:
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temporary)
    return Fernet(path.read_bytes())


def decode(config):
    result = dict(config)
    for field in SECRETS:
        if result.get(field):
            result[field] = cipher().decrypt(result[field].encode()).decode()
    return result


def encode(config):
    result = dict(config)
    for field in SECRETS:
        if result.get(field):
            result[field] = cipher(create=True).encrypt(result[field].encode()).decode()
    return result


def get_storage_settings():
    base = get_settings()
    values = {field: getattr(base, field) for field in FIELDS}
    with get_session_factory()() as db:
        row = db.get(OperationsStorage, "storage")
        revision = row.revision if row else 0
        if row:
            values.update(decode(row.config))
    return SimpleNamespace(**values, revision=revision)
