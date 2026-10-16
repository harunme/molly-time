"""Family usage: own-family reads and superadmin reports/export."""

import csv
import io

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from ..accounts import AccountIdentity
from ..db import get_session_factory
from ..deps import DbSession
from ..manage_auth import Parent
from ..models import Family, User
from ..transactions import external_io
from ..usage import family_usage, month_bounds
from .operations import Operator

router = APIRouter(prefix="/api/manage", tags=["family-usage"])


@router.get("/usage")
def own_usage(user: Parent, db: DbSession, month: str | None = None):
    return family_usage(db, [db.get(Family, user.family_id)], month)[0]


def family_query(db, q):
    query = db.query(Family)
    if q.strip():
        pattern = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        matching_account = db.query(User.id).outerjoin(
            AccountIdentity, AccountIdentity.user_id == User.id,
        ).filter(User.family_id == Family.id, (
            AccountIdentity.account_id.ilike(pattern, escape="\\")
            | AccountIdentity.email.ilike(pattern, escape="\\")
        )).exists()
        query = query.filter(Family.name.ilike(pattern, escape="\\")
                             | Family.id.ilike(pattern, escape="\\") | matching_account)
    return query.order_by(Family.created_at, Family.id)


@router.get("/operations/usage")
def all_usage(
    user: Operator, db: DbSession, month: str | None = None,
    q: str = Query(default="", max_length=254),
    page: int = Query(default=1, ge=1), pageSize: int = Query(default=20, ge=1, le=100),
):
    month, _, _ = month_bounds(month)
    query = family_query(db, q)
    total = query.order_by(None).count()
    rows = query.offset((page - 1) * pageSize).limit(pageSize).all()
    return {"items": family_usage(db, rows, month), "total": total,
            "page": page, "pageSize": pageSize, "month": month, "timezone": "Asia/Shanghai"}


@router.get("/operations/usage/export")
def export_usage(user: Operator, db: DbSession, month: str | None = None,
                 q: str = Query(default="", max_length=254)):
    month, _, _ = month_bounds(month)
    with external_io(db):
        pass

    def rows():
        # Independent session for StreamingResponse; export every matching family.
        with get_session_factory()() as session:
            buffer = io.StringIO()
            writer = csv.writer(buffer)

            def emit(values):
                buffer.seek(0)
                buffer.truncate()
                writer.writerow(values)
                return buffer.getvalue()

            yield "\ufeff" + emit(["month", "timezone", "family_id", "family_name", "accounts",
                                   "storage_bytes_current", "local_storage_bytes_current",
                                   "oss_storage_bytes_current", "pending_upload_bytes_current",
                                   "unknown_size_objects", "local_egress_bytes", "oss_egress_bytes",
                                   "total_egress_bytes", "last_oss_import_at"])
            query = family_query(session, q)
            offset = 0
            while families := query.offset(offset).limit(100).all():
                page = family_usage(session, families, month)
                with external_io(session):
                    pass
                for row in page:
                    s, t = row["storage"], row["traffic"]
                    # Prevent spreadsheet formula execution from user-controlled names.
                    name = row["name"]
                    if name.lstrip().startswith(("=", "+", "-", "@")):
                        name = "'" + name
                    yield emit([month, row["timezone"], row["id"], name, row["accountCount"],
                                s["usedBytes"], s["localBytes"], s["ossBytes"], s["pendingBytes"],
                                s["unknownSizeCount"], t["localBytes"], t["ossBytes"],
                                t["totalBytes"], t["lastOssImportAt"] or ""])
                offset += len(families)

    return StreamingResponse(rows(), media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="family-usage-{month}.csv"',
    })
