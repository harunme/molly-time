"""Shared inclusion rule for family watch statistics."""

from sqlalchemy import and_, or_

from ..management_models import WatchSession


def family_watch_clause():
    # Legacy TV sessions used parent_preview despite having a device identity.
    return or_(
        WatchSession.purpose.in_(("child_watch", "family_watch")),
        and_(WatchSession.purpose == "parent_preview", WatchSession.device_id.is_not(None)),
    )
