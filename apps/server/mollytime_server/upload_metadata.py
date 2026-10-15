"""Bounded, uploader-supplied video metadata; never proof of video integrity."""

import base64
import io
import json

from PIL import Image
from pydantic import BaseModel, Field

from .config import get_settings
from .utils.image import atomic_write

MAX_METADATA_BYTES = 360_000


class VideoMetadata(BaseModel):
    runtimeMs: int = Field(strict=True, gt=0, le=(2**63 - 1) // 10000)
    cover: str | None = Field(default=None, max_length=350_000)

    def cover_bytes(self) -> bytes | None:
        if self.cover is None:
            return None
        prefix = "data:image/jpeg;base64,"
        if not self.cover.startswith(prefix):
            raise ValueError("视频封面必须是 JPEG 图片")
        try:
            data = base64.b64decode(self.cover[len(prefix):], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "JPEG" or not (0 < image.width <= 640 and 0 < image.height <= 360):
                    raise ValueError("视频封面不能超过 640×360")
                image.verify()
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            raise ValueError("视频封面无效，请重新选择视频后重试") from error
        return data


def metadata_path(upload_id: str):
    return get_settings().data_dir / "uploads" / f"{upload_id}.video.json"


def save_metadata(upload_id: str, data: VideoMetadata) -> None:
    data.cover_bytes()  # Validate optional artwork before making a task runnable.
    path = metadata_path(upload_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, data.model_dump_json().encode())


def read_metadata(upload_id: str) -> VideoMetadata:
    path = metadata_path(upload_id)
    if not path.is_file():
        raise ValueError("缺少视频时长，请重新选择原视频上传")
    with path.open("rb") as handle:
        content = handle.read(MAX_METADATA_BYTES + 1)
    if len(content) > MAX_METADATA_BYTES:
        raise ValueError("视频信息过大，请重新上传")
    try:
        return VideoMetadata.model_validate(json.loads(content))
    except (ValueError, UnicodeError) as error:
        raise ValueError("视频信息无效，请重新上传") from error
