from collections import Counter
from types import SimpleNamespace
from unittest.mock import Mock

import oss2
import pytest

from mollytime_server.storage import oss


@pytest.fixture
def storage(monkeypatch):
    storage = oss.OssStorage(
        endpoint="https://oss.example",
        bucket="test",
        access_key_id="id",
        access_key_secret="secret",
    )
    monkeypatch.setattr(oss.time, "sleep", Mock())
    return storage


def test_large_upload_resumes_completed_parts_after_write_timeout(storage, tmp_path):
    path = tmp_path / "release.apk"
    data = b"apk-data" * (1024 * 1024)
    path.write_bytes(data)
    sent = Counter()
    parts = {}
    uploads = []
    completed = []

    class Bucket:
        bucket_name = "test"

        def init_multipart_upload(self, key, headers, params):
            uploads.append((key, headers))
            return SimpleNamespace(upload_id="upload-1")

        def list_parts(self, key, upload_id, **kwargs):
            assert upload_id == "upload-1"
            return SimpleNamespace(
                parts=[
                    oss2.models.PartInfo(number, str(number), size=len(content))
                    for number, content in sorted(parts.items())
                ],
                is_truncated=False,
                next_marker="",
            )

        def upload_part(self, key, upload_id, number, content, **kwargs):
            sent[number] += 1
            if number == 2 and sent[number] == 1:
                raise oss2.exceptions.RequestError(TimeoutError("The write operation timed out"))
            parts[number] = content.read()
            return SimpleNamespace(etag=str(number), crc=None)

        def complete_multipart_upload(self, key, upload_id, finished, **kwargs):
            completed.append(
                b"".join(
                    parts[p.part_number] for p in sorted(finished, key=lambda p: p.part_number)
                )
            )

    storage._internal = Bucket()
    storage.put_file("releases/test.apk", path, "application/vnd.android.package-archive")

    assert completed == [data]
    assert uploads == [
        ("releases/test.apk", {"Content-Type": "application/vnd.android.package-archive"})
    ]
    assert sent[2] == 2
    assert all(count == 1 for number, count in sent.items() if number != 2)
    oss.time.sleep.assert_called_once_with(2)


def test_small_upload_reopens_file_on_retry(storage, tmp_path):
    path = tmp_path / "cover.jpg"
    path.write_bytes(b"cover")
    received = []

    def put(key, content, **kwargs):
        received.append(content.read())
        if len(received) == 1:
            raise oss2.exceptions.RequestError(TimeoutError("write timed out"))
        assert kwargs["headers"] == {"Content-Type": "image/jpeg"}

    storage._internal = SimpleNamespace(bucket_name="test", put_object=put)
    storage.put_file("cover.jpg", path, "image/jpeg")
    assert received == [b"cover", b"cover"]


@pytest.mark.parametrize("status, attempts", [(403, 1), (400, 1), (408, 3), (429, 3), (503, 3)])
def test_server_errors_are_retried_only_when_transient(storage, tmp_path, status, attempts):
    path = tmp_path / "release.apk"
    path.write_bytes(b"apk")
    error = oss2.exceptions.ServerError(status, {}, b"", {})
    put = Mock(side_effect=error)
    storage._internal = SimpleNamespace(bucket_name="test", put_object=put)

    with pytest.raises(oss2.exceptions.ServerError) as caught:
        storage.put_file("release.apk", path, "application/vnd.android.package-archive")

    assert caught.value is error
    assert put.call_count == attempts
    assert oss.time.sleep.call_count == attempts - 1


def test_network_retries_are_bounded(storage, tmp_path):
    path = tmp_path / "release.apk"
    path.write_bytes(b"apk")
    error = oss2.exceptions.RequestError(TimeoutError("write timed out"))
    put = Mock(side_effect=error)
    storage._internal = SimpleNamespace(bucket_name="test", put_object=put)

    with pytest.raises(oss2.exceptions.RequestError) as caught:
        storage.put_file("release.apk", path, "application/vnd.android.package-archive")

    assert caught.value is error
    assert put.call_count == 3
    assert [call.args for call in oss.time.sleep.call_args_list] == [(2,), (4,)]
