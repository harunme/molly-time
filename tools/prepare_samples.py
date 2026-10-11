#!/usr/bin/env python3
"""Generate ignored preview assets from existing local media; never edit source files."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def display_name(value):
    return re.sub(r"\s*\[\d+\]$", "", value)


def valid_video(path):
    """Read the packet table; ffprobe can exit zero even for truncated MP4s."""
    result = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "packet=pts_time,duration_time",
        "-of", "json", str(path),
    ], capture_output=True, text=True, timeout=60)
    if result.returncode or result.stderr.strip():
        print(f"Skipping unreadable/incomplete video: {path}")
        return False
    return bool(json.loads(result.stdout).get("packets"))


def prepare(source, output, limit):
    if shutil.which("ffprobe") is None:
        raise RuntimeError("ffprobe is required to check preview files (brew install ffmpeg)")
    candidates = sorted(source.rglob("*.mp4"), key=lambda p: (p.stat().st_size, str(p)))
    checked = {}
    def valid(path):
        if path not in checked:
            checked[path] = valid_video(path)
        return checked[path]
    videos = []
    for candidate in candidates:
        if valid(candidate):
            videos.append(candidate)
        if len(videos) >= limit:
            break
    if not videos:
        raise ValueError(f"No MP4 files in {source}")
    # Preserve all subtitle tracks rather than guessing between languages.
    if not any(list(v.parent.glob("*.srt")) for v in videos):
        subtitled = next((v for v in candidates if list(v.parent.glob("*.srt")) and valid(v)), None)
        if subtitled is not None:
            videos[-1] = subtitled
    output.mkdir(parents=True, exist_ok=True)
    # The output directory is exclusively generated preview assets, not source media.
    previous = output / "catalog.json"
    previous_assets = set()
    if previous.exists():
        previous_assets = {item[key] for item in json.loads(previous.read_text())["episodes"]
                           for key in ("video", "subtitle") if key in item}
        previous_assets |= {subtitle["path"] for item in json.loads(previous.read_text())["episodes"]
                            for subtitle in item.get("subtitles", [])}
    episodes = []
    for video in videos:
        relative = video.relative_to(source)
        key = hashlib.sha256(relative.as_posix().encode()).hexdigest()[:24]
        video_name = f"{key}.mp4"
        shutil.copy2(video, output / video_name)
        item = {"id": key, "title": display_name(video.parent.name),
                "category": display_name(relative.parts[0]),
                "series": display_name(relative.parts[1]) if len(relative.parts) > 2 else "本地视频",
                "video": video_name}
        subtitles = sorted(video.parent.glob("*.srt"))
        item["subtitles"] = []
        for index, subtitle in enumerate(subtitles):
            name = f"{key}-{index}.srt"
            shutil.copy2(subtitle, output / name)
            item["subtitles"].append({"path": name, "label": subtitle.stem,
                                     "language": "en" if subtitle.stem == "英文字幕" else "und"})
        episodes.append(item)
    (output / "catalog.json").write_text(json.dumps({"schema_version": 1, "episodes": episodes},
                                                ensure_ascii=False, indent=2), encoding="utf-8")
    current_assets = {item["video"] for item in episodes} | {
        subtitle["path"] for item in episodes for subtitle in item["subtitles"]}
    for name in previous_assets - current_assets:
        if re.fullmatch(r"[0-9a-f]{24}(?:-\d+)?\.(mp4|srt)", name):
            (output / name).unlink(missing_ok=True)
    return episodes


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "downloads/bbkt")
    parser.add_argument("--output", type=Path, default=ROOT / "apps/tv/app/src/main/assets/molly")
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    for episode in prepare(args.source.resolve(), args.output.resolve(), args.limit):
        print(f"Prepared: {episode['series']} / {episode['title']}")
