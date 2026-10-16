"""Superadmin-only inventory and downloads of published TV APKs."""

import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from ..client_releases import (
    PackageName,
    download_apk,
    find_release,
    inventory,
    local_apk,
    release_identity,
)
from ..deps import DbSession
from ..transactions import external_io
from .operations import Operator

router = APIRouter(prefix="/api/manage/operations/client-releases", tags=["operations"])


def available(release):
    if release.storage == "oss":
        return True  # Remote availability is checked when requesting a download URL.
    path = local_apk(release)
    try:
        return path.is_file() and path.stat().st_size == release.size
    except OSError:
        return False


@router.get("")
def list_releases(
    user: Operator,
    db: DbSession,
    packageName: PackageName | None = None,
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=20, ge=1, le=100),
):
    with external_io(db):
        pass
    records, current, invalid = inventory()
    filtered = [
        record for record in records if packageName is None or record.packageName == packageName
    ]
    start = (page - 1) * pageSize
    return {
        "items": [
            {
                **record.model_dump(),
                "isCurrent": release_identity(record) in current,
                "canDownload": available(record),
            }
            for record in filtered[start : start + pageSize]
        ],
        "total": len(filtered),
        "page": page,
        "pageSize": pageSize,
        "invalidRecords": invalid,
    }


def require_release(package, version, digest):
    try:
        release = find_release(package, version, digest)
        if release is None:
            raise HTTPException(404, "安装包记录不存在")
        if not available(release):
            raise HTTPException(404, "安装包文件缺失，请重新发布或恢复备份")
        return release
    except (ValueError, OSError):
        logging.getLogger(__name__).exception("Cannot read client release record")
        raise HTTPException(503, "安装包记录不可用")


@router.get("/{package}/{version}/{digest}/download-url")
def download_url(package: PackageName, version: int, digest: str, user: Operator, db: DbSession):
    with external_io(db):
        pass
    require_release(package, version, digest)
    return {"url": f"/api/manage/operations/client-releases/{package}/{version}/{digest}/file"}


@router.get("/{package}/{version}/{digest}/file")
def download_file(package: PackageName, version: int, digest: str, user: Operator, db: DbSession):
    with external_io(db):
        pass
    release = require_release(package, version, digest)
    try:
        path = download_apk(release)
    except Exception:
        logging.getLogger(__name__).exception("Cannot fetch client APK")
        raise HTTPException(503, "安装包下载不可用，请检查 OSS 文件和存储配置")
    channel = "-debug" if package.endswith(".debug") else ""
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename=f"mollytime-tv{channel}-{release.versionName}.apk",
    )
