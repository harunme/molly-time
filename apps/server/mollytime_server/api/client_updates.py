"""Public release discovery also works before a TV has paired."""

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..client_releases import PackageName, download_apk, local_apk, read_release

router = APIRouter(prefix="/api/client/releases", tags=["client updates"])


def latest(package):
    try:
        release = read_release(package)
        if release and release.storage == "local":
            file = local_apk(release)
            if not file.is_file() or file.stat().st_size != release.size:
                raise ValueError("Published APK missing or changed")
        return release
    except (ValueError, OSError):
        logging.getLogger(__name__).exception("Invalid client release")
        raise HTTPException(503, "Client release is unavailable")


@router.get("/latest")
def discover(packageName: PackageName = "com.molly.tv"):
    release = latest(packageName)
    if release is None:
        return {"release": None}
    body = release.model_dump(exclude={"storage", "key"})
    body["url"] = (
        f"/api/client/releases/{release.packageName}/{release.versionCode}/{release.sha256}.apk"
    )
    return {"release": body}


@router.get("/{package}/{version}/{digest}.apk")
def download(package: PackageName, version: int, digest: str):
    release = latest(package)
    if (
        release is None
        or release.versionCode != version
        or release.sha256 != digest
    ):
        raise HTTPException(404)
    try:
        path = download_apk(release)
    except Exception:
        logging.getLogger(__name__).exception("Cannot fetch client APK")
        raise HTTPException(503, "Client release download is unavailable")
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename=f"mollytime-tv-{release.versionName}.apk",
    )
