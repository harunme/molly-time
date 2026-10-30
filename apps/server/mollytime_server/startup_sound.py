"""Small, public launch sound; one atomic file keeps audio and metadata consistent."""
import base64
import hashlib
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import HTTPException

from .config import get_settings

MAX_UPLOAD = 5 * 1024 * 1024
MAX_SECONDS = 5


def _path():
    return get_settings().data_dir / "startup-sound.json"


def read_record():
    path = _path()
    return json.loads(path.read_text()) if path.exists() else {}


def public_config(record=None):
    record = read_record() if record is None else record
    if not record:
        return {"configured": False, "filename": "", "durationMs": 0, "version": "", "audioUrl": None}
    return {"configured": True, **{key: record[key] for key in ("filename", "durationMs", "version")},
            "audioUrl": f'/api/startup/audio/{record["version"]}'}


def _write(record):
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".startup-sound-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(record, out, ensure_ascii=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def remove():
    _write({})
    return public_config({})


def save(payload: bytes, filename: str):
    if not payload or len(payload) > MAX_UPLOAD:
        raise HTTPException(413, "请选择不超过 5 MB 的音频")
    # Restrict to self-contained audio containers; never let a playlist direct
    # ffmpeg to server-local files or network resources.
    supported = (payload.startswith((b"ID3", b"OggS"))
                 or (payload[:4] == b"RIFF" and payload[8:12] == b"WAVE")
                 or payload[4:8] == b"ftyp"
                 or (len(payload) > 1 and payload[0] == 0xFF
                     and payload[1] & 0xE0 == 0xE0 and payload[1] & 0x06 != 0))
    if not supported:
        raise HTTPException(422, "请选择有效的 MP3、WAV、M4A 或 OGG 音频")
    with tempfile.TemporaryDirectory(prefix="molly-startup-") as temp:
        source, target = Path(temp) / "input", Path(temp) / "sound.mp3"
        source.write_bytes(payload)
        try:
            probe = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                                    "-show_format", "-show_streams", "-of", "json", str(source)],
                                   capture_output=True, check=True, timeout=10)
            info = json.loads(probe.stdout)
            streams = info.get("streams", [])
            duration = float(info.get("format", {}).get("duration", 0))
            if (not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS
                    or not any(s.get("codec_type") == "audio" for s in streams)
                    or any(s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic") for s in streams)):
                raise ValueError("invalid launch audio")
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                            "-i", str(source), "-map", "0:a:0", "-vn", "-t", str(MAX_SECONDS),
                            "-ac", "2", "-ar", "44100", "-codec:a", "libmp3lame", "-b:a", "96k", str(target)],
                           capture_output=True, check=True, timeout=15)
            audio = target.read_bytes()
        except (ValueError, KeyError, subprocess.SubprocessError) as exc:
            raise HTTPException(422, "请选择 5 秒以内的有效音频（MP3、WAV、M4A 或 OGG）") from exc
        except FileNotFoundError as exc:
            raise HTTPException(503, "音频处理服务暂不可用") from exc
    record = {"filename": Path(filename.replace("\\", "/")).name[:160] or "启动音效",
              "durationMs": round(duration * 1000), "version": hashlib.sha256(audio).hexdigest(),
              "data": base64.b64encode(audio).decode()}
    _write(record)
    return public_config(record)
