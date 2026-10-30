# ruff: noqa: F401, F811 -- shared isolated fixtures
import datetime as dt
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlsplit

import pytest
from sqlalchemy.orm import Session
from test_management import parent
from test_operations import operator
from test_tv_playback import client

from mollytime_server import config, db
from mollytime_server.oss_usage import attribution, import_log, media_url, parse_line, sync_once
from mollytime_server.usage_models import OssLogImport, OssLogRequest, TrafficEvent


def log(request_id="req-1", *, family="f1", key="families/f1/a space.mp4", size=108,
        status=206, operation="GetObject", bucket="media", internal=False, cdn=False,
        when="01/Nov/2026:00:00:01 +0800", token=None):
    from urllib.parse import quote
    marker = token if token is not None else attribution(family, key)
    host = "media.oss-cn-hangzhou-internal.aliyuncs.com" if internal else "media.oss-cn-hangzhou.aliyuncs.com"
    return (f'1.2.3.4 - - [{when}] "GET /{quote(key)}?x-molly-usage={marker} HTTP/1.1" '
            f'{status} {size} 1 "-" "TV player" "{host}" "{request_id}" "true" "owner" '
            f'"{operation}" "{bucket}" "{quote(key)}" 999 1 "-" 10 "owner" - '
            f'"{"cdn" if cdn else "-"}" "Standard" "-" "-" "key" "arn" "new-field"')


def test_actual_range_bytes_month_boundary_and_duplicate_logs(operator):
    records = [log(), log("req-2", size=21, when="31/Oct/2026:23:59:59 +0800")]
    assert import_log(records, "media", "file1") == 2
    assert import_log(records, "media", "file1") == 0
    assert import_log(records, "media", "file2") == 0
    october = operator.get("/api/manage/usage?month=2026-10").json()
    november = operator.get("/api/manage/usage?month=2026-11").json()
    assert october["traffic"]["ossBytes"] == 21
    assert november["traffic"]["ossBytes"] == 108
    assert november["traffic"]["totalBytes"] == 108
    assert november["traffic"]["lastOssImportAt"]
    assert november["ossSync"]["enabled"] is False
    with Session(db.get_engine()) as session:
        assert session.query(OssLogRequest).count() == 2
        assert session.query(TrafficEvent).count() == 2


def test_shared_object_charged_to_viewing_family_not_path_owner(operator):
    import_log([log(family="f2", key="families/f1/shared.mp4")], "media")
    report = operator.get("/api/manage/operations/usage?month=2026-11").json()
    assert {row["id"]: row["traffic"]["ossBytes"] for row in report["items"]} == {"f1": 0, "f2": 108}


def test_invalid_missing_or_other_object_marker_is_unattributed(operator):
    records = [log("bad", token="f1." + "0" * 64), log("missing", token=""),
               log("wrong-object", token=attribution("f1", "other.mp4")),
               log("deleted-family", family="missing")]
    import_log(records, "media")
    summary = operator.get("/api/manage/operations/usage/oss?month=2026-11").json()
    assert summary["publicBytes"] == summary["unattributedBytes"] == 432
    assert operator.get("/api/manage/usage?month=2026-11").json()["traffic"]["ossBytes"] == 0


@pytest.mark.parametrize("overrides", [{"status": 403}, {"status": 304}, {"size": 0},
    {"operation": "HeadObject"}, {"operation": "PutObject"}, {"bucket": "other"},
    {"internal": True}, {"cdn": True}])
def test_non_public_downloads_not_counted(operator, overrides):
    assert import_log([log(**overrides)], "media") == 0


def test_malformed_log_rolls_back_all_bytes_and_checkpoint(operator):
    with pytest.raises(ValueError):
        import_log([log(), "malformed"], "media", "bad-file")
    with Session(db.get_engine()) as session:
        assert session.query(OssLogRequest).count() == 0
        assert session.query(TrafficEvent).count() == 0
        assert session.get(OssLogImport, "bad-file") is None
    assert import_log([log()], "media", "bad-file") == 1


def test_url_marker_uses_consumer_and_preserves_signature():
    storage = Mock()
    storage.signed_url.return_value = "https://media/object?Signature=secret&Expires=123"
    url = media_url(storage, "object", 900, "f2")
    assert url.startswith(storage.signed_url.return_value + "&x-molly-usage=")
    storage.signed_url.assert_called_once_with("object", 900)
    parsed = parse_line(log(family="f2", key="object"), "media")
    assert parsed[1] == "f2"
    assert urlsplit(url).hostname == "media"


def test_summary_permissions_and_month_validation(parent):
    assert parent.get("/api/manage/operations/usage/oss").status_code == 403


def test_automatic_sync_rechecks_late_logs_and_skips_imported_objects(operator, monkeypatch):
    import io

    import oss2

    from mollytime_server import oss_usage
    settings = config.get_settings()
    monkeypatch.setattr(settings, "oss_log_bucket", "access-logs")
    monkeypatch.setattr(settings, "oss_log_lookback_days", 3)
    monkeypatch.setattr(oss_usage, "get_storage_settings", lambda: SimpleNamespace(
        oss_internal_endpoint="https://oss-cn-hangzhou-internal.aliyuncs.com",
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com", oss_bucket="media",
        oss_access_key_id="id", oss_access_key_secret="secret"))
    client = Mock()
    client.get_object.side_effect = lambda key: io.BytesIO(log().encode())
    monkeypatch.setattr(oss2, "Bucket", lambda *args, **kwargs: client)
    today = dt.datetime.now(dt.UTC).date()
    seen = []
    def objects(client, prefix):
        seen.append(prefix)
        return [SimpleNamespace(key=prefix + "00-00-00-unique", etag="etag")]
    monkeypatch.setattr(oss2, "ObjectIterator", objects)
    sync_once()
    sync_once()
    assert len(seen) == 6
    assert seen[2] == f"molly-access/media{today - dt.timedelta(days=2):%Y-%m-%d}-"
    assert client.get_object.call_count == 3
    with Session(db.get_engine()) as session:
        assert session.query(OssLogRequest).count() == 1
        assert session.query(OssLogImport).count() == 3
    summary = operator.get("/api/manage/operations/usage/oss?month=2026-11").json()
    assert summary["sync"]["enabled"] is True
    assert summary["sync"]["lastSuccessAt"]
