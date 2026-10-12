"""Minimal ffprobe wrapper — duration only.

We deliberately do NOT replace Jellyfin's codec graph. ffprobe is used solely
to populate `RunTimeTicks` so the TV client can show progress / Next Up.
If ffprobe is not on PATH (e.g. minimal Docker image), we silently skip —
the TV client still works, it just won't show duration / progress.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

_TICKS_PER_SECOND = 10_000_000  # 100ns units, matching Jellyfin

# Cached availability check — ffprobe won't appear mid-process.
_FFPROBE_AVAILABLE: bool | None = None


def _ffprobe_available() -> bool:
    global _FFPROBE_AVAILABLE
    if _FFPROBE_AVAILABLE is None:
        _FFPROBE_AVAILABLE = shutil.which("ffprobe") is not None
        if not _FFPROBE_AVAILABLE:
            logger.info("ffprobe not on PATH; durations will be left null")
    return _FFPROBE_AVAILABLE


def duration_seconds(path: Path) -> float | None:
    """Return duration in seconds or None if probe fails / ffprobe missing."""
    if not _ffprobe_available():
        return None
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_entries",
                "format=duration",
                str(path),
            ],
            stderr=subprocess.STDOUT,
            timeout=10,
        )
        data = json.loads(out.decode("utf-8", errors="ignore") or "{}")
        d = data.get("format", {}).get("duration")
        return float(d) if d else None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as exc:
        logger.warning("ffprobe failed for %s: %s", path, exc)
        return None


def duration_ticks(path: Path) -> int | None:
    secs = duration_seconds(path)
    return int(round(secs * _TICKS_PER_SECOND)) if secs is not None else None