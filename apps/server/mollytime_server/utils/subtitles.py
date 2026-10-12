"""Normalize SRT/WebVTT timing without dropping cue text or formatting."""

import re

TIMING = re.compile(
    r"(?P<a>(?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+(?P<b>(?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3})(?P<settings>[^\n]*)"
)


def _milliseconds(value):
    parts = value.replace(",", ".").split(":")
    hour, minute, rest = parts if len(parts) == 3 else ["0", *parts]
    second, ms = rest.split(".")
    return ((int(hour) * 60 + int(minute)) * 60 + int(second)) * 1000 + int(ms)


def _timestamp(value):
    value = max(0, value)
    return (
        f"{value // 3600000:02}:{value // 60000 % 60:02}:{value // 1000 % 60:02}.{value % 1000:03}"
    )


def webvtt(blob, offset_ms=0):
    text = blob.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    text = TIMING.sub(
        lambda m: (
            f"{_timestamp(_milliseconds(m['a']) + offset_ms)} --> "
            f"{_timestamp(_milliseconds(m['b']) + offset_ms)}{m['settings']}"
        ),
        text,
    )
    if not text.startswith("WEBVTT"):
        text = "WEBVTT\n\n" + text
    return text.encode("utf-8")
