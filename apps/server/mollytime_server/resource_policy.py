"""Shared catalog publication rules; parent-cookie previews may inspect drafts."""

from fastapi import HTTPException
from sqlalchemy import or_, select

from .management_models import ResourceState
from .models import Item, MediaFile


def visible_item_ids(family_id):
    """SQL equivalent of visible(), including ancestor and family checks.

    Only chains reachable from a root are eligible, so cycles remain invisible.
    A missing parent terminates a chain, just as in visible().
    """
    parent = Item.__table__.alias("publication_parent")
    allowed = ~select(ResourceState.item_id).where(
        ResourceState.item_id == Item.id,
        or_(ResourceState.status != "published", ResourceState.ready.is_(False)),
    ).exists()
    tree = select(Item.id).where(
        Item.family_id == family_id,
        ~select(parent.c.id).where(parent.c.id == Item.parent_id).exists(),
        allowed,
    ).cte("visible_catalog", recursive=True)
    tree = tree.union_all(select(Item.id).join(tree, Item.parent_id == tree.c.id).where(
        Item.family_id == family_id, allowed,
    ))
    return select(tree.c.id)


def visible(db, item: Item) -> bool:
    key = ("publication_states", item.family_id)
    if key not in db.info:
        db.info[key] = {
            s.item_id: s
            for s in db.query(ResourceState)
            .join(Item, Item.id == ResourceState.item_id)
            .filter(Item.family_id == item.family_id)
            .all()
        }
    states = db.info[key]
    visited = set()
    current = item
    while current and current.id not in visited:
        visited.add(current.id)
        state = states.get(current.id)
        if state and (state.status != "published" or not state.ready):
            return False
        parent = db.get(Item, current.parent_id) if current.parent_id else None
        if parent and parent.family_id != item.family_id:
            return False
        current = parent
    return current is None


def require_visible(db, item, request):
    if item.type == "Deleted":
        raise HTTPException(404, "内容已删除")
    if not getattr(request.state, "parent_preview", False) and not visible(db, item):
        raise HTTPException(404, "内容未发布或不可访问")


def published_series(db, family_id):
    series = (
        db.query(Item)
        .filter(Item.family_id == family_id, Item.type == "Series")
        .order_by(Item.sort_name, Item.name)
        .all()
    )
    return [
        item for item in series if visible(db, item) and published_episodes(db, item.id, family_id)
    ]


def published_episodes(db, series_id, family_id):
    seasons = db.query(Item.id).filter(
        Item.family_id == family_id, Item.parent_id == series_id, Item.type == "Season"
    )
    episodes = (
        db.query(Item)
        .join(MediaFile, MediaFile.item_id == Item.id)
        .filter(
            Item.family_id == family_id,
            Item.type == "Episode",
            or_(Item.parent_id == series_id, Item.parent_id.in_(seasons)),
            MediaFile.kind == "video",
        )
        .distinct()
        .all()
    )
    return [e for e in episodes if visible(db, e)]
