"""Device-scoped deterministic watching policy, independent of viewing statistics."""

import datetime as dt
from zoneinfo import ZoneInfo

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


QUOTA_TIMEZONE = ZoneInfo("Asia/Shanghai")


def quota_now():
    return dt.datetime.now(QUOTA_TIMEZONE)


def refresh_daily(db, row):
    """Caller holds the device control lock and commits this transaction."""
    if not row or not row.enabled:
        return
    today = quota_now().date().isoformat()
    if row.quota_day and row.quota_day >= today:
        return  # Clock rollback must never grant another allowance.
    previous = current_round(db, row)
    if row.quota_day is None and previous:
        row.quota_day = today  # Upgrade without restoring already-consumed quota.
        db.flush()
        return
    if previous:
        previous.ended = True
    round = WatchControlRound(
        device_id=row.device_id,
        mode=row.mode,
        amount=row.amount,
        limit_ms=row.amount * 60000 if row.mode == "minutes" else 0,
    )
    db.add(round)
    db.flush()
    row.round_id, row.quota_day = round.id, today
    row.version += 1
    db.flush()


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
    reset_at = (
        dt.datetime.combine(
            dt.date.fromisoformat(row.quota_day) + dt.timedelta(days=1),
            dt.time(), QUOTA_TIMEZONE,
        )
        if row and row.quota_day else None
    )
    return {
        **paths,
        "quotaDay": row.quota_day if row else None,
        "timezone": "Asia/Shanghai",
        "resetsAt": int(reset_at.timestamp() * 1000) if reset_at else None,
        "serverTime": int(quota_now().timestamp() * 1000),
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
    row = (
        db.query(WatchControl).filter_by(device_id=device_id).with_for_update().first()
        if bind and device_id else control(db, device_id)
    )
    if bind:
        refresh_daily(db, row)
    if not row or not row.enabled:
        return None
    round = current_round(db, row)
    normalize(db, round)
    if not round or round.ended:
        raise HTTPException(403, "今日额度已用完，明天自动恢复，也可请家长加看")
    if live and round.mode != "minutes":
        raise HTTPException(403, "看直播需要家长设置观看时间")
    if round.mode == "episodes":
        active = round.playlist[round.cursor] if round.cursor < len(round.playlist) else None
        if bind:
            cursor = round.cursor + (1 if active and active != episode_id else 0)
            if cursor >= round.amount:
                raise HTTPException(403, "今日集数已用完，可继续当前视频，或请家长加看")
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
