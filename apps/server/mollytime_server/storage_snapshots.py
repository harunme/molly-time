"""Versioned family storage snapshots; stable reads never walk media files.

Invalidation shares the catalog clock transaction with media/share mutations.
A slow calculation may store an old version, but that version cannot be reused
once a writer has advanced the clock. Expiry also handles time-based share pins
and periodically reconciles files changed outside the application.
"""

import datetime as dt

from sqlalchemy import JSON, DateTime, String, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from .catalog_versions import CatalogVersion, scope
from .db import Base


class FamilyStorageSnapshot(Base):
    __tablename__ = "family_storage_snapshots"
    family_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version: Mapped[str] = mapped_column(String(100))
    totals: Mapped[dict] = mapped_column(JSON)
    valid_until: Mapped[dt.datetime] = mapped_column(DateTime)


def read_snapshots(db, families, now):
    keys = {scope(family, "storage"): family for family in families}
    versions = dict.fromkeys(families, "v1-initial")
    for key, generation, revision in db.execute(select(
        CatalogVersion.scope, CatalogVersion.generation, CatalogVersion.revision,
    ).where(CatalogVersion.scope.in_(keys))):
        versions[keys[key]] = f"v1-{generation}-{revision}"
    found = {}
    for row in db.execute(select(FamilyStorageSnapshot.__table__).where(
        FamilyStorageSnapshot.family_id.in_(families),
    )).mappings():
        if (row["version"] == versions[row["family_id"]]
                and row["valid_until"].replace(tzinfo=dt.UTC) > now):
            found[row["family_id"]] = dict(row["totals"])
    return versions, found


def save_snapshots(bind, rows):
    if not rows:
        return
    # Cache writes must not commit the requesting session's business transaction.
    with Session(bind=bind) as cache:
        table = FamilyStorageSnapshot.__table__
        for row in rows:
            if bind.dialect.name == "sqlite":
                statement = sqlite_insert(table).values(**row)
                statement = statement.on_conflict_do_update(
                    index_elements=[table.c.family_id],
                    set_={key: getattr(statement.excluded, key)
                          for key in ("version", "totals", "valid_until")},
                )
            elif bind.dialect.name == "mysql":
                statement = mysql_insert(table).values(**row)
                statement = statement.on_duplicate_key_update(**{
                    key: getattr(statement.inserted, key)
                    for key in ("version", "totals", "valid_until")
                })
            else:
                raise RuntimeError("Storage snapshots require SQLite or MySQL")
            cache.execute(statement)
        cache.commit()
