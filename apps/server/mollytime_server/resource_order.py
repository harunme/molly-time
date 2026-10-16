"""Shared sibling order for management, TV browsing, and playback."""

from sqlalchemy import case

from .management_models import ResourcePosition
from .models import Item


def manual_order():
    return (
        case((ResourcePosition.position.is_(None), 1), else_=0), ResourcePosition.position,
        case((Item.type == "Season", 0), else_=1),
        case((Item.index_number.is_(None), 1), else_=0), Item.index_number,
        Item.sort_name, Item.name, Item.id,
    )
