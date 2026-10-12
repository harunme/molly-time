"""OSS / S3-compatible storage backend.

P0: stub-only — backend is reserved; no live credentials wired.
`signed_url` returns None unless boto3 + credentials are configured.
"""

from __future__ import annotations

import logging

from .base import StoredObject

logger = logging.getLogger(__name__)


class OssStorage:
    name = "oss"

    def __init__(
        self,
        *,
        endpoint: str | None,
        bucket: str | None,
        access_key_id: str | None,
        access_key_secret: str | None,
        cdn_domain: str | None = None,
    ) -> None:
        self.endpoint = endpoint
        self.bucket = bucket
        self.access_key_id = access_key_id
        self.access_key_secret = access_key_secret
        self.cdn_domain = cdn_domain
        self._client = None

    def _ensure_client(self):
        if self._client is not None:
            return self._client
        if not (self.endpoint and self.bucket and self.access_key_id and self.access_key_secret):
            raise RuntimeError(
                "OSS backend selected but MOLLY_OSS_* credentials are incomplete"
            )
        # Lazy import — keep boto3 optional at test time.
        import boto3  # type: ignore

        self._client = boto3.client(
            "s3",
            endpoint_url=self.endpoint,
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.access_key_secret,
        )
        return self._client

    def resolve(self, key: str) -> StoredObject:
        # HEAD is cheap and gives size/mime; tolerate failure.
        try:
            client = self._ensure_client()
            head = client.head_object(Bucket=self.bucket, Key=key)
            return StoredObject(
                backend=self.name,
                key=key,
                size_bytes=int(head.get("ContentLength", 0)),
                mime=head.get("ContentType", ""),
            )
        except Exception as exc:  # pragma: no cover
            logger.warning("oss head failed for %s: %s", key, exc)
            return StoredObject(backend=self.name, key=key)

    def stream_range(self, key: str, start: int, end: int | None) -> bytes:
        raise NotImplementedError("OSS backend should serve via signed_url, not proxy")

    def size(self, key: str) -> int:
        return self.resolve(key).size_bytes

    def open(self, key: str) -> bytes:
        client = self._ensure_client()
        obj = client.get_object(Bucket=self.bucket, Key=key)
        return obj["Body"].read()

    def signed_url(self, key: str, ttl_seconds: int) -> str | None:
        try:
            client = self._ensure_client()
            url = client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": key},
                ExpiresIn=ttl_seconds,
            )
            if self.cdn_domain:
                # Rewrite host to CDN domain if configured.
                from urllib.parse import urlsplit, urlunsplit

                parts = urlsplit(url)
                return urlunsplit((parts.scheme, self.cdn_domain, parts.path, parts.query, parts.fragment))
            return url
        except Exception as exc:  # pragma: no cover
            logger.warning("oss signed_url failed for %s: %s", key, exc)
            return None