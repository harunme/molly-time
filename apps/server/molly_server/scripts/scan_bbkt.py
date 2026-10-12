"""One-shot scanner: imports `downloads/bbkt` into Items/MediaFiles.

Scoped to the default Family so catalog.py can filter by `family_id`.
Idempotent: existing items are reused by (family_id, parent_id, name, type).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from sqlalchemy import select

from ..config import get_settings
from ..db import session_scope
from ..models import Family, Item, MediaFile, View
from ..management_models import ResourceState
from ..utils.ffprobe import duration_ticks

_VIDEO_NAMES = {"视频.mp4", "video.mp4"}
_SUBTITLE_EXT = {".srt", ".vtt", ".ass"}
_IMAGE_NAMES = {"封面.jpg", "cover.jpg", "poster.jpg"}
_BRACKET_ID = re.compile(r"\[(\d+)\]")
_SEASON_NUM_RE = re.compile(r"^第\s*(\d+)\s*[季部]")
_EP_NUM_RE = re.compile(r"^第\s*(\d+)\s*集")
_EP_FOLDEr_RE = re.compile(r"^第?\s*\d+\s*[集Ee]")
_EP_TOKEN_RE = re.compile(r"\bEP?\d+\b")
_DEFAULT_VIEW_NAME = "宝宝课堂"
_KIND_VIDEO = "video"
_KIND_SUBTITLE = "subtitle"
_KIND_IMAGE = "image"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _name_and_id(folder: Path) -> tuple[str, str | None]:
    name = folder.name
    m = _BRACKET_ID.search(name)
    bbkt_id = m.group(1) if m else None
    name = _BRACKET_ID.sub("", name).strip().rstrip("-").strip()
    return name, bbkt_id


def _lang_from_srt(path: Path) -> str:
    n = path.stem
    if "中英" in n or "双语" in n:
        return "zh-CN+en"
    if "中文" in n or "简体" in n:
        return "zh-CN"
    if "英文" in n:
        return "en"
    return "und"


def _ensure_view(db, family_id: str, name: str) -> View:
    v = db.scalars(
        select(View).where(View.family_id == family_id, View.name == name)
    ).first()
    if v is not None:
        return v
    v = View(family_id=family_id, name=name, collection_type="tvshows", sort_index=99)
    db.add(v)
    db.flush()
    return v


def _ensure_item(
    db,
    *,
    name: str,
    type_: str,
    family_id: str,
    view_id: str | None = None,
    parent_id: str | None = None,
) -> Item:
    it = db.scalars(
        select(Item).where(
            Item.family_id == family_id,
            Item.view_id == view_id,
            Item.parent_id == parent_id,
            Item.name == name,
            Item.type == type_,
        )
    ).first()
    if it is not None:
        return it
    it = Item(
        name=name,
        type=type_,
        family_id=family_id,
        view_id=view_id,
        parent_id=parent_id,
        sort_name=name,
    )
    db.add(it)
    db.flush()
    if type_ == "Episode":
        db.add(ResourceState(item_id=it.id, status="draft", ready=False))
        db.flush()
    return it


def _prune(db, item: Item, kind: str) -> None:
    rows = db.scalars(
        select(MediaFile).where(MediaFile.item_id == item.id, MediaFile.kind == kind)
    ).all()
    for r in rows:
        if kind == "video":
            r.kind = "retired_video"
        else:
            db.delete(r)


def _guess_mime(path: Path) -> str:
    return {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".srt": "application/x-subrip",
        ".vtt": "text/vtt",
        ".ass": "text/x-ssa",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
    }.get(path.suffix.lower(), "application/octet-stream")


def _store_media(
    db, item: Item, family_id: str, path: Path, kind: str, **kw
) -> MediaFile:
    bbkt_root = get_settings().resolved_bbkt_root().resolve()
    try:
        rel = path.resolve().relative_to(bbkt_root)
    except ValueError:
        rel = path
    f = MediaFile(
        item_id=item.id,
        family_id=family_id,
        kind=kind,
        storage="local",
        path=str(rel),
        mime=_guess_mime(path),
        size_bytes=path.stat().st_size if path.exists() else 0,
        **kw,
    )
    db.add(f)
    return f


def _set_runtime(db, item: Item, video_path: Path) -> None:
    if item.runtime_ticks:
        return
    ticks = duration_ticks(video_path)
    if ticks:
        item.runtime_ticks = ticks


# ---------------------------------------------------------------------------
# Per-episode / per-season
# ---------------------------------------------------------------------------


def _find_first(path: Path, names: set[str]) -> Path | None:
    for f in path.iterdir():
        if f.is_file() and f.name in names:
            return f
    subdirs = [p for p in path.iterdir() if p.is_dir()]
    if len(subdirs) == 1:
        nested = subdirs[0]
        for f in nested.iterdir():
            if f.is_file() and f.name in names:
                return f
    return None


def _scan_episode(
    db, ep_path: Path, series: Item, season: Item, family_id: str
) -> Item | None:
    if not ep_path.is_dir():
        return None
    ep_name, _ = _name_and_id(ep_path)
    if not ep_name:
        return None
    ep = _ensure_item(
        db,
        name=ep_name,
        type_="Episode",
        family_id=family_id,
        view_id=None,
        parent_id=season.id,
    )
    ep.sort_name = ep_name

    m = _EP_NUM_RE.match(ep.name)
    if m:
        ep.index_number = int(m.group(1))

    video = _find_first(ep_path, _VIDEO_NAMES)
    cover_in_episode = _find_first(ep_path, _IMAGE_NAMES)
    if video is None and cover_in_episode is None:
        return None

    if video is not None:
        media_root = video.parent
        _prune(db, ep, _KIND_VIDEO)
        _store_media(db, ep, family_id, video, _KIND_VIDEO)
        _set_runtime(db, ep, video)

        subs = sorted(
            f for f in media_root.iterdir()
            if f.is_file() and f.suffix.lower() in _SUBTITLE_EXT
        )
        _prune(db, ep, _KIND_SUBTITLE)
        for i, sub in enumerate(subs):
            _store_media(
                db, ep, family_id, sub, _KIND_SUBTITLE,
                index=i,
                language=_lang_from_srt(sub),
                is_default=(i == 0),
            )
    elif cover_in_episode is not None:
        media_root = cover_in_episode.parent

    if cover_in_episode is not None:
        _prune(db, ep, _KIND_IMAGE)
        _store_media(db, ep, family_id, cover_in_episode, _KIND_IMAGE)
    elif video is not None:
        cover_in_season_root = _find_first(media_root, _IMAGE_NAMES)
        if cover_in_season_root is not None:
            _prune(db, ep, _KIND_IMAGE)
            _store_media(db, ep, family_id, cover_in_season_root, _KIND_IMAGE)

    state = db.get(ResourceState, ep.id)
    if state:
        state.ready = video is not None
    return ep


def _scan_season(
    db, season_path: Path, series: Item, family_id: str
) -> Item:
    season_name, _ = _name_and_id(season_path)
    season = _ensure_item(
        db,
        name=season_name,
        type_="Season",
        family_id=family_id,
        view_id=None,
        parent_id=series.id,
    )
    season.sort_name = season_name
    m = _SEASON_NUM_RE.match(season_name)
    if m:
        season.parent_index_number = int(m.group(1))

    cover = _find_first(season_path, _IMAGE_NAMES)
    if cover is not None:
        _prune(db, season, _KIND_IMAGE)
        _store_media(db, season, family_id, cover, _KIND_IMAGE)

    for ep_path in sorted(
        (p for p in season_path.iterdir() if p.is_dir()), key=lambda p: p.name
    ):
        _scan_episode(db, ep_path, series, season, family_id)
    return season


def _scan_series(db, view: View, series_path: Path) -> None:
    family_id = view.family_id
    series_name, _ = _name_and_id(series_path)
    if not series_name:
        return
    series = _ensure_item(
        db, name=series_name, type_="Series", family_id=family_id,
        view_id=view.id, parent_id=None,
    )
    series.sort_name = series_name

    cover = _find_first(series_path, _IMAGE_NAMES)
    if cover is not None:
        _prune(db, series, _KIND_IMAGE)
        _store_media(db, series, family_id, cover, _KIND_IMAGE)

    subdirs = [p for p in series_path.iterdir() if p.is_dir()]
    if not subdirs:
        return

    looks_flat = any(_EP_FOLDEr_RE.match(sub.name) or _EP_TOKEN_RE.search(sub.name) for sub in subdirs)
    if looks_flat:
        season = _ensure_item(
            db, name="第 1 季", type_="Season", family_id=family_id,
            view_id=None, parent_id=series.id,
        )
        season.sort_name = "S01"
        season.parent_index_number = 1
        for ep_path in sorted(subdirs, key=lambda p: p.name):
            _scan_episode(db, ep_path, series, season, family_id)
    else:
        for season_path in sorted(subdirs, key=lambda p: p.name):
            _scan_season(db, season_path, series, family_id)


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------


def _family_for_scan(db) -> Family:
    """Pick the default family — created by `create_admin`."""
    fam = db.query(Family).filter(Family.name == get_settings().initial_admin_family_name).first()
    if fam is None:
        print("[scan_bbkt] no default family; run create_admin first", file=sys.stderr)
        sys.exit(1)
    return fam


def main() -> int:
    s = get_settings()
    bbkt = s.resolved_bbkt_root()
    if not bbkt.exists():
        print(f"[scan_bbkt] not found: {bbkt}", file=sys.stderr)
        return 1

    # Resolve the default family up front (idempotent — created by create_admin).
    for db in session_scope():
        family = _family_for_scan(db)
        db.commit()
        view = _ensure_view(db, family.id, _DEFAULT_VIEW_NAME)
        db.commit()
        break

    series_dirs = sorted([p for p in bbkt.iterdir() if p.is_dir()])
    total = 0
    for series_path in series_dirs:
        for db in session_scope():
            view = db.get(View, view.id)
            _scan_series(db, view, series_path)
            db.commit()
            total += 1
            break

    for db in session_scope():
        items_total = db.query(Item).count()
        files_total = db.query(MediaFile).count()
        print(
            f"[scan_bbkt] series processed={total} items={items_total} files={files_total}"
        )
        break
    return 0


if __name__ == "__main__":
    sys.exit(main())
