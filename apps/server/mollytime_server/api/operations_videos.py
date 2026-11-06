"""Read-only, explicitly privileged access to videos across family libraries."""

import datetime as dt
from pathlib import PurePosixPath
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import func, or_, select

from ..accounts import AccountIdentity
from ..deps import DbSession
from ..management_models import MediaOptions, ResourceState, TrashEntry, UploadSession
from ..models import Family, Item, MediaFile, User
from ..share_models import SharedOrigin
from .operations import Operator
from .playback import stream_file

router = APIRouter(prefix="/api/manage/operations/videos", tags=["operations"])


def video_query(db):
    # Keep the file/item ownership invariant even for historical unassigned media.
    return db.query(MediaFile, Item).select_from(MediaFile).join(Item, Item.id == MediaFile.item_id).filter(
        MediaFile.kind == "video", Item.type.in_(["Episode", "Movie"]),
        or_(MediaFile.family_id == Item.family_id,
            MediaFile.family_id.is_(None) & Item.family_id.is_(None)),
    )


def catalog_context(db, items):
    """Load only the page's ancestor chains, in batches, tolerating legacy cycles."""
    catalog = {item.id: item for item in items}
    pending = {item.parent_id for item in items if item.parent_id} - catalog.keys()
    while pending:
        rows = db.query(Item).filter(Item.id.in_(pending)).all()
        catalog.update((item.id, item) for item in rows)
        pending = {item.parent_id for item in rows if item.parent_id} - catalog.keys()
    states = {row.item_id: row for row in db.query(ResourceState).filter(
        ResourceState.item_id.in_(catalog),
    )}
    trash = {row.item_id: row for row in db.query(TrashEntry).filter(
        TrashEntry.item_id.in_(catalog),
    )}
    result = {}
    for item in items:
        chain, seen, current, valid = [], set(), item, True
        while current:
            if current.id in seen or current.family_id != item.family_id:
                valid = False
                break
            seen.add(current.id)
            chain.append(current)
            if current.parent_id and current.parent_id not in catalog:
                valid = False
            current = catalog.get(current.parent_id)
        chain_states = [states[row.id] for row in chain if row.id in states]
        deleting = any(trash[row.id].deleting for row in chain if row.id in trash)
        deleted = any(row.type == "Deleted" for row in chain) or any(
            state.status == "deleted" for state in chain_states
        )
        archived = any(state.status == "archived" for state in chain_states)
        unpublished = any(state.status != "published" or not state.ready for state in chain_states)
        state = "deleted" if deleted else "archived" if archived else "unpublished" if unpublished else "published"
        result[item.id] = {
            "collection": " / ".join(row.name for row in reversed(chain[1:])),
            "status": state,
            "canPreview": valid and not deleting and not deleted,
        }
    return result


@router.get("")
def videos(
    user: Operator, db: DbSession,
    q: str = Query(default="", max_length=254),
    userId: str | None = Query(default=None, max_length=36),
    storage: Literal["", "local", "oss"] = "",
    page: int = Query(default=1, ge=1), pageSize: int = Query(default=20, ge=1, le=100),
):
    query = video_query(db).add_columns(Family, MediaOptions, UploadSession, SharedOrigin).outerjoin(
        Family, Family.id == Item.family_id,
    ).outerjoin(MediaOptions, MediaOptions.media_id == MediaFile.id).outerjoin(
        UploadSession, (UploadSession.id == MediaFile.id)
        & (UploadSession.family_id == Item.family_id),
    ).outerjoin(SharedOrigin, SharedOrigin.item_id == Item.id)
    if userId:
        account = db.get(User, userId)
        if account is None:
            raise HTTPException(404, "用户不存在")
        query = query.filter(Item.family_id == account.family_id)
    if storage:
        query = query.filter(MediaFile.storage == storage)
    if q.strip():
        term = q.strip()
        account_matches = select(User.id).outerjoin(
            AccountIdentity, AccountIdentity.user_id == User.id,
        ).where(User.family_id == Item.family_id, or_(
            User.name.icontains(term, autoescape=True),
            AccountIdentity.email.icontains(term, autoescape=True),
            AccountIdentity.account_id.icontains(term, autoescape=True),
        )).correlate(Item).exists()
        query = query.filter(or_(
            Item.name.icontains(term, autoescape=True),
            MediaOptions.label.icontains(term, autoescape=True),
            UploadSession.filename.icontains(term, autoescape=True),
            MediaFile.path.icontains(term, autoescape=True),
            Family.name.icontains(term, autoescape=True), account_matches,
        ))
    total = query.count()
    rows = query.order_by(
        func.coalesce(UploadSession.created_at, dt.datetime(1970, 1, 1)).desc(),
        MediaFile.id,
    ).offset((page - 1) * pageSize).limit(pageSize).all()
    contexts = catalog_context(db, [row[1] for row in rows])
    family_ids = {row[1].family_id for row in rows if row[1].family_id}
    accounts = {}
    for account, identity in db.query(User, AccountIdentity).outerjoin(
        AccountIdentity, AccountIdentity.user_id == User.id,
    ).filter(User.family_id.in_(family_ids)).order_by(User.created_at, User.id):
        accounts.setdefault(account.family_id, []).append({
            "id": account.id, "name": account.name,
            "email": identity.email if identity else None,
            "accountId": identity.account_id if identity else None,
        })
    return {
        "total": total, "page": page, "pageSize": pageSize,
        "items": [{
            "id": file.id, "itemId": item.id, "name": item.name,
            "filename": options.label if options and options.label else
                upload.filename if upload else PurePosixPath(file.path).name,
            "familyId": item.family_id, "familyName": family.name if family else "未归属家庭",
            "accounts": accounts.get(item.family_id, []),
            "size": file.size_bytes, "runtimeMs": (item.runtime_ticks or 0) // 10000,
            "storage": file.storage, "shared": origin is not None,
            "uploadedAt": upload.created_at.replace(tzinfo=dt.UTC).isoformat() if upload else None,
            **contexts[item.id],
        } for file, item, family, options, upload, origin in rows],
    }


@router.api_route("/{media_id}/play", methods=["GET", "HEAD"])
def preview(media_id: str, request: Request, user: Operator, db: DbSession):
    row = video_query(db).filter(MediaFile.id == media_id).first()
    if row is None:
        raise HTTPException(404, "视频不存在")
    file, item = row
    if not catalog_context(db, [item])[item.id]["canPreview"]:
        raise HTTPException(404, "视频已删除或暂时无法预览")
    # Do not create a viewing session or modify the family's playback progress.
    # OSS delivery remains a signed redirect; bytes do not pass through the API.
    return stream_file(file, request, file.family_id, db=db)
