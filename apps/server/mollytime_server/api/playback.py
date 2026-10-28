"""Playback endpoints: stream video, fetch subtitles/images, report progress."""

from __future__ import annotations

import datetime as dt
import hashlib
import re

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import CurrentUser, DbSession
from ..images import image_files
from ..management_models import MediaOptions, WatchProgress, WatchSession
from ..models import ChildProfile, Item, MediaFile, PlaybackEvent
from ..resource_policy import require_visible
from ..storage import build_storage
from ..storage.local import LocalStorage
from ..storage.settings import get_storage_settings
from ..transactions import external_io
from ..usage_meter import meter_media
from ..utils.image import preview_to_file, resize_to_file
from ..utils.subtitles import webvtt
from .watch_progress import scoped_progress

router = APIRouter(prefix="/api", tags=["playback"])


# ---------------------------------------------------------------------------
# /api/episodes/{id}/play — Range-streamed video bytes
# ---------------------------------------------------------------------------


def _pick_video_file(
    db: Session, episode_id: str, family_id: str, media_id: str | None = None
) -> MediaFile:
    _episode(db, episode_id, family_id)
    query = db.query(MediaFile).filter(MediaFile.item_id == episode_id)
    query = (
        query.filter(MediaFile.id == media_id, MediaFile.kind.in_(["video", "retired_video"]))
        if media_id
        else query.filter(MediaFile.kind == "video")
    )
    f = query.first()
    if f is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no video")
    return f


def _episode(db: Session, episode_id: str, family_id: str) -> Item:
    ep = db.get(Item, episode_id)
    if ep is None or ep.family_id != family_id or ep.type != "Episode":
        raise HTTPException(status_code=404)
    return ep


def _child(db: Session, child_id: str | None, family_id: str) -> None:
    if child_id is not None:
        child = db.get(ChildProfile, child_id)
        if child is None or child.family_id != family_id:
            raise HTTPException(status_code=404)


def parse_range(header: str, total: int) -> tuple[int, int]:
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
    if not match or total <= 0 or not any(match.groups()):
        raise ValueError("invalid range")
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise ValueError("invalid suffix")
        return max(0, total - suffix), total - 1
    start = int(first)
    end = min(int(last), total - 1) if last else total - 1
    if start >= total or start > end:
        raise ValueError("unsatisfiable range")
    return start, end


def authorized_file(db, episode_id, request, user, mediaId=None, sessionId=None):
    episode = _episode(db, episode_id, user.family_id)
    device_id = getattr(request.state, "device_id", None)
    from ..watch_control import require_play
    require_play(db, device_id, episode_id)
    watch = db.get(WatchSession, sessionId) if sessionId else None
    valid_session = (
        watch
        and watch.user_id == user.id
        and watch.family_id == user.family_id
        and watch.item_id == episode_id
        and not watch.ended
        and watch.device_id == getattr(request.state, "device_id", None)
    )
    if not valid_session:
        require_visible(db, episode, request)
    file = _pick_video_file(db, episode_id, user.family_id, mediaId)
    return file


@router.get("/episodes/{episode_id}/playback")
def resolve_playback(
    episode_id: str,
    request: Request,
    user: CurrentUser,
    db: DbSession,
    mediaId: str | None = None,
    sessionId: str | None = None,
):
    file = authorized_file(db, episode_id, request, user, mediaId, sessionId)
    return playback_info(db, file, sessionId)


def playback_info(db, file, session_id=None):
    from urllib.parse import urlencode

    from ..playback_settings import default_subtitle, preferred_subtitle_index

    subs = (
        db.query(MediaFile)
        .filter(MediaFile.item_id == file.item_id, MediaFile.kind == "subtitle")
        .order_by(MediaFile.index)
        .all()
    )
    tracks = []
    preference = default_subtitle(db, file.family_id)
    selected = preferred_subtitle_index(subs, preference)
    media_options = {row.media_id: row for row in db.query(MediaOptions).filter(
        MediaOptions.media_id.in_([sub.id for sub in subs]),
    ).all()}
    for sub in subs:
        options = media_options.get(sub.id)
        tracks.append(
            {
                "index": sub.index,
                "language": sub.language or "und",
                "label": options.label
                if options and options.label
                else sub.path.rsplit("/", 1)[-1],
                "isDefault": sub.index == selected,
                "codec": "vtt",
                "offsetMs": options.offset_ms if options else 0,
                "url": f"/api/episodes/{file.item_id}/subtitles/{sub.index}?format=vtt&v={sub.sha256 or sub.id}",
            }
        )
    with external_io(db):
        storage = build_storage(file.storage)
        ttl = get_storage_settings().oss_signed_url_ttl
        query = {"mediaId": file.id}
        if session_id:
            query["sessionId"] = session_id
        if file.storage == "local":
            url = f"/api/episodes/{file.item_id}/play?{urlencode(query)}"
            expires = None
        else:
            url = storage.signed_url(file.path, ttl)
            expires = (dt.datetime.now(dt.UTC) + dt.timedelta(seconds=ttl)).isoformat()
        return {
            "mediaId": file.id,
            "version": file.sha256 or file.id,
            "size": file.size_bytes or storage.size(file.path),
            "sha256": file.sha256,
            "mime": file.mime or "video/mp4",
            "storage": file.storage,
            "url": url,
            "expiresAt": expires,
            "subtitles": tracks,
            "defaultSubtitle": preference,
            "headers": {},
            "retention": "backup",
        }


