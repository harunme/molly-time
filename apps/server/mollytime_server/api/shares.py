"""Seven-day, multi-household, irrevocable snapshot sharing."""

import datetime as dt
import re
import secrets
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..deps import DbSession
from ..manage_auth import Parent, aware, check_origin, parent_session
from ..management_models import MediaOptions, ResourceState
from ..models import Item, MediaFile
from ..remote_uploads import ensure_capacity
from ..resource_policy import published_episodes, visible
from ..share_models import ContentShare, ShareClaim, SharedOrigin, ShareFile
from ..storage import build_storage
from ..transactions import serialize_sqlite_write
from ..trash import deletion_lock, ensure_active, ensure_idle, family_tree, subtree
from ..usage import family_objects
from .account_invitations import CODE_ALPHABET
from .manage_resources import owned, reminder_resource_ids
from .pairing import digest, limit, public_origin

router = APIRouter(prefix="/api/manage/shares", tags=["content-shares"])
public_router = APIRouter(prefix="/api/shares", tags=["content-shares"])
ITEM_FIELDS = (
    "type",
    "name",
    "sort_name",
    "overview",
    "index_number",
    "parent_index_number",
    "premiere_year",
    "runtime_ticks",
    "community_rating",
    "image_count",
)


class CreateShare(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resourceId: str = Field(min_length=1, max_length=36)


class Credential(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def valid_credential(self):
        self.code = re.sub(r"[\s-]", "", self.code).upper()
        if len(self.code) != 12 or any(c not in CODE_ALPHABET for c in self.code):
            raise ValueError("请输入十二位分享口令")
        return self


class AcceptShare(Credential):
    targetFolderId: str | None = Field(default=None, min_length=1, max_length=36)
    name: str | None = Field(default=None, min_length=1, max_length=256)


def require_admin(user):
    if user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "此操作需要家庭管理员")


def find_share(db, body):
    share = (
        db.query(ContentShare)
        .filter(ContentShare.code_hash == digest(body.code))
        .first()
    )
    if share is None:
        raise HTTPException(404, "分享不存在，请检查链接或口令")
    return share


def claim_for(db, share, family):
    return db.query(ShareClaim).filter_by(share_id=share.id, family_id=family).first()


def usable(share, family):
    if share.family_id == family:
        raise HTTPException(409, "不能领取自己家庭分享的内容")
    if aware(share.expires_at) <= dt.datetime.now(dt.UTC):
        raise HTTPException(410, "分享已过期，请联系分享者重新生成")


def summary(db, share):
    snap = share.snapshot
    images = {file.source_item_id: file.id for file in db.query(ShareFile).filter_by(share_id=share.id).all()
              if file.metadata_.get("kind") == "image"}
    items = {row["id"]: row for row in snap["items"]}

    def cover(row):
        seen = set()
        while row and row["id"] not in seen:
            seen.add(row["id"])
            if row["id"] in images:
                return images[row["id"]]
            row = items.get(row.get("parent_id"))
        return None

    root = items[snap["rootId"]]
    cover_id = cover(root) or next((cover(row) for row in snap["items"] if cover(row)), None)
    return {
        "id": share.id,
        "name": snap["name"],
        "type": snap["type"],
        "videoCount": snap["videoCount"],
        "sizeBytes": snap["sizeBytes"],
        "expiresAt": aware(share.expires_at).isoformat(),
        "imageId": cover_id,
        "overview": root.get("overview") or "",
        "durationMs": sum((row.get("runtime_ticks") or 0) // 10000 for row in snap["items"] if row["type"] == "Episode"),
        "items": [
            {
                "id": row["id"],
                "parentId": row["parent_id"],
                "name": row["name"],
                "type": row["type"],
                "imageId": cover(row) or cover_id,
                "overview": row.get("overview") or "",
                "runtimeMs": (row.get("runtime_ticks") or 0) // 10000,
            }
            for row in snap["items"]
        ],
    }


def build_snapshot(db, user, resource_id, share_id):
    item = owned(db, Item, resource_id, user.family_id)
    ensure_active(db, item)
    if item.type not in ("Episode", "Series") or item.id in reminder_resource_ids(
        db, user.family_id
    ):
        raise HTTPException(422, "只能分享视频或合集，家长提醒素材不能分享")
    keys = subtree(family_tree(db, user.family_id), item.id)
    if db.query(SharedOrigin).filter(SharedOrigin.item_id.in_(keys)).first():
        raise HTTPException(409, "收到的内容暂不支持再次分享")
    ensure_idle(db, keys)
    if not visible(db, item):
        raise HTTPException(409, "请先发布并完成内容处理")
    episodes = published_episodes(db, item.id, user.family_id) if item.type == "Series" else [item]
    episodes = [
        ep
        for ep in episodes
        if db.query(MediaFile.id).filter_by(item_id=ep.id, kind="video").first()
    ]
    if not episodes:
        raise HTTPException(409, "没有已发布且处理完成的视频可分享")
    selected = {item.id: item}
    for ep in episodes:
        selected[ep.id] = ep
        if item.type == "Series" and ep.parent_id != item.id:
            season = owned(db, Item, ep.parent_id, user.family_id)
            selected[season.id] = season
    files = (
        db.query(MediaFile)
        .filter(MediaFile.item_id.in_(selected), MediaFile.kind.in_(["video", "subtitle", "image"]))
        .order_by(MediaFile.id)
        .all()
    )
    if item.type == "Episode" and not any(file.kind == "image" for file in files):
        current, visited = item, set()
        while current.parent_id and current.id not in visited:
            visited.add(current.id)
            current = db.get(Item, current.parent_id)
            if current is None or current.family_id != user.family_id:
                break
            cover = db.query(MediaFile).filter_by(item_id=current.id, kind="image").first()
            if cover:
                files.append(cover)
                break
    rows = [
        {
            **{key: getattr(row, key) for key in ITEM_FIELDS},
            "id": row.id,
            "parent_id": row.parent_id if row.id != item.id else None,
            "primary_image_tag": row.primary_image_tag,
        }
        for row in selected.values()
    ]
    sizes = {}
    descriptors = []
    from ..trash import object_identity

    for file in files:
        size = file.size_bytes
        if file.storage == "local" or size <= 0:
            try:
                size = build_storage(file.storage).size(file.path)
            except (OSError, ValueError):
                raise HTTPException(409, "文件不可用，无法分享")
        sizes[object_identity(file.storage, file.path)] = size
        options = db.get(MediaOptions, file.id)
        metadata = {
            key: getattr(file, key)
            for key in ("kind", "mime", "language", "index", "is_default", "sha256")
        }
        metadata["label"] = options.label if options else Path(file.path).name
        metadata["offset_ms"] = options.offset_ms if options else 0
        descriptors.append(
            ShareFile(
                share_id=share_id,
                source_media_id=file.id,
                source_item_id=file.item_id if file.item_id in selected else item.id,
                storage=file.storage,
                path=file.path,
                size_bytes=size,
                metadata_=metadata,
            )
        )
    if item.type == "Episode":
        inherited = next(
            (file for file in files if file.kind == "image" and file.item_id != item.id), None
        )
        if inherited:
            rows[0]["primary_image_tag"] = inherited.id
    snapshot = {
        "rootId": item.id,
        "name": item.name,
        "type": item.type,
        "videoCount": len(episodes),
        "sizeBytes": sum(sizes.values()),
        "items": rows,
    }
    return snapshot, descriptors


@router.post("/prepare")
def prepare_share(body: CreateShare, request: Request, user: Parent, db: DbSession):
    require_admin(user)
    serialize_sqlite_write(db)
    limit(db, request, "share-prepare", 60, 600, principal=user.id)
    db.rollback()
    with deletion_lock():
        serialize_sqlite_write(db)
        snapshot, _files = build_snapshot(db, user, body.resourceId, "preview")
        return {
            "name": snapshot["name"],
            "videoCount": snapshot["videoCount"],
            "sizeBytes": snapshot["sizeBytes"],
        }


@router.post("")
def create_share(body: CreateShare, request: Request, user: Parent, db: DbSession):
    require_admin(user)
    # Rate limiting commits, so it must precede acquiring the media/deletion lock.
    serialize_sqlite_write(db)
    limit(db, request, "share-create", 30, 600, principal=user.id)
    db.rollback()
    origin = public_origin(request)
    with deletion_lock():
        serialize_sqlite_write(db)
        snapshot, descriptors = build_snapshot(db, user, body.resourceId, str(uuid.uuid4()))
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
        now = dt.datetime.now(dt.UTC)
        share = ContentShare(
            id=descriptors[0].share_id,
            family_id=user.family_id,
            created_by=user.id,
            code_hash=digest(code),
            expires_at=now + dt.timedelta(days=7),
            snapshot=snapshot,
        )
        db.add(share)
        db.flush()
        db.add_all(descriptors)
        db.commit()
        return {
            **summary(db, share),
            "code": code,
            "url": f"{origin}/manage/#/share/{code}",
        }


@public_router.post("/images/{image_id}")
def shared_image(image_id: str, credential: Credential, request: Request, db: DbSession):
    check_origin(request)
    serialize_sqlite_write(db)
    limit(db, request, "share-image", 240, 600)
    share = find_share(db, credential)
    if aware(share.expires_at) <= dt.datetime.now(dt.UTC):
        raise HTTPException(410, "分享已过期")
    file = db.query(ShareFile).filter_by(id=image_id, share_id=share.id).first()
    if not file or file.metadata_.get("kind") != "image":
        raise HTTPException(404, "封面不存在")
    mime = file.metadata_.get("mime")
    if mime not in ("image/jpeg", "image/png", "image/webp"):
        mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(Path(file.path).suffix.lower())
    if mime not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(404, "封面不存在")
    try:
        content = build_storage(file.storage).open(file.path)
    except (OSError, ValueError):
        raise HTTPException(404, "封面不存在")
    return Response(content, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@public_router.post("/preview")
def public_preview(body: Credential, request: Request, db: DbSession):
    # The share credential grants metadata and artwork previews, never video access.
    check_origin(request)
    serialize_sqlite_write(db)
    limit(db, request, "share-public-lookup", 60, 600)
    share = find_share(db, body)
    user = None
    try:
        _session, user = parent_session(request, db)
    except HTTPException as error:
        if error.status_code != 401:
            raise
    claim = claim_for(db, share, user.family_id) if user else None
    if not claim and aware(share.expires_at) <= dt.datetime.now(dt.UTC):
        raise HTTPException(410, "分享已过期，请联系分享者重新生成")
    resource = db.get(Item, claim.resource_id) if claim else None
    return {
        **summary(db, share),
        "claimedResourceId": claim.resource_id if claim else None,
        "claimedDeleted": bool(resource and resource.type == "Deleted"),
        "claimedFolderId": resource.parent_id if resource and resource.type == "Episode" else None,
        "ownShare": bool(user and user.family_id == share.family_id),
    }


@router.post("/preview")
def preview_share(body: Credential, request: Request, user: Parent, db: DbSession):
    require_admin(user)
    serialize_sqlite_write(db)
    limit(db, request, "share-lookup", 60, 600, principal=user.id)
    share = find_share(db, body)
    claim = claim_for(db, share, user.family_id)
    if not claim:
        usable(share, user.family_id)
    return {
        **summary(db, share),
        "claimedResourceId": claim.resource_id if claim else None,
        "claimedDeleted": bool(claim and db.get(Item, claim.resource_id).type == "Deleted"),
    }


def unique_name(db, family, parent, kind, requested):
    existing = {
        name
        for (name,) in db.query(Item.name).filter_by(family_id=family, parent_id=parent, type=kind)
    }
    if requested not in existing:
        return requested
    base = requested[:240] + "（分享）"
    name, index = base, 2
    while name in existing:
        name = f"{base} {index}"
        index += 1
    return name


@router.post("/accept")
def accept_share(body: AcceptShare, request: Request, user: Parent, db: DbSession):
    require_admin(user)
    serialize_sqlite_write(db)
    limit(db, request, "share-accept", 30, 600, principal=user.id)
    db.rollback()
    with deletion_lock():
        serialize_sqlite_write(db)
        share = find_share(db, body)
        claim = claim_for(db, share, user.family_id)
        if claim:
            return {
                "resourceId": claim.resource_id,
                "alreadyClaimed": True,
                "deleted": db.get(Item, claim.resource_id).type == "Deleted",
            }
        usable(share, user.family_id)
        snap = share.snapshot
        folder = None
        if snap["type"] == "Episode":
            if not body.targetFolderId:
                raise HTTPException(422, "请选择接收视频的合集")
            folder = owned(db, Item, body.targetFolderId, user.family_id)
            ensure_active(db, folder)
            if folder.type != "Series" or folder.id in reminder_resource_ids(db, user.family_id):
                raise HTTPException(422, "请选择自己的普通合集")
        files = db.query(ShareFile).filter_by(share_id=share.id).all()
        existing = family_objects(db, user.family_id)
        from ..trash import object_identity

        added = {
            object_identity(file.storage, file.path): file.size_bytes
            for file in files
            if object_identity(file.storage, file.path) not in existing
        }
        ensure_capacity(db, user.family_id, sum(added.values()))
        ids = {row["id"]: str(uuid.uuid4()) for row in snap["items"]}
        media_ids = {file.source_media_id: str(uuid.uuid4()) for file in files}
        # Flush parent rows before children for databases with immediate FK checks.
        pending = list(snap["items"])
        inserted = set()
        while pending:
            ready = [
                row for row in pending if row["parent_id"] is None or row["parent_id"] in inserted
            ]
            if not ready:
                raise HTTPException(409, "分享目录结构无效")
            for row in ready:
                parent = (
                    ids[row["parent_id"]] if row["parent_id"] else (folder.id if folder else None)
                )
                values = {key: row[key] for key in ITEM_FIELDS}
                if row["id"] == snap["rootId"]:
                    requested = body.name.strip() if body.name is not None else row["name"]
                    if not requested:
                        raise HTTPException(422, "名称不能为空")
                    values["name"] = unique_name(db, user.family_id, parent, row["type"], requested)
                db.add(
                    Item(
                        id=ids[row["id"]],
                        family_id=user.family_id,
                        parent_id=parent,
                        primary_image_tag=media_ids.get(row["primary_image_tag"], ""),
                        **values,
                    )
                )
                db.flush()
                db.add(
                    ResourceState(
                        item_id=ids[row["id"]],
                        status="published" if row["type"] == "Season" else "draft",
                        ready=True,
                    )
                )
                db.add(
                    SharedOrigin(
                        item_id=ids[row["id"]], share_id=share.id, source_item_id=row["id"]
                    )
                )
                inserted.add(row["id"])
                pending.remove(row)
        db.flush()
        for file in files:
            metadata = file.metadata_
            db.add(
                MediaFile(
                    id=media_ids[file.source_media_id],
                    family_id=user.family_id,
                    item_id=ids[file.source_item_id],
                    storage=file.storage,
                    path=file.path,
                    size_bytes=file.size_bytes,
                    **{
                        key: metadata[key]
                        for key in ("kind", "mime", "language", "index", "is_default", "sha256")
                    },
                )
            )
        db.flush()
        for file in files:
            db.add(
                MediaOptions(
                    media_id=media_ids[file.source_media_id],
                    retention="backup",
                    label=file.metadata_["label"],
                    offset_ms=file.metadata_["offset_ms"],
                )
            )
        resource_id = ids[snap["rootId"]]
        db.add(
            ShareClaim(
                share_id=share.id,
                family_id=user.family_id,
                claimed_by=user.id,
                resource_id=resource_id,
            )
        )
        db.commit()
        return {"resourceId": resource_id, "alreadyClaimed": False, "deleted": False}
