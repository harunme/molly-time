"""Validated, immutable TV release records, shared by the API and publisher."""

import datetime as dt
import fcntl
import hashlib
import json
import logging
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .config import get_settings

PackageName = Literal["com.molly.tv", "com.molly.tv.debug"]
MAX_APK_BYTES = 512 * 1024 * 1024


class ClientRelease(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    packageName: PackageName
    versionCode: int = Field(gt=0, le=2100000000)
    versionName: str = Field(min_length=1, max_length=100)
    minSdk: int = Field(ge=23, le=100)
    size: int = Field(gt=0, le=MAX_APK_BYTES)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    notes: str = Field(default="", max_length=4000)
    storage: Literal["local", "oss"]
    key: str
    publishedAt: str | None = None  # Legacy manifests have no recorded publication time.
    sourceFingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    sourceCommit: str | None = Field(default=None, pattern=r"^[a-f0-9]{40}$")
    signerSha256: list[Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]] = Field(
        default_factory=list, max_length=8
    )

    @field_validator("publishedAt")
    @classmethod
    def publication_time(cls, value):
        if value is not None and dt.datetime.fromisoformat(value).tzinfo is None:
            raise ValueError("Publication time must include a timezone")
        return value

    @model_validator(mode="after")
    def immutable_key(self):
        expected = f"releases/tv/{self.packageName}/{self.versionCode}/{self.sha256}.apk"
        if self.key != expected:
            raise ValueError("Release object key must match package, version and hash")
        return self


def release_dir() -> Path:
    return get_settings().data_dir / "client-releases"


@contextmanager
def publication_lock():
    directory = release_dir()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def manifest_path(package: PackageName) -> Path:
    return release_dir() / f"{package}.json"


def read_release(package: PackageName) -> ClientRelease | None:
    path = manifest_path(package)
    if not path.is_file():
        return None
    release = ClientRelease.model_validate(json.loads(path.read_text()))
    if release.packageName != package:
        raise ValueError("Release package does not match channel")
    return release


def local_apk(release: ClientRelease) -> Path:
    return release_dir() / release.key


def download_apk(release: ClientRelease) -> Path:
    """Serve private OSS APKs through authenticated SDK reads, not forbidden URL signing."""
    destination = local_apk(release)
    if release.storage == "local":
        return destination
    from .storage import build_storage

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.with_suffix(".download.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if destination.is_file() and destination.stat().st_size == release.size:
            with destination.open("rb") as handle:
                if hashlib.file_digest(handle, "sha256").hexdigest() == release.sha256:
                    return destination
        with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
            snapshot = Path(temporary) / "release.apk"
            build_storage("oss").download(release.key, snapshot, release.size)
            if snapshot.stat().st_size != release.size:
                raise ValueError("Cloud APK size mismatch")
            with snapshot.open("rb") as handle:
                if hashlib.file_digest(handle, "sha256").hexdigest() != release.sha256:
                    raise ValueError("Cloud APK checksum mismatch")
            os.replace(snapshot, destination)
        return destination


def history_path(release: ClientRelease) -> Path:
    return (
        release_dir()
        / "history"
        / release.packageName
        / str(release.versionCode)
        / f"{release.sha256}.json"
    )


def archive_release(release: ClientRelease) -> None:
    path = history_path(release)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(release.model_dump_json(indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def release_identity(release: ClientRelease) -> tuple[str, int, str]:
    return release.packageName, release.versionCode, release.sha256


def inventory() -> tuple[list[ClientRelease], set[tuple[str, int, str]], int]:
    """Merge the archive with legacy current manifests, without scanning unrelated APKs."""
    records = {}
    current = set()
    invalid = 0
    for path in sorted((release_dir() / "history").glob("*/*/*.json")):
        try:
            release = ClientRelease.model_validate(json.loads(path.read_text()))
            if path != history_path(release):
                raise ValueError("Archive record path does not match its identity")
            records[release_identity(release)] = release
        except (ValueError, OSError):
            invalid += 1
            logging.getLogger(__name__).warning("Invalid client release history record: %s", path)
    for package in ("com.molly.tv", "com.molly.tv.debug"):
        try:
            release = read_release(package)
            if release:
                identity = release_identity(release)
                records[identity] = release
                current.add(identity)
        except (ValueError, OSError):
            invalid += 1
            logging.getLogger(__name__).warning("Invalid current client release: %s", package)
    ordered = sorted(records.values(), key=lambda item: (item.packageName, -item.versionCode))
    return ordered, current, invalid


def find_release(package: PackageName, version: int, digest: str) -> ClientRelease | None:
    # Construct paths only from a validated package/version/digest candidate set.
    if version <= 0 or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        return None
    release = read_release(package)
    if release and release_identity(release) == (package, version, digest):
        return release
    path = release_dir() / "history" / package / str(version) / f"{digest}.json"
    if not path.is_file():
        return None
    release = ClientRelease.model_validate(json.loads(path.read_text()))
    if release_identity(release) != (package, version, digest):
        raise ValueError("Archive record does not match requested release")
    return release
