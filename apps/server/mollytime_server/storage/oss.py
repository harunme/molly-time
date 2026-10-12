"""Official OSS transport. Public signing and internal processing are separate."""

from pathlib import Path

from .base import StoredObject


class OssStorage:
    name = "oss"

    def __init__(
        self,
        *,
        endpoint,
        bucket,
        access_key_id,
        access_key_secret,
        internal_endpoint=None,
        cdn_domain=None,
    ):
        self.endpoint = endpoint
        self.internal_endpoint = internal_endpoint or endpoint
        self.bucket = bucket
        self.access_key_id = access_key_id
        self.access_key_secret = access_key_secret
        self._public = None
        self._internal = None

    def _client(self, internal=False):
        attr = "_internal" if internal else "_public"
        client = getattr(self, attr)
        if client is None:
            if not all((self.endpoint, self.bucket, self.access_key_id, self.access_key_secret)):
                raise RuntimeError("OSS configuration is incomplete")
            import oss2

            endpoint = self.internal_endpoint if internal else self.endpoint
            if not endpoint.startswith("https://"):
                raise RuntimeError("OSS endpoints must use HTTPS")
            client = oss2.Bucket(
                oss2.Auth(self.access_key_id, self.access_key_secret),
                endpoint,
                self.bucket,
                connect_timeout=20,
            )
            setattr(self, attr, client)
        return client

    def resolve(self, key):
        head = self._client(True).head_object(key)
        return StoredObject(
            backend="oss",
            key=key,
            size_bytes=head.content_length,
            mime=head.headers.get("Content-Type", "application/octet-stream"),
        )

    def stream_range(self, key, start, end):
        raise NotImplementedError("OSS videos must be delivered through signed URLs")

    def size_if_exists(self, key):
        import oss2

        try:
            return self.size(key)
        except oss2.exceptions.NoSuchKey:
            return None

    def size(self, key):
        return self.resolve(key).size_bytes

    def open(self, key):
        response = self._client(True).get_object(key)
        try:
            return response.read()
        finally:
            response.close()

    def download(self, key, path: Path, expected_size: int):
        """Bounded disk write; reject objects that changed after completion."""
        response = self._client(True).get_object(key)
        try:
            if response.content_length != expected_size:
                raise ValueError("云端文件大小已变化，请重新上传")
            received = 0
            with path.open("wb") as handle:
                while block := response.read(256 * 1024):
                    received += len(block)
                    if received > expected_size:
                        raise ValueError("云端文件超出声明大小")
                    handle.write(block)
            if received != expected_size:
                raise ValueError("云端文件下载不完整")
        finally:
            response.close()

    def put_file(self, key, path, mime):
        self._client(True).put_object_from_file(key, str(path), headers={"Content-Type": mime})

    def signed_url(self, key, ttl_seconds):
        return self._client().sign_url("GET", key, ttl_seconds, slash_safe=True)

    def initiate(self, key):
        mime = {
            ".mp4": "video/mp4",
            ".srt": "application/x-subrip",
            ".vtt": "text/vtt",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(Path(key).suffix.lower(), "application/octet-stream")
        return (
            self._client(True).init_multipart_upload(key, headers={"Content-Type": mime}).upload_id
        )

    def parts(self, key, upload_id):
        import oss2

        return [
            {"number": p.part_number, "size": p.size, "etag": p.etag}
            for p in oss2.PartIterator(self._client(True), key, upload_id)
        ]

    def part_url(self, key, upload_id, number, ttl, md5):
        # Content-MD5 is signed and checked by OSS, preventing accidental corruption.
        headers = {"Content-MD5": md5, "Content-Type": "application/octet-stream"}
        url = self._client().sign_url(
            "PUT",
            key,
            ttl,
            headers=headers,
            params={"uploadId": upload_id, "partNumber": str(number)},
            slash_safe=True,
        )
        return {"url": url, "headers": headers}

    def complete(self, key, upload_id, parts):
        import oss2

        self._client(True).complete_multipart_upload(
            key, upload_id, [oss2.models.PartInfo(p["number"], p["etag"]) for p in parts]
        )

    def abort(self, key, upload_id):
        import oss2

        try:
            self._client(True).abort_multipart_upload(key, upload_id)
        except oss2.exceptions.NoSuchUpload:
            pass

    def delete(self, key):
        self._client(True).delete_object(key)
