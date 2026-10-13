"""Deterministic subtitle preference lookup and track matching."""

from typing import Literal

from .management_models import PlaybackSettings

SubtitlePreference = Literal["zh", "en", "zh-en", "off"]


def default_subtitle(db, family_id):
    row = db.get(PlaybackSettings, family_id)
    return row.default_subtitle if row else "zh"


def save_default_subtitle(db, family_id, value):
    row = db.get(PlaybackSettings, family_id)
    if row is None:
        row = PlaybackSettings(family_id=family_id)
        db.add(row)
    row.default_subtitle = value


def subtitle_type(language):
    language = (language or "und").lower().replace("_", "-")
    if language in ("zh-en", "en-zh"):
        return "zh-en"
    base = language.split("-")[0]
    return {"zho": "zh", "chi": "zh", "eng": "en"}.get(base, base)


def preferred_subtitle_index(subtitles, preference):
    # Never silently substitute a different language or a legacy per-file default.
    if preference == "off":
        return None
    return next((sub.index for sub in subtitles
                 if subtitle_type(sub.language) == preference), None)
