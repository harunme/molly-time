"""Versioned covers, including published episode artwork for empty containers."""

from .models import Item, MediaFile
from .resource_policy import visible_item_ids
from .storage import build_storage
from .storage.settings import get_storage_settings
from .transactions import external_io


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
                Item.id.in_(visible_item_ids(item.family_id)),
            )
            .order_by(Item.type.desc(), Item.index_number, Item.name, Item.id)
            .distinct()
            .limit(1).all()
        )
        for candidate in candidates:
            version = f"?v={candidate.primary_image_tag}" if candidate.primary_image_tag else ""
            return f"/api/items/{candidate.id}/image{version}"
    return f"/api/items/{item.id}/image"


def image_ref(db, item, *, direct=True):
    """Return the authenticated fallback and, for OSS artwork, a direct URL."""
    url = image_url(db, item)
    result = {"url": url}
    image_id = url.split("/", 4)[3]
    current, visited = db.get(Item, image_id), set()
    while current and current.id not in visited and current.family_id == item.family_id:
        visited.add(current.id)
        file = db.query(MediaFile).filter(
            MediaFile.item_id == current.id,
            MediaFile.family_id == item.family_id,
            MediaFile.kind == "image",
        ).first()
        if file:
            # WebP and PNG may contain animation. Never render their original
            # OSS object as a poster: it can advance before the card is visible.
            animated_format = file.mime in ("image/webp", "image/png") or file.path.lower().endswith((".webp", ".png"))
            if animated_format:
                result["previewUrl"] = url + ("&" if "?" in url else "?") + "preview=1"
            if file.storage == "oss" and not animated_format and direct and not db.info.get("static_catalog"):
                signing = db.info.get("cover_oss_signing")
                if signing is None:
                    with external_io(db):
                        signing = (build_storage("oss"), get_storage_settings().oss_signed_url_ttl)
                    db.info["cover_oss_signing"] = signing
                result["directUrl"] = signing[0].signed_url(file.path, signing[1])
            break
        current = db.get(Item, current.parent_id) if current.parent_id else None
    return result
