# ruff: noqa: F811 -- imported pytest fixtures
import datetime as dt
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from sqlalchemy.orm import Session
from test_management import mp4, native_token, parent  # noqa: F401
from test_remote_storage import remote, start  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db, media_worker
from mollytime_server.management_models import MediaTask, UploadSession
from mollytime_server.models import Item, MediaFile


def probe_result(monkeypatch, *, streams=None, duration="1.25", container="mov,mp4,m4a,3gp,3g2,mj2"):
    data = {
        "streams": streams if streams is not None else [{"codec_type": "video", "codec_name": "hevc"}],
        "format": {"format_name": container, "duration": duration},
    }
    monkeypatch.setattr(media_worker.shutil, "which", lambda tool: tool)
    def run(command, **kwargs):
        payload = ({"streams": [{"codec_type": "video", "nb_read_packets": "1"}]}
                   if "-count_packets" in command else data)
        return subprocess.CompletedProcess(command, 0, json.dumps(payload).encode(), b"")

    monkeypatch.setattr(media_worker.subprocess, "run", run)


@pytest.mark.parametrize("video,audio", [
    ("h264", "aac"), ("hevc", "aac"), ("av1", "opus"), ("mpeg4", "mp3"), ("hevc", None),
])
def test_inspection_does_not_restrict_codecs(monkeypatch, video, audio):
    streams = [{"codec_type": "video", "codec_name": video}]
    if audio:
        streams.append({"codec_type": "audio", "codec_name": audio})
    probe_result(monkeypatch, streams=streams)
    assert media_worker.inspect_video(Path("sample.part")) == 12_500_000


@pytest.mark.parametrize("duration", [None, "N/A", "", "nan", "inf", "-inf", "0", "-1"])
def test_invalid_duration_is_reported_separately(monkeypatch, duration):
    probe_result(monkeypatch, duration=duration)
    with pytest.raises(ValueError, match="有效视频时长"):
        media_worker.inspect_video(Path("sample.part"))


