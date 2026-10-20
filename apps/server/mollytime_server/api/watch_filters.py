"""Shared inclusion rule for family watch statistics."""

from sqlalchemy import and_, or_, select

from ..management_models import WatchSession
from ..models import Item


def family_watch_clause():
    # Legacy TV sessions used parent_preview despite having a device identity.
    # Also exclude early experimental live sessions labeled family_watch or
    # parent_preview. Keep their playback/control events without counting time.
    live_channel = (
        select(Item.id)
        .where(
            Item.id == WatchSession.item_id,
            Item.type == "LiveChannel",
        )
        .correlate(WatchSession)
        .exists()
    )
    return and_(
        ~live_channel,
        or_(
            WatchSession.purpose.in_(("child_watch", "family_watch")),
            and_(WatchSession.purpose == "parent_preview", WatchSession.device_id.is_not(None)),
        ),
    )
