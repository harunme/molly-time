"""Versioned image references so replacing a cover refreshes both web clients."""

from .models import Item


def image_url(db, item):
    current, visited = item, set()
    while current and current.id not in visited:
        visited.add(current.id)
        if current.primary_image_tag:
            return f"/api/items/{item.id}/image?v={current.primary_image_tag}"
        current = db.get(Item, current.parent_id) if current.parent_id else None
        if current and current.family_id != item.family_id:
            break
    return f"/api/items/{item.id}/image"
