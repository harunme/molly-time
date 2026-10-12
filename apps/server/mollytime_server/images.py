"""Versioned covers, including published episode artwork for empty containers."""

from .models import Item, MediaFile
from .resource_policy import visible


def image_url(db, item):
    current, visited = item, set()
    while current and current.id not in visited:
        visited.add(current.id)
        if current.primary_image_tag:
            return f"/api/items/{item.id}/image?v={current.primary_image_tag}"
        if db.query(MediaFile.id).filter(
            MediaFile.item_id == current.id,
            MediaFile.family_id == item.family_id,
            MediaFile.kind == "image",
        ).first():
            return f"/api/items/{item.id}/image"
        current = db.get(Item, current.parent_id) if current.parent_id else None
        if current and current.family_id != item.family_id:
            break

    # Reuse real artwork rather than inventing posters. Serve through the selected
    # item's authenticated image endpoint so publication/family checks still apply.
    if item.type in ("Series", "Season"):
        parents = [item.id]
        if item.type == "Series":
            parents += [key for (key,) in db.query(Item.id).filter(
                Item.parent_id == item.id, Item.family_id == item.family_id, Item.type == "Season"
            ).all()]
        candidates = (
            db.query(Item)
            .join(MediaFile, MediaFile.item_id == Item.id)
            .filter(
                Item.family_id == item.family_id,
                Item.parent_id.in_(parents),
                Item.type.in_(["Season", "Episode"]),
                MediaFile.family_id == item.family_id,
                MediaFile.kind == "image",
            )
            .order_by(Item.type.desc(), Item.index_number, Item.name, Item.id)
            .distinct()
            .all()
        )
        for candidate in candidates:
            if visible(db, candidate):
                version = f"?v={candidate.primary_image_tag}" if candidate.primary_image_tag else ""
                return f"/api/items/{candidate.id}/image{version}"
    return f"/api/items/{item.id}/image"
