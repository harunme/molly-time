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
        img.seek(0)
        img = img.convert("RGB")
        if img.width > max_width:
            ratio = max_width / img.width
            new_size = (max_width, max(1, int(img.height * ratio)))
            img = img.resize(new_size, Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
    atomic_write(dest, data)
    return len(data)


def preview_to_file(src: bytes, dest: Path, max_width: int) -> None:
    """Loop the motion frames, keeping the first frame for the static poster."""
    frames, durations = [], []
    with Image.open(io.BytesIO(src)) as image:
        width = min(image.width, max_width, 640)
        size = (width, max(1, round(image.height * width / image.width)))
        count = getattr(image, "n_frames", 1)
        if count == 1:
            dest.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(dest, b"")  # Remember that this container is a still image.
            return
        if count > 240 or count * size[0] * size[1] > 32_000_000:
            raise ValueError("cover preview exceeds decode budget")
        for index in range(1, count):
            image.seek(index)
            frame = image.convert("RGBA")  # WebP duration is populated on load.
            frames.append(frame.resize(size, Image.Resampling.LANCZOS))
            durations.append(max(10, image.info.get("duration", 100)))
    output = io.BytesIO()
    frames[0].save(output, format="WEBP", save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, quality=82, method=4)
    dest.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(dest, output.getvalue())


def aspect_ratio_for(path: Path) -> float | None:
    try:
        with Image.open(path) as img:
            return img.width / img.height
    except Exception as exc:  # pragma: no cover
        logger.debug("aspect ratio probe failed for %s: %s", path, exc)
        return None

def atomic_write(path, data):
    import os
    import tempfile
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = handle.name
            handle.write(data)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
