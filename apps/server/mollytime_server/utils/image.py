"""Image resize / cover handling."""

from __future__ import annotations

import io
import logging
from pathlib import Path

from PIL import Image

logger = logging.getLogger(__name__)


def resize_to_file(
    src: bytes,
    dest: Path,
    max_width: int,
    quality: int = 82,
) -> int:
    """Resize `src` to fit within `max_width` (height proportional) and write
    to `dest`. Returns bytes written.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(src)) as img:
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        if img.width > max_width:
            ratio = max_width / img.width
            new_size = (max_width, max(1, int(img.height * ratio)))
            img = img.resize(new_size, Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
    dest.write_bytes(data)
    return len(data)


def aspect_ratio_for(path: Path) -> float | None:
    try:
        with Image.open(path) as img:
            return img.width / img.height
    except Exception as exc:  # pragma: no cover
        logger.debug("aspect ratio probe failed for %s: %s", path, exc)
        return None