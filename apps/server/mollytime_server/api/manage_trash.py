"""Family recycle bin: parent session, CSRF and administrator checks are shared."""

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from ..deps import DbSession
from ..manage_auth import Parent
from ..management_models import TrashSettings
from ..transactions import serialize_sqlite_write
from ..trash import purge, restore, retention_days, trash_snapshot

router = APIRouter(prefix="/api/manage/trash", tags=["manage-trash"])


@router.get("")
def listing(user: Parent, db: DbSession, page: int = Query(default=1, ge=1),
            pageSize: int = Query(default=20, ge=1, le=100),
            q: str = Query(default="", max_length=256)):
    return trash_snapshot(db, user.family_id, q, page, pageSize)


@router.get("/settings")
def settings(user: Parent, db: DbSession):
    return {"retentionDays": retention_days(db, user.family_id)}


class PolicyBody(BaseModel):
    retentionDays: int = Field(ge=0, le=365, strict=True)


@router.put("/settings")
def update_settings(body: PolicyBody, user: Parent, db: DbSession):
    serialize_sqlite_write(db)
    row = db.get(TrashSettings, user.family_id)
    if row is None:
        row = TrashSettings(family_id=user.family_id)
        db.add(row)
    row.retention_days = body.retentionDays
    db.commit()
    return {"retentionDays": row.retention_days}


@router.post("/{item_id}/restore")
def restore_item(item_id: str, user: Parent, db: DbSession):
    return restore(db, item_id, user.family_id)


@router.delete("/{item_id}")
def delete_item(item_id: str, user: Parent):
    purge(item_id, user.family_id)
    return {"ok": True}
