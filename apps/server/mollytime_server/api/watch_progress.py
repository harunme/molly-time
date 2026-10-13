"""Family resume includes historical profiles without rewriting their records."""

from sqlalchemy import or_

from ..management_models import WatchProgress, WatchSession
from .watch_filters import family_watch_clause


def scoped_progress(db, family, child=None):
    query = db.query(WatchProgress).outerjoin(
        WatchSession, WatchSession.id == WatchProgress.session_id,
    ).filter(WatchProgress.family_id == family)
    if child is not None:
        return query.filter(WatchProgress.child_id == child)
    # Historical projections may predate stored sessions; real parent previews
    # must never replace the family's resume position.
    return query.filter(or_(WatchSession.id.is_(None), family_watch_clause()))