@router.api_route(
    "/episodes/{episode_id}/play",
    methods=["GET", "HEAD"],
)
def play(
    episode_id: str,
    request: Request,
    user: CurrentUser,
    db: DbSession,
    mediaId: str | None = None,
    sessionId: str | None = None,
):
    """Legacy playback entry: local Range delivery or authorized OSS redirect."""
    file = authorized_file(db, episode_id, request, user, mediaId, sessionId)
    return stream_file(file, request, user.family_id, db=db)


def stream_file(file, request, family_id=None, *, db=None):
    """Shared authenticated delivery for catalog videos and private parent clips."""
    if db is not None:
        with external_io(db):
            return stream_file(file, request, family_id)
    storage = build_storage(file.storage)
    if not isinstance(storage, LocalStorage):
        return RedirectResponse(
            storage.signed_url(file.path, get_storage_settings().oss_signed_url_ttl),
            status_code=302,
            headers={"Cache-Control": "no-store"},
        )
    obj = storage.resolve(file.path)
    total = obj.size_bytes
    if not storage._abspath(file.path).is_file():
        raise HTTPException(status_code=404)
    start, end, code = 0, total - 1, 200
    range_header = request.headers.get("range") if request.method == "GET" else None
    if range_header:
        try:
            start, end = parse_range(range_header, total)
        except ValueError:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
        code = 206
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
        "Content-Type": obj.mime or "video/mp4",
    }
    if code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    if request.method == "HEAD":
        return Response(status_code=200, headers=headers)
    meter_media(request, family_id or file.family_id)
    return StreamingResponse(
        storage.iter_range(file.path, start, end), status_code=code, headers=headers
    )


# ---------------------------------------------------------------------------
# /api/episodes/{id}/progress
# ---------------------------------------------------------------------------


class ProgressBody(BaseModel):
    positionMs: int = Field(ge=0)
    durationMs: int = Field(default=0, ge=0)
    event: str = Field(default="progress", pattern="^(start|progress|stop)$")
    completed: bool = False
    childId: str | None = None


class ProgressResponse(BaseModel):
    ok: bool


@router.get("/episodes/{episode_id}/progress")
def read_progress(
    episode_id: str, request: Request, user: CurrentUser, db: DbSession, childId: str | None = None
):
    require_visible(db, _episode(db, episode_id, user.family_id), request)
    _child(db, childId, user.family_id)
    if getattr(request.state, "device_id", None):
        childId = None
    if childId is None and not getattr(request.state, "parent_preview", False):
        progress = scoped_progress(db, user.family_id).filter(
            WatchProgress.item_id == episode_id,
        ).order_by(WatchProgress.session_started_at.desc(), WatchProgress.session_id.desc()).first()
    else:
        progress = db.get(WatchProgress, f"{user.family_id}:{childId or user.id}:{episode_id}")
    if progress:
        return {"positionMs": progress.position_ms, "completed": progress.completed}
    query = db.query(PlaybackEvent).filter(
        PlaybackEvent.family_id == user.family_id,
        PlaybackEvent.item_id == episode_id,
        PlaybackEvent.child_id == childId,
    )
    # Child progress belongs to the child; no-child preview belongs to the parent account.
    if childId is None:
        query = query.filter(PlaybackEvent.user_id == user.id)
    latest = query.order_by(PlaybackEvent.id.desc()).first()
    return {
        "positionMs": latest.position_ms if latest else 0,
        "completed": latest.completed if latest else False,
    }