@pytest.mark.parametrize("streams", [
    [], [{"codec_type": "audio", "codec_name": "aac"}],
    [{"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}],
])
def test_missing_video_track_is_reported_separately(monkeypatch, streams):
    probe_result(monkeypatch, streams=streams)
    with pytest.raises(ValueError, match="没有视频轨道"):
        media_worker.inspect_video(Path("sample.part"))


def test_non_mp4_container_is_still_rejected(monkeypatch):
    probe_result(monkeypatch, container="matroska,webm")
    with pytest.raises(ValueError, match="不是 MP4 容器"):
        media_worker.inspect_video(Path("sample.part"))


@pytest.mark.parametrize("error,message", [
    (subprocess.CalledProcessError(1, ["ffprobe"]), "损坏或不完整"),
    (subprocess.TimeoutExpired(["ffprobe"], 45), "检查超时"),
])
def test_probe_failures_have_actionable_errors(monkeypatch, error, message):
    monkeypatch.setattr(media_worker.shutil, "which", lambda tool: tool)

    def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(media_worker.subprocess, "run", fail)
    with pytest.raises(ValueError, match=message):
        media_worker.inspect_video(Path("sample.part"))


def test_truncated_mp4_is_rejected_after_metadata_probe(tmp_path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg/FFprobe required for truncated media verification")
    path = tmp_path / "truncated.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "testsrc2=size=64x64:rate=10:duration=4", "-c:v", "mpeg4",
        "-movflags", "+faststart", str(path),
    ], check=True, capture_output=True, timeout=20)
    data = path.read_bytes()
    path.write_bytes(data[:len(data) // 2])
    with pytest.raises(ValueError, match="视频数据损坏或不完整"):
        media_worker.inspect_video(path)


@pytest.fixture(scope="session", params=[("libx265", "aac"), ("mpeg4", "aac"), ("libx264", "libmp3lame")])
def alternate_mp4(request, tmp_path_factory):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg/FFprobe required for real media ingest verification")
    video, audio = request.param
    encoders = subprocess.run(
        ["ffmpeg", "-v", "error", "-encoders"], capture_output=True, check=True, timeout=10,
    ).stdout.decode()
    if video not in encoders or audio not in encoders:
        pytest.skip(f"FFmpeg encoders {video}/{audio} required")
    path = tmp_path_factory.mktemp("alternate-media") / "sample.mp4"
    command = [
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", video,
        "-pix_fmt", "yuv420p", "-c:a", audio, "-shortest",
    ]
    if video == "libx265":
        command += ["-preset", "ultrafast", "-x265-params", "pools=1:frame-threads=1:log-level=error"]
    subprocess.run(command + [str(path)], capture_output=True, check=True, timeout=30)
    return path.read_bytes()


def complete_local_upload(web, data):
    response = web.post("/api/manage/uploads", json={
        "itemId": "e1", "filename": "sample.mp4", "size": len(data),
        "fingerprint": "alternate-codec", "kind": "video",
    })
    assert response.status_code == 200
    key = response.json()["id"]
    assert web.put(f"/api/manage/uploads/{key}/chunks?offset=0", content=data, headers={
        "X-Chunk-SHA256": hashlib.sha256(data).hexdigest(),
        "Content-Type": "application/octet-stream",
    }).status_code == 200
    assert web.post(f"/api/manage/uploads/{key}/complete").status_code == 200
    return key


@pytest.mark.parametrize("expired", [True, False])
def test_recovery_claims_only_expired_running_tasks(parent, mp4, expired):
    key = complete_local_upload(parent, mp4)
    with Session(db.get_engine()) as session:
        task = session.query(MediaTask).filter_by(upload_id=key).one()
        task.status = "running"
        task.lease_until = dt.datetime.now(dt.UTC) + dt.timedelta(minutes=-1 if expired else 10)
        task.attempts = 1
        session.commit()
    assert media_worker.run_once() is expired
    with Session(db.get_engine()) as session:
        task = session.query(MediaTask).filter_by(upload_id=key).one()
        assert task.status == ("done" if expired else "running")
        assert task.attempts == (2 if expired else 1)
    if expired:
        assert parent.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"


@pytest.mark.parametrize("backend", ["local", "oss"])
def test_real_alternate_codecs_retry_legacy_failure_without_transcoding(remote, alternate_mp4, backend):
    web, oss = remote
    data = alternate_mp4
    if backend == "local":
        config.get_settings().storage_backend = "local"
        key = complete_local_upload(web, data)
    else:
        key, obj = start(web, len(data))
        oss.objects[obj] = data
        assert web.post(f"/api/manage/uploads/{key}/complete", json={"runtimeMs": 1250}).status_code == 200
    # Model an existing upload rejected by the old codec whitelist.
    with Session(db.get_engine()) as session:
        upload = session.get(UploadSession, key)
        task = session.query(MediaTask).filter_by(upload_id=key).one()
        upload.status = task.status = "failed"
        upload.error = task.error = "首版支持 H.264 / AAC 的 MP4 视频；请转换格式后重新上传"
        task_id = task.id
        session.commit()
    assert web.post(f"/api/manage/tasks/{task_id}/retry").status_code == 200
    assert media_worker.run_once()
    upload = web.get(f"/api/manage/uploads/{key}").json()
    assert upload["status"] == "ready" and upload["error"] == ""
    with Session(db.get_engine()) as session:
        file = session.get(MediaFile, key)
        assert file.storage == backend and file.mime == "video/mp4"
        assert file.size_bytes == len(data)
        assert file.sha256 == (hashlib.sha256(data).hexdigest() if backend == "local" else "")
        assert session.get(Item, "e1").runtime_ticks >= 10_000_000
        if backend == "local":
            assert (config.get_settings().resolved_media_dir() / file.path).read_bytes() == data
        else:
            assert oss.objects[file.path] == data
    assert web.post("/api/manage/resources/e1/publish").status_code == 200
    if backend == "local":
        assert web.get("/api/episodes/e1/play", headers=native_token()).content == data
    else:
        assert web.get("/api/episodes/e1/playback").json()["mediaId"] == key
    assert not (config.get_settings().data_dir / "uploads" / f"{key}.part").exists()


@pytest.mark.parametrize("failure", [
    subprocess.CalledProcessError(1, ["ffmpeg"]), subprocess.TimeoutExpired(["ffmpeg"], 60),
])
def test_optional_cover_failure_does_not_block_valid_upload(parent, mp4, monkeypatch, failure):
    def fail(*args):
        raise failure

    monkeypatch.setattr(media_worker, "extract_cover", fail)
    key = complete_local_upload(parent, mp4)
    assert media_worker.run_once()
    assert parent.get(f"/api/manage/uploads/{key}").json()["status"] == "ready"
    with Session(db.get_engine()) as session:
        assert session.get(MediaFile, key).sha256 == hashlib.sha256(mp4).hexdigest()
    assert parent.post("/api/manage/resources/e1/publish").status_code == 200
    assert parent.get("/api/episodes/e1/play", headers=native_token()).content == mp4
