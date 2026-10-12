"""Record only BBKT catalogue reads and media requested by the selected app.

Run with mitmdump's local:<PID> mode. This addon does not replay requests,
alter responses, disable TLS verification, or save authentication endpoints.
Private request material stays under .private with owner-only permissions.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
from urllib.parse import urlsplit

from mitmproxy import ctx, http

ROOT = Path(__file__).resolve().parent
PRIVATE = ROOT / ".private"
READ_PATHS = {
    "/app-api/player/video-category/page",
    "/app-api/player/video-info/page",
    "/app-api/player/video-diversity/page",
    "/app-api/player/video-diversity/get2",
    "/app-api/player/video-diversity/get-first2",
    "/app-api/player/recommend-info/page",
    "/app-api/player/user-category/get",
}
MEDIA_EXTENSIONS = {".mp4", ".m3u8", ".mpd", ".srt", ".vtt", ".mp3", ".m4a", ".jpg", ".jpeg", ".png", ".webp"}


def app_host(host: str) -> bool:
    host = host.lower().rstrip(".")
    return host in {"bbketang.com", "www.bbketang.com"} or any(
        host.endswith("." + suffix)
        for suffix in ("aliyuncs.com", "vod-qcloud.com", "myqcloud.com")
    )


def public_url(url: str) -> str:
    u = urlsplit(url)
    return f"{u.scheme}://{u.netloc}{u.path}"


class Collector:
    def __init__(self) -> None:
        PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(PRIVATE, 0o700)
        self.db = sqlite3.connect(PRIVATE / "capture.sqlite")
        os.chmod(PRIVATE / "capture.sqlite", 0o600)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS catalog_reads (
              id TEXT PRIMARY KEY, seen REAL, path TEXT, status INTEGER,
              request_body BLOB, request_headers TEXT, response_body BLOB,
              response_headers TEXT);
            CREATE TABLE IF NOT EXISTS resources (
              url TEXT PRIMARY KEY, seen REAL, kind TEXT, status INTEGER,
              request_headers TEXT, response_headers TEXT, source TEXT);
        """)
        self.db.commit()

    def emit(self, event: dict) -> None:
        event["time"] = time.time()
        with (ROOT / "capture-events.jsonl").open("a", encoding="utf8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")

    def classify(self, url: str, content_type: str = "") -> str | None:
        u = urlsplit(url)
        if not app_host(u.hostname or ""):
            return None
        ext = Path(u.path.lower()).suffix
        if ext in MEDIA_EXTENSIONS:
            return ext[1:]
        if content_type.startswith(("image/", "video/", "audio/")):
            return content_type.split(";", 1)[0]
        return None

    def remember(self, url: str, kind: str, status: int | None,
                 request_headers: dict, response_headers: dict, source: str) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO resources VALUES (?,?,?,?,?,?,?)",
            (url, time.time(), kind, status, json.dumps(request_headers),
             json.dumps(response_headers), source),
        )
        self.db.commit()
        self.emit({"event": "resource", "url": public_url(url), "kind": kind,
                   "status": status, "source": source})

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        if not flow.response:
            return
        kind = self.classify(flow.request.pretty_url, flow.response.headers.get("content-type", ""))
        if kind:
            self.remember(flow.request.pretty_url, kind, flow.response.status_code,
                          dict(flow.request.headers), dict(flow.response.headers), "app request")
            # Do not buffer video bodies; the app continues receiving them normally.
            if kind in {"mp4", "mp3", "m4a"} or kind.startswith(("video/", "audio/")):
                flow.response.stream = True

    def request(self, flow: http.HTTPFlow) -> None:
        if urlsplit(flow.request.pretty_url).hostname in {"bbketang.com", "www.bbketang.com"}:
            self.emit({"event": "api_request", "path": urlsplit(flow.request.pretty_url).path})

    def response(self, flow: http.HTTPFlow) -> None:
        if not flow.response or urlsplit(flow.request.pretty_url).hostname not in {"bbketang.com", "www.bbketang.com"}:
            return
        path = urlsplit(flow.request.pretty_url).path
        if path not in READ_PATHS:
            return
        body = flow.response.content or b""
        if len(body) > 8 * 1024 * 1024:
            self.emit({"event": "catalog_body_too_large", "path": path})
            return
        req = flow.request.content or b""
        key = hashlib.sha256(path.encode() + req + body).hexdigest()
        self.db.execute("INSERT OR IGNORE INTO catalog_reads VALUES (?,?,?,?,?,?,?,?)",
                        (key, time.time(), path, flow.response.status_code, req,
                         json.dumps(dict(flow.request.headers)), body,
                         json.dumps(dict(flow.response.headers))))
        self.db.commit()
        keys = []
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                keys = list(parsed)
            self.walk_urls(parsed, path)
        except (ValueError, UnicodeDecodeError):
            parsed = None
        self.emit({"event": "catalog_read", "path": path,
                   "status": flow.response.status_code, "bytes": len(body),
                   "json_keys": keys, "request_bytes": len(req)})

    def walk_urls(self, value: object, source: str) -> None:
        if isinstance(value, dict):
            for v in value.values():
                self.walk_urls(v, source)
        elif isinstance(value, list):
            for v in value:
                self.walk_urls(v, source)
        elif isinstance(value, str) and value.startswith(("https://", "http://")):
            kind = self.classify(value)
            if kind:
                self.remember(value, kind, None, {}, {}, source)

    def error(self, flow: http.HTTPFlow) -> None:
        if app_host(urlsplit(flow.request.pretty_url).hostname or ""):
            self.emit({"event": "request_error", "url": public_url(flow.request.pretty_url),
                       "message": str(flow.error)})


addons = [Collector()]
