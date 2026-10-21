"""Device-scoped deterministic watching policy, independent of viewing statistics."""

from fastapi import HTTPException
from sqlalchemy import func

from .management_models import WatchControl, WatchControlRound, WatchControlSession
from .models import Item
from .resource_policy import visible


def control(db, device_id):
    return db.get(WatchControl, device_id) if device_id else None


def current_round(db, row):
    return (
        db.query(WatchControlRound).filter_by(id=row.round_id).with_for_update().first()
        if row and row.round_id
        else None
    )


def remaining(round):
    return max(0, round.limit_ms - max(round.played_ms, round.client_played_ms))


def normalize(db, round):
    if not round or round.ended:
        return
    if round.mode == "minutes":
        if remaining(round) == 0:
            round.ended = True
    elif round.playlist:
        while round.cursor < len(round.playlist):
            item = db.get(Item, round.playlist[round.cursor])
            if item and visible(db, item):
                break
            round.cursor += 1
        if round.cursor >= len(round.playlist):
            round.ended = True


def dto(db, row):
    round = current_round(db, row)
    normalize(db, round)
    episode_id = (
        round.playlist[round.cursor]
        if round and round.playlist and round.cursor < len(round.playlist)
        else None
    )
    item = db.get(Item, episode_id) if episode_id else None
    from .api.reminders import clip_file
    from .management_models import FamilyReminders

    clips = db.get(FamilyReminders, row.family_id) if row else None
    paths = {
        f"{kind}Path": f"/api/reminders/{kind}/playback"
        if clips and clip_file(db, clips, kind)
        else None
        for kind in ("warning", "farewell")
    }
    return {
        **paths,
        "supported": bool(row and row.supported),
        "enabled": bool(row and row.enabled),
        "mode": row.mode if row else "episodes",
        "amount": row.amount if row else 2,
        "version": row.version if row else 0,
        "acknowledged": row.acknowledged if row else 0,
        "status": "off"
        if not row or not row.enabled
        else ("resting" if not round or round.ended else "allowed"),
        "round": None
        if not round
        else {
            "id": round.id,
            "mode": round.mode,
            "amount": round.amount,
            "playlist": round.playlist,
            "cursor": round.cursor,
            "playedMs": max(round.played_ms, round.client_played_ms),
            "limitMs": round.limit_ms,
            "remainingMs": remaining(round) if round.mode == "minutes" else None,
            "ended": round.ended,
            "stopAfter": round.stop_after,
            "episodeId": episode_id,
            "episodeName": item.name if item else None,
        },
    }


def require_play(db, device_id, episode_id=None, *, live=False, bind=False):
    row = control(db, device_id)
    if not row or not row.enabled:
        return None
    round = current_round(db, row)
    normalize(db, round)
    if not round or round.ended:
        raise HTTPException(403, "看完啦，请家长允许观看")
    if live and round.mode != "minutes":
        raise HTTPException(403, "看直播需要家长设置观看时间")
    if round.mode == "episodes":
        if not round.playlist and bind:
            round.playlist = playlist_from(db, episode_id, round.amount)
            db.flush()
        if not round.playlist and not bind:
            raise HTTPException(403, "请先选择视频开始观看")
        if round.playlist and (
            round.cursor >= len(round.playlist) or round.playlist[round.cursor] != episode_id
        ):
            raise HTTPException(403, "这次的片单还没看完，请继续观看或请家长重新选片")
    return round


def playlist_from(db, episode_id, amount):
    from sqlalchemy import select

    from .api.catalog_pagination import ordered_playlist

    item = db.get(Item, episode_id)
    if not item:
        raise HTTPException(404)
    query, order = ordered_playlist(db, item.family_id, item.parent_id)
    ordered = (
        query.with_entities(Item.id.label("id"), func.row_number().over(order_by=order).label("n"))
        .order_by(None)
        .subquery()
    )
    start = select(ordered.c.n).where(ordered.c.id == episode_id).scalar_subquery()
    ids = [
        r[0]
        for r in db.query(ordered.c.id)
        .filter(ordered.c.n >= start)
        .order_by(ordered.c.n)
        .limit(amount)
        .all()
    ]
    if not ids:
        raise HTTPException(404, "这个视频已不可播放")
    return ids


def attach_session(db, round, session_id):
    if round:
        db.add(WatchControlSession(session_id=session_id, round_id=round.id, cursor=round.cursor))


def report(db, session_id, body):
    link = db.get(WatchControlSession, session_id)
    if not link:
        return
    round = db.query(WatchControlRound).filter_by(id=link.round_id).with_for_update().one()
    round.played_ms += body.playedMs
    if body.completed and body.stopped and round.mode == "episodes" and link.cursor == round.cursor:
        round.cursor += 1
        if round.cursor >= len(round.playlist):
            round.ended = True
    normalize(db, round)
