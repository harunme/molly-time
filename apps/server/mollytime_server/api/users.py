"""GET /api/me — current user + family."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..deps import CurrentUser, DbSession
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
def me(user: CurrentUser, db: DbSession):
    fam = db.get(Family, user.family_id)
    return MeResponse(
        user={"id": user.id, "name": user.name, "role": user.role},
        family=FamilyDto(id=user.family_id, name=fam.name if fam else ""),
        role=user.role,
    )