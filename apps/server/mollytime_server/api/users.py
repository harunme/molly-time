"""GET /api/me — current user + family."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..accounts import account_dto
from ..deps import CurrentUser, DbSession
from ..device_presence import touch_device
from ..models import Family

router = APIRouter(prefix="/api", tags=["users"])


class FamilyDto(BaseModel):
    id: str
    name: str


class MeResponse(BaseModel):
    user: dict
    family: FamilyDto
    role: str


@router.get("/me", response_model=MeResponse)
def me(request: Request, user: CurrentUser, db: DbSession):
    device_id = getattr(request.state, "device_id", None)
    if device_id:
        touch_device(db, device_id)
    fam = db.get(Family, user.family_id)
    return MeResponse(
        user=account_dto(db, user),
        family=FamilyDto(id=user.family_id, name=fam.name if fam else ""),
        role=user.role,
    )
