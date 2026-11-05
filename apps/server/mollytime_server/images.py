"""Versioned covers, including published episode artwork for empty containers."""

from .models import Item, MediaFile
from .resource_policy import visible_item_ids
from .storage import build_storage
from .storage.settings import get_storage_settings
from .transactions import external_io


def prime_artwork(db, items):
    """Keep page ancestors and their artwork alive for this read-only request.

    Cache missing artwork too: SQLAlchemy's identity map cannot cache a miss.
    Descendant cover fallback still applies the existing publication policy.
    """
    nodes = {item.id: item for item in items}
    families = {item.family_id for item in items}
    seen = set(nodes)
    pending = {item.parent_id for item in items if item.parent_id} - seen
    while pending:
        parents = db.query(Item).filter(Item.id.in_(pending), Item.family_id.in_(families)).all()
        seen.update(pending)
        nodes.update((item.id, item) for item in parents)
        pending = {item.parent_id for item in parents if item.parent_id} - seen
    files = {key: [] for key in nodes}
    for file in db.query(MediaFile).filter(
        MediaFile.item_id.in_(nodes), MediaFile.family_id.in_(families),
        MediaFile.kind.in_(["image", "preview"]),
    ).all():
        if file.family_id == nodes[file.item_id].family_id:
            files[file.item_id].append(file)
    db.info["artwork_items"] = nodes
    db.info["artwork_files"] = files
    return nodes


def artwork_files(db, item):
    cached = db.info.get("artwork_files", {})
    if item.id in cached:
        return cached[item.id]
    return db.query(MediaFile).filter(
        MediaFile.item_id == item.id, MediaFile.family_id == item.family_id,
        MediaFile.kind.in_(["image", "preview"]),
    ).all()


def animated_format(file):
    return file.mime in ("image/webp", "image/png", "image/gif") or file.path.lower().endswith((".webp", ".png", ".gif"))


def image_files(db, item):
    """Resolve both artwork roles from the same item/ancestor, never mix videos."""
    current, visited = item, set()
    while current and current.id not in visited and current.family_id == item.family_id:
        visited.add(current.id)
        files = artwork_files(db, current)
        cover = next((file for file in files if file.kind == "image"), None)
        preview = next((file for file in files if file.kind == "preview"), None)
        if cover or preview:
            return cover or preview, preview or (cover if animated_format(cover) else None)
        current = db.get(Item, current.parent_id) if current.parent_id else None
    return None, None


def image_version(db, file):
    # Cover repair replaces the contents of an existing MediaFile and updates
    # the owner's tag. The media ID alone would leave the browser's URL stale.
    owner = db.get(Item, file.item_id)
    return owner.primary_image_tag if file.kind == "image" and owner and owner.primary_image_tag else file.id


def image_url(db, item):
    current, visited = item, set()
    while current and current.id not in visited:
        visited.add(current.id)
        if current.primary_image_tag:
            return f"/api/items/{item.id}/image?v={current.primary_image_tag}"
        cover = next(iter(sorted(artwork_files(db, current), key=lambda file: file.kind)), None)
        if cover:
            return f"/api/items/{item.id}/image?v={image_version(db, cover)}"
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
                MediaFile.kind.in_(["image", "preview"]),
                Item.id.in_(visible_item_ids(item.family_id)),
            )
            .order_by(Item.type.desc(), Item.index_number, Item.name, Item.id)
            .distinct()
            .limit(1).all()
        )
        for candidate in candidates:
            cover, _ = image_files(db, candidate)
            if cover:
                return f"/api/items/{candidate.id}/image?v={image_version(db, cover)}"
    return f"/api/items/{item.id}/image"


def image_ref(db, item, *, direct=True):
    """Return the authenticated fallback and, for OSS artwork, a direct URL."""
    url = image_url(db, item)
    result = {"url": url}
    image_id = url.split("/", 4)[3]
    source = db.get(Item, image_id)
    file, preview = image_files(db, source) if source and source.family_id == item.family_id else (None, None)
    if preview:
        result["previewUrl"] = f"/api/items/{image_id}/image?v={image_version(db, preview)}&preview=1"
    if file and file.kind == "image" and file.storage == "oss" and not animated_format(file) and direct and not db.info.get("static_catalog"):
        signing = db.info.get("cover_oss_signing")
        if signing is None:
            with external_io(db):
                signing = (build_storage("oss"), get_storage_settings().oss_signed_url_ttl)
            db.info["cover_oss_signing"] = signing
        from .oss_usage import media_url
        result["directUrl"] = media_url(signing[0], file.path, signing[1], item.family_id)
    return result
