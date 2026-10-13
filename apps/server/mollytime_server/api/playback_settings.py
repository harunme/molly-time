"""TV and browser access to shared family playback preferences."""

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from ..deps import CurrentUser, DbSession
from ..transactions import serialize_sqlite_write
from ..playback_settings import SubtitlePreference, default_subtitle, save_default_subtitle

router = APIRouter(prefix="/api/settings", tags=["playback-settings"])


class PlaybackSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    defaultSubtitle: SubtitlePreference


@router.get("/playback")
def read_settings(user: CurrentUser, db: DbSession):
    return {"defaultSubtitle": default_subtitle(db, user.family_id)}


@router.put("/playback")
def update_settings(body: PlaybackSettingsBody, user: CurrentUser, db: DbSession):
    serialize_sqlite_write(db)
    save_default_subtitle(db, user.family_id, body.defaultSubtitle)
    db.commit()
    return read_settings(user, db)
