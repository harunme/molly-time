"""Copy a consistent MollyTime SQLite snapshot into an empty MySQL database.

Usage: MOLLYTIME_DB_URL=mysql+pymysql://... python tools/migrate_sqlite_to_mysql.py snapshot.db
The source must be a SQLite backup (not a live server.db file). The target must
be empty; this script refuses to append to an existing deployment.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import sys
from pathlib import Path

from sqlalchemy import Boolean, DateTime, JSON, create_engine, func, inspect, select

from mollytime_server import accounts, management_models, models, usage_models  # noqa: F401
from mollytime_server.db import Base


def decode(value, column):
    if value is None:
        return None
    if isinstance(column.type, JSON):
        return json.loads(value)
    if isinstance(column.type, DateTime):
        return dt.datetime.fromisoformat(value)
    if isinstance(column.type, Boolean):
        return bool(value)
    return value


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: migrate_sqlite_to_mysql.py SNAPSHOT.db")
    source_path = Path(sys.argv[1])
    if not source_path.is_file():
        raise SystemExit(f"snapshot does not exist: {source_path}")
    import os

    target_url = os.environ.get("MOLLYTIME_DB_URL", "")
    if not target_url.startswith("mysql+pymysql://"):
        raise SystemExit("MOLLYTIME_DB_URL must be a mysql+pymysql URL")

    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    integrity = source.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"SQLite snapshot integrity check failed: {integrity}")

    engine = create_engine(target_url, future=True)
    existing = set(inspect(engine).get_table_names())
    if existing and existing != set(Base.metadata.tables):
        raise RuntimeError("MySQL target has an unexpected schema")
    Base.metadata.create_all(engine)
    expected: dict[str, int] = {}
    with engine.begin() as target:
        if any(
            target.execute(select(func.count()).select_from(table)).scalar_one()
            for table in Base.metadata.tables.values()
        ):
            raise RuntimeError("MySQL target must contain no rows")
        # Item parent links can point to rows later in the same batch. Validate
        # every foreign key explicitly before committing, then restore checks.
        target.exec_driver_sql("SET FOREIGN_KEY_CHECKS=0")
        try:
            copy_tables(source, target, expected)
            for table in Base.metadata.tables.values():
                for foreign_key in table.foreign_keys:
                    parent = foreign_key.column.table.alias()
                    orphan_count = target.execute(
                        select(func.count())
                        .select_from(
                            table.outerjoin(
                                parent,
                                foreign_key.parent == parent.c[foreign_key.column.name],
                            )
                        )
                        .where(foreign_key.parent.is_not(None))
                        .where(parent.c[foreign_key.column.name].is_(None))
                    ).scalar_one()
                    if orphan_count:
                        raise RuntimeError(
                            f"{table.name}.{foreign_key.parent.name} has "
                            f"{orphan_count} orphan references"
                        )
        finally:
            target.exec_driver_sql("SET FOREIGN_KEY_CHECKS=1")
    source.close()
    engine.dispose()
    print("Migration complete; all table rows and foreign keys verified.")


def copy_tables(source, target, expected: dict[str, int]) -> None:
    for table in Base.metadata.sorted_tables:
        name = table.name
        source_cols = {row[1] for row in source.execute(f'PRAGMA table_info("{name}")')}
        if not source_cols:
            raise RuntimeError(f"source is missing table {name}")
        missing = {column.name for column in table.columns} - source_cols
        if missing:
            raise RuntimeError(f"source table {name} lacks columns: {sorted(missing)}")
        rows = source.execute(f'SELECT * FROM "{name}"').fetchall()
        expected[name] = len(rows)
        columns = {column.name: column for column in table.columns}
        for start in range(0, len(rows), 200):
            batch = [
                {
                    key: decode(value, columns[key])
                    for key, value in dict(row).items()
                    if key in columns
                }
                for row in rows[start : start + 200]
            ]
            target.execute(table.insert(), batch)
        actual = target.execute(select(func.count()).select_from(table)).scalar_one()
        if actual != expected[name]:
            raise RuntimeError(f"row count mismatch in {name}: {actual} != {expected[name]}")
        print(f"{name}: {actual}")


if __name__ == "__main__":
    main()
