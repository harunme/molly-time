# ruff: noqa: F811 -- shared isolated fixture
from contextlib import contextmanager
from types import SimpleNamespace

from sqlalchemy import BigInteger, Integer, inspect
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.models import Family


def test_report_indexes_are_added_to_existing_tables_and_repeatable(client):
    engine = db.get_engine()
    names = {
        "items": "ix_item_family_type_parent",
        "media_files": "ix_media_family_kind",
        "upload_sessions": "ix_upload_family_status",
        "watch_sessions": "ix_watch_family_started",
    }
    for table, name in names.items():
        index = next(index for index in db.Base.metadata.tables[table].indexes if index.name == name)
        index.drop(engine)
    db.upgrade_query_schema(engine)
    db.upgrade_query_schema(engine)
    for table, name in names.items():
        assert name in {index["name"] for index in inspect(engine).get_indexes(table)}
    with Session(engine) as session:
        assert session.get(Family, "f1").name == "One"


def test_mysql_counter_upgrade_preserves_defaults_and_runs_once(client, monkeypatch):
    widened = {
        "media_files": {"size_bytes"},
        "upload_sessions": {"size", "offset"},
        "watch_intervals": {"start_ms", "end_ms", "played_ms", "position_ms"},
        "watch_progress": {"position_ms"},
        "device_downloads": {"downloaded_bytes"},
    }
    columns = {
        table.name: [{"name": column.name,
                      "type": Integer() if column.name in widened.get(table.name, set()) else column.type,
                      "nullable": column.nullable,
                      "default": "'0'" if column.name == "offset" else None}
                     for column in table.columns]
        for table in db.Base.metadata.tables.values()
    }

    class Inspector:
        def get_columns(self, table):
            return columns[table]

        def get_indexes(self, table):
            return [{"name": index.name} for index in db.Base.metadata.tables[table].indexes]

    statements = []
    locks = []

    def execute(statement):
        if statement.startswith("SELECT"):
            locks.append(statement)
            return SimpleNamespace(scalar=lambda: 1)
        statements.append(statement)
        words = statement.replace("`", "").split()
        table, name = words[2], words[5]
        next(column for column in columns[table] if column["name"] == name)["type"] = BigInteger()

    dialect = mysql.dialect()
    connection = SimpleNamespace(dialect=dialect, exec_driver_sql=execute)

    @contextmanager
    def begin():
        yield connection

    monkeypatch.setattr(db, "inspect", lambda bind: Inspector())
    engine = SimpleNamespace(dialect=dialect, begin=begin)
    db.upgrade_query_schema(engine)
    db.upgrade_query_schema(engine)
    assert len(statements) == sum(map(len, widened.values()))
    assert "ALTER TABLE `upload_sessions` MODIFY COLUMN `offset` BIGINT NOT NULL DEFAULT '0'" in statements
    assert all("BIGINT NOT NULL" in statement for statement in statements)
    assert len(locks) == 4  # Both startup passes acquire and release the migration lock.
