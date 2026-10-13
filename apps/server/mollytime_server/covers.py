"""Conservative, deterministic rejection of near-black automatic video covers."""

import io
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageStat


def is_black_cover(data: bytes) -> bool:
    with Image.open(io.BytesIO(data)) as image:
        gray = image.convert("L").resize((64, 64))
        histogram = gray.histogram()
        dark_fraction = sum(histogram[:17]) / (64 * 64)
        # Deliberately reject only near-black frames, preserving dark scenes.
        return ImageStat.Stat(gray).mean[0] < 10 or dark_fraction >= 0.98


def extract_cover(source: Path, runtime_ticks: int) -> bytes | None:
    duration = runtime_ticks / 10_000_000
    times = dict.fromkeys(
        round(min(duration * 0.9, seconds), 3)
        for seconds in [3, duration * 0.1, duration * 0.25, duration * 0.5, duration * 0.75]
    )
    with tempfile.TemporaryDirectory(prefix="molly-cover-") as temporary:
        for index, seconds in enumerate(times):
            target = Path(temporary) / f"{index}.jpg"
            subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-protocol_whitelist",
                    "file",
                    "-y",
                    "-ss",
                    str(seconds),
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:-2",
                    str(target),
                ],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=60,
                check=True,
            )
            if target.is_file():
                data = target.read_bytes()
                if not is_black_cover(data):
                    return data
    return None
