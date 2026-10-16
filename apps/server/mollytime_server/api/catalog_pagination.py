"""Bounded TV catalog queries. Legacy unpaged API shapes remain supported."""

import datetime as dt

from fastapi import HTTPException
from sqlalchemy import String, case, cast, func, literal, or_, select
from sqlalchemy.orm import aliased

from ..images import image_ref
from ..management_models import ResourcePosition, ResourceState, WatchProgress
from ..models import Item, MediaFile
from ..resource_order import manual_order
from ..resource_policy import visible_item_ids
from .watch_progress import scoped_progress


def episode_query(db, family, visible_ids=None):
    parent = aliased(Item)
    tree = select(Item.id.label("id"), Item.id.label("folder_id")).where(
        Item.family_id == family, Item.type == "Series", Item.parent_id.is_(None),
    ).cte(recursive=True)
    tree = tree.union_all(select(Item.id, tree.c.folder_id).join(tree, Item.parent_id == tree.c.id).where(
        Item.family_id == family,
    ))
    folder_id = tree.c.folder_id
    query = db.query(Item).join(parent, Item.parent_id == parent.id).join(tree, Item.id == tree.c.id).filter(
        Item.family_id == family, Item.type == "Episode",
        parent.family_id == family, parent.type.in_(["Series", "Season"]),
        Item.id.in_(visible_ids if visible_ids is not None else visible_item_ids(family)),
        select(MediaFile.id).where(
            MediaFile.item_id == Item.id, MediaFile.family_id == family,
            MediaFile.kind == "video",
        ).exists(),
    )
    return query, parent, folder_id


def ordered_playlist(db, family, series_id):
    query, _parent, _folder_id = episode_query(db, family)
    siblings = select(
        Item.id, Item.parent_id,
        func.row_number().over(partition_by=Item.parent_id, order_by=manual_order()).label("ordinal"),
    ).outerjoin(ResourcePosition, ResourcePosition.item_id == Item.id).where(Item.family_id == family).subquery()
    tree = select(Item.id, cast(literal(""), String(1024)).label("path"), literal(0).label("depth")).where(
        Item.id == series_id, Item.family_id == family,
    ).cte("playback_order", recursive=True)
    segment = func.substr(literal("0000000000") + cast(siblings.c.ordinal, String), -10, 10)
    tree = tree.union_all(select(siblings.c.id, tree.c.path + segment, tree.c.depth + 1).join(
        tree, siblings.c.parent_id == tree.c.id,
    ).where(tree.c.depth < 32))
    order = (tree.c.path, Item.id)
    return query.join(tree, tree.c.id == Item.id).order_by(*order), order


def folder_counts(db, family, visible_ids=None):
    """Count visible playable descendants for every container, including nested seasons."""
    playable, _, _ = episode_query(db, family, visible_ids)
    playable = playable.with_entities(Item.id).subquery()
    tree = select(Item.id.label("folder_id"), Item.id).where(
        Item.family_id == family, Item.type.in_(["Series", "Season"]),
    ).cte("folder_members", recursive=True)
    tree = tree.union(select(tree.c.folder_id, Item.id).join(tree, Item.parent_id == tree.c.id).where(
        Item.family_id == family,
    ))
    return db.query(tree.c.folder_id, func.count().label("episode_count")).join(
        playable, playable.c.id == tree.c.id,
    ).group_by(tree.c.folder_id).subquery()


def folder_items(db, family, folder_id, page, page_size):
    visible_ids = visible_item_ids(family)
    counts = folder_counts(db, family, visible_ids)
    playable, _, _ = episode_query(db, family, visible_ids)
    query = db.query(Item, counts.c.episode_count).outerjoin(counts, counts.c.folder_id == Item.id).filter(
        Item.family_id == family, Item.parent_id == folder_id,
        Item.id.in_(visible_ids),
        or_(counts.c.episode_count > 0, Item.id.in_(playable.with_entities(Item.id))),
    )
    total = query.count()
    records = query.outerjoin(ResourcePosition, ResourcePosition.item_id == Item.id).order_by(
        *manual_order(),
    ).offset((page - 1) * page_size).limit(page_size).all()
    items = []
    for item, count in records:
        if item.type == "Episode":
            items.append({**episode_dto(db, item), "type": "episode"})
        else:
            items.append({"id": item.id, "name": item.name, "type": "folder",
                          "episodeCount": count, "image": image_ref(db, item)})
    return {"items": items, "itemTotal": total, "itemsHasMore": page * page_size < total}


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
        **folder_items(db, family, series.id, page, page_size),
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
                selected = selected.outerjoin(ResourcePosition, ResourcePosition.item_id == Item.id).order_by(*manual_order()) if library else selected.order_by(
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
