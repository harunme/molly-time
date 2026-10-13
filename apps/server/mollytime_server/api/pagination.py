"""Bounded database pages for management lists, with legacy array responses."""


def paginate(query, page, page_size, serialize, preload=None):
    total = query.order_by(None).count() if page is not None else None
    rows = (query.offset((page - 1) * page_size).limit(page_size)
            if page is not None else query.limit(100)).all()
    if preload:
        preload(rows)
    items = [serialize(row) for row in rows]
    if page is None:
        return items
    return {
        "items": items,
        "page": page,
        "pageSize": page_size,
        "total": total,
    }
