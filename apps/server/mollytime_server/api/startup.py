"""Public boot metadata is available before a TV is paired; writes require an operator."""
import base64
import re

from fastapi import APIRouter, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from .. import startup_sound
from ..deps import DbSession
from ..transactions import external_io
from .operations import Operator

router = APIRouter(tags=["startup"])


@router.get("/api/startup")
def startup_config():
    return startup_sound.public_config()


@router.get("/api/startup/audio/{version}")
def startup_audio(version: str):
    if not re.fullmatch(r"[0-9a-f]{64}", version):
        raise HTTPException(404)
    record = startup_sound.read_record()
    if record.get("version") != version:
        raise HTTPException(404)
    return Response(base64.b64decode(record["data"]), media_type="audio/mpeg",
                    headers={"X-Content-Type-Options": "nosniff"})


@router.get("/api/manage/operations/startup-sound")
def manage_startup(user: Operator, db: DbSession):
    with external_io(db):
        return startup_sound.public_config()


@router.put("/api/manage/operations/startup-sound")
async def upload_sound(request: Request, user: Operator, db: DbSession,
                       filename: str = Query(max_length=200)):
    with external_io(db):
        pass
    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > startup_sound.MAX_UPLOAD:
            raise HTTPException(413, "请选择不超过 5 MB 的音频")
        payload.extend(chunk)
    return await run_in_threadpool(startup_sound.save, bytes(payload), filename)


@router.delete("/api/manage/operations/startup-sound")
def delete_sound(user: Operator, db: DbSession):
    with external_io(db):
        return startup_sound.remove()