@router.post("/episodes/{episode_id}/progress", response_model=ProgressResponse)
def report_progress(
    episode_id: str,
    body: ProgressBody,
    user: CurrentUser,
    db: DbSession,
    request: Request,
):
    require_visible(db, _episode(db, episode_id, user.family_id), request)
    _child(db, body.childId, user.family_id)
    db.add(
        PlaybackEvent(
            family_id=user.family_id,
            user_id=user.id,
            child_id=body.childId,
            item_id=episode_id,
            position_ms=body.positionMs,
            duration_ms=body.durationMs,
            event=body.event,
            completed=body.completed,
            reported_at=dt.datetime.now(dt.UTC),
        )
    )
    db.commit()
    return ProgressResponse(ok=True)


# ---------------------------------------------------------------------------
# /api/episodes/{id}/subtitles/{index}
# ---------------------------------------------------------------------------


@router.get("/episodes/{episode_id}/subtitles/{index}")
def subtitle(
    episode_id: str,
    index: int,
    user: CurrentUser,
    db: DbSession,
    request: Request,
    format: str | None = None,
):
    require_visible(db, _episode(db, episode_id, user.family_id), request)
    f = (
        db.query(MediaFile)
        .filter(
            MediaFile.item_id == episode_id,
            MediaFile.kind == "subtitle",
            MediaFile.index == index,
        )
        .first()
    )
    if f is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    meter_media(request, user.family_id)
    options = db.get(MediaOptions, f.id)
    with external_io(db):
        storage = build_storage(f.storage)
        if format == "vtt":
            cache = get_settings().data_dir / "subtitle-cache"
            cache.mkdir(parents=True, exist_ok=True)
            offset = options.offset_ms if options else 0
            path = cache / f"{f.id}-{f.sha256 or f.id}-{offset}.vtt"
            if not path.exists():
                data = webvtt(storage.open(f.path), offset)
                from ..utils.image import atomic_write

                atomic_write(path, data)
            return Response(
                path.read_bytes(), media_type="text/vtt", headers={"Cache-Control": "private, no-cache"}
            )
        blob = storage.open(f.path)
        return Response(
            content=blob,
            media_type=f.mime or "application/x-subrip",
            headers={"Content-Length": str(len(blob))},
        )


# ---------------------------------------------------------------------------
# /api/items/{image|url}?w=&h=  — server-side image resize + cache
# ---------------------------------------------------------------------------


@router.api_route(
    "/items/{item_id}/image",
    methods=["GET", "HEAD"],
)
def image(
    item_id: str,
    user: CurrentUser,
    db: DbSession,
    request: Request,
    w: int | None = Query(default=None, alias="w"),
    h: int | None = Query(default=None, alias="h"),
    preview: bool = False,
):
    """Walks parent chain to find the first image MediaFile. Falls back
    to season → series cover when the item itself has none."""
    cur = db.get(Item, item_id)
    if cur is None or cur.family_id != user.family_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    require_visible(db, cur, request)

    cover, motion = image_files(db, cur)
    file = motion if preview else cover
    if file is None:
        if preview:
            return Response(status_code=204, headers={"Cache-Control": "private, no-cache"})
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    with external_io(db):
        storage = build_storage(file.storage)
        target_w = min(1280, max(64, w)) if w else 800
        if h is not None and h <= 0:
            h = None

        settings = get_settings()
        cache_dir = settings.data_dir / "image-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        variant = "motion-full-v1.webp" if preview else "first-v1.jpg"
        cache_path = cache_dir / f"{file.id}_{file.sha256 or 'original'}_{target_w}_{variant}"
        if not cache_path.exists():
            if preview:
                try:
                    preview_to_file(storage.open(file.path), cache_path, target_w)
                except ValueError as error:
                    raise HTTPException(422, "封面动画过大，请使用较短的封面动画") from error
            else:
                resize_to_file(storage.open(file.path), cache_path, target_w)
        data = cache_path.read_bytes()
        meter_media(request, user.family_id)
        # PNG/WebP containers can be still images. Keep their poster unchanged
        # and let the UI remember that this cover has no animation to fetch again.
        if preview and not data:
            return Response(status_code=204, headers={"Cache-Control": "private, no-cache"})
        tag = hashlib.sha256(f"{file.id}:{file.sha256}:{file.path}:first-v1".encode()).hexdigest()
        return Response(content=data, media_type="image/webp" if preview else "image/jpeg", headers={
            "Cache-Control": "private, no-cache", "X-Molly-Image-Version": tag,
        })
