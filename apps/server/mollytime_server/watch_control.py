"""Device-scoped deterministic watching policy, independent of viewing statistics."""

from fastapi import HTTPException

from .management_models import WatchControl, WatchControlRound, WatchControlSession
from .models import Item


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
    elif round.cursor >= round.amount:
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
            "remainingEpisodes": (
                0 if round.ended else max(0, round.amount - round.cursor - bool(episode_id))
            )
            if round.mode == "episodes"
            else None,
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
        active = round.playlist[round.cursor] if round.cursor < len(round.playlist) else None
        if bind:
            cursor = round.cursor + (1 if active and active != episode_id else 0)
            if cursor >= round.amount:
                raise HTTPException(403, "本次集数已用完，可继续当前视频，或请家长加看")
            round.cursor = cursor
            round.playlist = [*round.playlist[:cursor], episode_id]
            db.flush()
        elif episode_id != active:
            raise HTTPException(403, "请先开始观看这个视频")
    return round


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
        if round.cursor >= round.amount:
            round.ended = True
    normalize(db, round)
