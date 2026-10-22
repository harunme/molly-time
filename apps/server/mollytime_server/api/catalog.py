"""Catalog browse: /api/home, /api/series/{id}, /api/seasons/{id}, /api/episodes/{id}.

Shape is intentionally minimal — exactly what the MollyTime client renders.
No "fields=" query params, no per-collection-type polymorphism. Series
has seasons; seasons have episodes; episodes have media sources.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..deps import CurrentUser, DbSession
from ..images import image_ref
from ..models import ChildProfile, Item, MediaFile
from ..playback_settings import default_subtitle, preferred_subtitle_index
from ..resource_policy import published_episodes, require_visible, visible
from ..resource_tree import ancestors

router = APIRouter(prefix="/api", tags=["catalog"])


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


class ImageRef(BaseModel):
    url: str
    directUrl: str | None = None


class SeriesSummary(BaseModel):
    id: str
    name: str
    year: int | None = None
    episodeCount: int = 0
    image: ImageRef | None = None
    sortName: str = ""


class EpisodeSummary(BaseModel):
    id: str
    name: str
    indexNumber: int | None = None
    runtimeMs: int | None = None
    image: ImageRef | None = None


class SeasonSummary(BaseModel):
    image: ImageRef | None = None
    id: str
    name: str
    indexNumber: int | None = None
    episodeCount: int = 0


class HomeRow(BaseModel):
    title: str
    items: list[SeriesSummary]


class HomeResponse(BaseModel):
    rows: list[HomeRow]


class SubtitleTrack(BaseModel):
    index: int
    language: str
    label: str
    isDefault: bool
    codec: str


class MediaSource(BaseModel):
    protocol: str = "file"
    container: str = ""
    videoCodec: str = ""
    audioCodec: str = ""
    durationMs: int | None = None
    url: str
    subtitles: list[SubtitleTrack] = []


class EpisodeDetail(BaseModel):
    id: str
    seriesId: str
    seasonId: str | None
    name: str
    indexNumber: int | None = None
    overview: str = ""
    runtimeMs: int | None = None
    image: ImageRef | None = None
    sources: list[MediaSource] = []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _image_url(item_id: str) -> str:
    # Token-protected; clients pass the same Authorization header.
    return f"/api/items/{item_id}/image"


def _subtitle_url(episode_id: str, index: int) -> str:
    return f"/api/episodes/{episode_id}/subtitles/{index}"


def _media_url(episode_id: str) -> str:
    # Native uses Authorization; parent previews use their same-origin cookie.
    return f"/api/episodes/{episode_id}/play"


def _runtime_ms(ticks: int | None) -> int | None:
    if ticks is None:
        return None
    return ticks // 10_000  # 100ns units → ms


def _summarize_files(files: list[MediaFile], preference="zh") -> list[MediaSource]:
    # Pick the first video file. There is exactly one per episode in our scan.
    video = next((f for f in files if f.kind == "video"), None)
    if video is None:
        return []
    subs = sorted(
        (f for f in files if f.kind == "subtitle"),
        key=lambda f: f.index,
    )
    selected = preferred_subtitle_index(subs, preference)
    return [
        MediaSource(
            container="mp4" if video.mime.endswith("mp4") else video.mime.split("/")[-1],
            durationMs=None,  # populated from Item.runtime_ticks at the Episode layer
            url="",  # filled with a stable media-version URL below
            subtitles=[
                SubtitleTrack(
                    index=s.index,
                    language=s.language or "und",
                    label=s.path.rsplit("/", 1)[-1],
                    isDefault=s.index == selected,
                    codec="srt" if s.path.endswith(".srt") else "vtt",
                )
                for s in subs
            ],
        )
    ]


# ---------------------------------------------------------------------------
# /api/home
# ---------------------------------------------------------------------------


@router.get("/home")
def home(
    request: Request, user: CurrentUser, db: DbSession,
    page: int | None = Query(default=None, ge=1, le=2147483647),
    pageSize: int = Query(default=24, ge=1, le=48),
    rowId: str | None = Query(default=None, min_length=1, max_length=64, pattern="^[A-Za-z0-9-]+$"),
):
    """Render the effective published family/child configuration for this client."""
    from .manage_home import RECENT_PLAYBACK_LIMIT, effective_content, render_home

    child = None if getattr(request.state, "device_id", None) else request.headers.get("x-molly-child") or None
    content, revision = effective_content(db, user.family_id, child)
    modern = request.headers.get("x-molly-home-schema") == "2"
    if modern:
        recent_id = "recently-played"
        ids = {row["id"] for row in content["rows"]}
        while recent_id in ids:
            recent_id = "tv-" + recent_id
        content = {**content, "rows": [
            {"id": recent_id, "title": "最近播放", "source": "recently-played", "enabled": True, "limit": RECENT_PLAYBACK_LIMIT},
            *content["rows"],
        ]}
    if page is not None:
        from .catalog_pagination import paged_home
        result = paged_home(content, db, user.family_id, child, page, pageSize, rowId)
    else:
        result = render_home(content, db, user.family_id, child, modern=modern)
    return dict(result, revision=revision)


def _episode_count_for_series(db: Session, series_id: str, family_id: str) -> int:
    """Count episodes in this series by joining Episode → Season via parent_id."""
    return len(published_episodes(db, series_id, family_id))


# ---------------------------------------------------------------------------
# /api/series/{id}
# ---------------------------------------------------------------------------


@router.get("/series/{series_id}")
def series_detail(series_id: str, request: Request, user: CurrentUser, db: DbSession):
    s = _get_item(db, series_id, "Series", user.family_id)
    require_visible(db, s, request)
    seasons = (
        db.query(Item)
        .filter(
            Item.family_id == user.family_id,
            Item.type == "Season",
            Item.parent_id == series_id,
        )
        .order_by(Item.index_number, Item.name)
        .all()
    )
    return {
        "series": {
            "id": s.id,
            "name": s.name,
            "year": s.premiere_year,
            "overview": s.overview,
            "image": image_ref(db, s),
        },
        "seasons": [
            SeasonSummary(
                id=se.id,
                name=se.name,
                indexNumber=se.index_number,
                episodeCount=len(_season_episodes(db, se.id, user.family_id, request)),
                image=ImageRef(**image_ref(db, se)),
            ).model_dump()
            for se in seasons
            if getattr(request.state, "parent_preview", False) or visible(db, se)
        ],
    }


# ---------------------------------------------------------------------------
# /api/seasons/{id}
# ---------------------------------------------------------------------------


@router.get("/seasons/{season_id}")
def season_detail(season_id: str, request: Request, user: CurrentUser, db: DbSession):
    se = _get_item(db, season_id, "Season", user.family_id)
    require_visible(db, se, request)
    episodes = _season_episodes(db, season_id, user.family_id, request)
    return {
        "season": {
            "id": se.id,
            "name": se.name,
            "indexNumber": se.index_number,
            "seriesId": se.parent_id,
        },
        "episodes": [
            EpisodeSummary(
                id=ep.id,
                name=ep.name,
                indexNumber=ep.index_number,
                runtimeMs=_runtime_ms(ep.runtime_ticks),
                image=ImageRef(**image_ref(db, ep)),
            ).model_dump()
            for ep in episodes
            if getattr(request.state, "parent_preview", False) or visible(db, ep)
        ],
    }


# ---------------------------------------------------------------------------
# /api/episodes/{id}
# ---------------------------------------------------------------------------


@router.get("/episodes/{episode_id}", response_model=EpisodeDetail)
def episode_detail(episode_id: str, request: Request, user: CurrentUser, db: DbSession):
    ep = _get_item(db, episode_id, "Episode", user.family_id)
    require_visible(db, ep, request)
    files = db.query(MediaFile).filter(MediaFile.item_id == ep.id).all()
    sources = _summarize_files(files, default_subtitle(db, user.family_id))
    return EpisodeDetail(
        id=ep.id,
        seriesId=_series_id(db, ep),
        seasonId=ep.parent_id,
        name=ep.name,
        indexNumber=ep.index_number,
        overview=ep.overview,
        runtimeMs=_runtime_ms(ep.runtime_ticks),
        image=ImageRef(**image_ref(db, ep)),
        sources=[
            MediaSource(
                container=s.container,
                durationMs=_runtime_ms(ep.runtime_ticks),
                url=_media_url(episode_id)
                + "?mediaId="
                + next(f.id for f in files if f.kind == "video"),
                subtitles=s.subtitles,
            )
            for s in sources
        ],
    )


def _series_id(db: Session, episode: Item) -> str:
    """Resolve the enclosing root collection, including nested groups."""
    return next((row.id for row in ancestors(db, episode) if row.type == "Series"), "")


def _season_episodes(db, season_id, family_id, request):
    query = db.query(Item).filter(
        Item.family_id == family_id, Item.type == "Episode", Item.parent_id == season_id
    )
    preview = getattr(request.state, "parent_preview", False)
    if not preview:
        query = (
            query.join(MediaFile, MediaFile.item_id == Item.id)
            .filter(MediaFile.kind == "video")
            .distinct()
        )
    return [
        ep
        for ep in query.order_by(Item.index_number, Item.name).all()
        if preview or visible(db, ep)
    ]


def _get_item(db: Session, item_id: str, expected_type: str, family_id: str) -> Item:
    item = db.get(Item, item_id)
    if item is None or item.family_id != family_id or item.type != expected_type:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return item


@router.get("/episodes/{episode_id}/next")
def next_episode(episode_id: str, request: Request, user: CurrentUser, db: DbSession):
    episode = _get_item(db, episode_id, "Episode", user.family_id)
    require_visible(db, episode, request)
    from ..watch_control import control, current_round, normalize
    policy = control(db, getattr(request.state, "device_id", None))
    if policy and policy.enabled:
        arrangement = current_round(db, policy)
        normalize(db, arrangement)
        if not arrangement or arrangement.ended:
            return {"episodeId": None}
    folder_id = _series_id(db, episode)
    if not folder_id:
        return {"episodeId": None}
    folder = _get_item(db, folder_id, "Series", user.family_id)
    require_visible(db, folder, request)
    from .catalog_pagination import following_episode_id, ordered_playlist
    query, order = ordered_playlist(db, user.family_id, folder_id)
    return {"episodeId": following_episode_id(query, order, episode_id)}


@router.get("/series/{series_id}/playlist")
def series_playlist(
    series_id: str, request: Request, user: CurrentUser, db: DbSession, childId: str | None = None,
    page: int = Query(default=1, ge=1, le=2147483647),
    pageSize: int = Query(default=24, ge=1, le=48),
):
    series = db.get(Item, series_id)
    if not series or series.family_id != user.family_id or series.type not in ("Series", "Season"):
        raise HTTPException(404)
    require_visible(db, series, request)
    child_id = childId or request.headers.get("X-Molly-Child") or None
    if child_id:
        child = db.get(ChildProfile, child_id)
        if child is None or child.family_id != user.family_id:
            raise HTTPException(404)
    if getattr(request.state, "device_id", None):
        child_id = None
    from .catalog_pagination import paged_playlist
    return paged_playlist(db, user.family_id, user.id, child_id, series, page, pageSize)
