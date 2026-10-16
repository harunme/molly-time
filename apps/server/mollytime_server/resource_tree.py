"""Family-scoped catalog traversal shared by management and playback."""

from fastapi import HTTPException
from sqlalchemy import select

from .models import Item


def descendant_ids(family_id, root_id):
    # UNION also terminates if a legacy catalog contains a cycle.
    tree = select(Item.id).where(Item.family_id == family_id, Item.id == root_id).cte(
        'resource_descendants', recursive=True,
    )
    tree = tree.union(select(Item.id).join(tree, Item.parent_id == tree.c.id).where(
        Item.family_id == family_id,
    ))
    return select(tree.c.id)


def ancestors(db, item):
    result, seen, parent_id = [], {item.id}, item.parent_id
    while parent_id:
        if parent_id in seen:
            raise HTTPException(409, '文件夹结构异常，请刷新后重试')
        seen.add(parent_id)
        parent = db.get(Item, parent_id)
        if parent is None or parent.family_id != item.family_id:
            raise HTTPException(404, '上级文件夹不存在')
        result.append(parent)
        parent_id = parent.parent_id
    return list(reversed(result))
