"""Serve independently deployable TV assets; HTML never uses stale cache."""

import re
from urllib.parse import urlsplit

from fastapi.staticfiles import StaticFiles

from .storage.settings import get_storage_settings


def storage_connect_source():
    settings = get_storage_settings()
    try:
        endpoint = urlsplit(settings.oss_endpoint or "")
    except ValueError:
        return ""
    host = endpoint.hostname or ""
    bucket = settings.oss_bucket or ""
    if (
        endpoint.scheme != "https"
        or not re.fullmatch(r"oss-[a-z0-9-]+\.aliyuncs\.com", host)
        or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket)
    ):
        return ""
    return f" https://{bucket}.{host}"


class TvWebFiles(StaticFiles):
    async def get_response(self, path, scope):
        # No SPA catch-all is needed: navigation is inside the application.
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-store"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        connect_source = storage_connect_source()
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            f"img-src 'self' blob:; connect-src 'self'{connect_source} https: http:; media-src 'self' blob: https: http:; frame-src 'none'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        return response
