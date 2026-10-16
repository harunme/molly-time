"""Bounded TV catalog queries. Legacy unpaged API shapes remain supported."""

import datetime as dt

from fastapi import HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.orm import aliased

from ..images import image_ref
from ..management_models import ResourceState, WatchProgress
from ..models import Item, MediaFile
from ..resource_policy import visible_item_ids
from ..resource_tree import descendant_ids
from .watch_progress import scoped_progress


def episode_query(db, family):
    parent = aliased(Item)
    tree = select(Item.id.label("id"), Item.id.label("folder_id")).where(
        Item.family_id == family, Item.type == "Series", Item.parent_id.is_(None),
    ).cte("catalog_folders", recursive=True)
    tree = tree.union_all(select(Item.id, tree.c.folder_id).join(tree, Item.parent_id == tree.c.id).where(
        Item.family_id == family,
    ))
    folder_id = tree.c.folder_id
    query = db.query(Item).join(parent, Item.parent_id == parent.id).join(tree, Item.id == tree.c.id).filter(
        Item.family_id == family, Item.type == "Episode",
        parent.family_id == family, parent.type.in_(["Series", "Season"]),
        Item.id.in_(visible_item_ids(family)),
        select(MediaFile.id).where(
            MediaFile.item_id == Item.id, MediaFile.family_id == family,
            MediaFile.kind == "video",
        ).exists(),
    )
    return query, parent, folder_id


def ordered_playlist(db, family, series_id):
    query, parent, _folder_id = episode_query(db, family)
    order = (
        case((parent.id == series_id, 0), else_=func.coalesce(parent.index_number, 0)),
        parent.name, func.coalesce(Item.index_number, 0), Item.name, Item.id,
    )
    return query.filter(Item.id.in_(descendant_ids(family, series_id))).order_by(*order), order


def episode_dto(db, episode):
    parent = db.get(Item, episode.parent_id)
    return {
        "id": episode.id, "name": episode.name,
        "seasonName": parent.name, "seasonId": parent.id,
        "indexNumber": episode.index_number,
        "runtimeMs": episode.runtime_ticks // 10000 if episode.runtime_ticks is not None else None,
        "image": image_ref(db, episode),
    }


def following_episode_id(query, order, episode_id):
    """Find the following ID without materializing the playlist."""
    ordered = query.with_entities(
        Item.id.label("id"), func.lead(Item.id).over(order_by=order).label("next_id"),
    ).order_by(None).subquery()
    return query.session.query(ordered.c.next_id).filter(ordered.c.id == episode_id).scalar()


def paged_playlist(db, family, user_id, child_id, series, page, page_size):
    query, order = ordered_playlist(db, family, series.id)
    total = query.order_by(None).count()
    progress_query = scoped_progress(db, family, child_id).filter(
        WatchProgress.item_id.in_(query.order_by(None).with_entities(Item.id)),
    )
    progress = progress_query.order_by(
        WatchProgress.session_started_at.desc(),
        WatchProgress.session_id.desc(),
    ).first()
    selected = query.first()
    position = 0
    if progress:
        selected = db.get(Item, progress.item_id)
        if progress.completed:
            next_id = following_episode_id(query, order, selected.id)
            if next_id:
                selected = db.get(Item, next_id)
        else:
            position = progress.position_ms
    episodes = query.offset((page - 1) * page_size).limit(page_size).all()
    return {
        "seriesId": series.id, "name": series.name,
        "episodeId": selected.id if selected else None, "positionMs": position,
        "hasProgress": progress is not None,
        "resumeEpisode": episode_dto(db, selected) if progress and selected else None,
        "episodes": [episode_dto(db, episode) for episode in episodes],
        "page": page, "pageSize": page_size, "total": total,
        "hasMore": page * page_size < total,
    }


def paged_home(content, db, family, child, page, page_size, row_id):
    from .manage_home import render_home

    query, _, folder_id = episode_query(db, family)
    counts = query.with_entities(
        folder_id.label("folder_id"), func.count(Item.id).label("episode_count"),
    ).group_by(folder_id).subquery()
    series_query = db.query(Item, counts.c.episode_count).join(
        counts, counts.c.folder_id == Item.id,
    ).outerjoin(ResourceState, ResourceState.item_id == Item.id).filter(
        Item.family_id == family, Item.type == "Series",
    )
    rows = [row for row in content["rows"] if row["enabled"] and
            (row_id is None or row.get("id") == row_id)]
    if row_id is not None and not rows:
        raise HTTPException(404, "栏目不存在")
    result = []
    for row in rows:
        key = row.get("id", "recently-played")
        if row["source"] in ("continue", "recently-played"):
            rendered = render_home({"rows": [row]}, db, family, child)
            items = rendered["rows"][0]["items"] if rendered["rows"] else []
            total = len(items)
            items = items[(page - 1) * page_size:page * page_size]
        else:
            selected = series_query
            library = key == "library" and row["source"] == "recent"
            if row["source"] == "manual":
                ids = row["itemIds"]
                selected = selected.filter(Item.id.in_(ids)).order_by(
                    case({key: index for index, key in enumerate(ids)}, value=Item.id) if ids else Item.id,
                )
            else:
                selected = selected.order_by(
                    func.coalesce(ResourceState.published_at, dt.datetime.min).desc(),
                    Item.sort_name, Item.name, Item.id,
                )
            total = selected.order_by(None).count()
            if not library:
                total = min(total, row["limit"])
            start = (page - 1) * page_size
            records = selected.offset(start).limit(min(page_size, max(0, total - start))).all()
            items = [{
                "id": item.id, "name": item.name, "year": item.premiere_year,
                "sortName": item.sort_name, "episodeCount": count,
                "image": image_ref(db, item),
            } for item, count in records]
        if total or row_id is not None:
            result.append({
                "id": key, "title": row["title"], "items": items,
                "page": page, "pageSize": page_size, "total": total,
                "hasMore": page * page_size < total,
            })
    return {"rows": result}
