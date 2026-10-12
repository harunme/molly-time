"""GET /api/families/me/children, POST /api/children/{id}/select."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..deps import CurrentUser, DbSession
from ..models import ChildProfile

router = APIRouter(prefix="/api", tags=["children"])


class ChildDto(BaseModel):
    id: str
    name: str
    avatarUrl: str | None = None


@router.get("/families/me/children", response_model=list[ChildDto])
def list_children(user: CurrentUser, db: DbSession):
    rows = (
        db.query(ChildProfile)
        .filter(ChildProfile.family_id == user.family_id)
        .order_by(ChildProfile.name)
        .all()
    )
    return [
        ChildDto(id=c.id, name=c.name, avatarUrl=c.avatar_path) for c in rows
    ]


class SelectResult(BaseModel):
    ok: bool
    childId: str


@router.post("/children/{child_id}/select", response_model=SelectResult)
def select_child(
    child_id: str, user: CurrentUser, db: DbSession
):
    child = db.get(ChildProfile, child_id)
    if child is None or child.family_id != user.family_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    # P0: we don't mint a child-scoped token yet; the parent token is
    # sufficient. The endpoint just confirms the child belongs to the
    # caller's family. P1 will mint a token with a `child` claim.
    return SelectResult(ok=True, childId=child.id)