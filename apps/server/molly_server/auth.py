"""Authentication primitives.

Two token types:
- AccessToken — short-lived (default 1h), HMAC-SHA256-signed, self-contained
  (carries `sub`, `fam`, `role`, `iat`, `exp`). The client should send it
  as `Authorization: Bearer ...` or as `?token=...`. Stateless verification.
- RefreshToken — opaque random 32 bytes, base64url-encoded. Stored SHA-256-hashed
  in the DB with a 30-day expiry. Rotates on every use (returns a new pair).

We use HMAC-SHA256 with a fixed header (`HS256`) and a server-wide key.
A real deployment should pull `MOLLY_AUTH_SECRET` from a secret manager.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import secrets

from .config import get_settings


# ---------------------------------------------------------------------------
# Access token (HMAC)
# ---------------------------------------------------------------------------


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def issue_access_token(*, user_id: str, family_id: str, role: str,
                       device_id: str | None = None) -> tuple[str, dt.datetime]:
    """Return (token, expires_at)."""
    s = get_settings()
    now = dt.datetime.now(dt.timezone.utc)
    exp = now + dt.timedelta(seconds=s.access_token_ttl_seconds)
    header = {"alg": "HS256", "typ": "MOLLY"}
    payload = {
        "sub": user_id,
        "fam": family_id,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    if device_id:
        payload["device"] = device_id
    h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    msg = f"{h}.{p}".encode()
    sig = hmac.new(s.auth_secret.encode("utf-8"), msg, hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url(sig)}", exp


class TokenError(Exception):
    pass


def verify_access_token(token: str) -> dict:
    """Decode and verify signature + expiry. Returns the payload."""
    parts = token.split(".")
    if len(parts) != 3:
        raise TokenError("malformed token")
    h_b64, p_b64, sig_b64 = parts
    msg = f"{h_b64}.{p_b64}".encode()
    s = get_settings()
    expected = hmac.new(s.auth_secret.encode("utf-8"), msg, hashlib.sha256).digest()
    actual = _b64url_decode(sig_b64)
    if not hmac.compare_digest(expected, actual):
        raise TokenError("bad signature")
    try:
        header = json.loads(_b64url_decode(h_b64))
        payload = json.loads(_b64url_decode(p_b64))
    except (json.JSONDecodeError, ValueError) as exc:
        raise TokenError("malformed payload") from exc
    if header.get("alg") != "HS256" or header.get("typ") != "MOLLY":
        raise TokenError("wrong header")
    exp = int(payload.get("exp", 0))
    if exp <= int(dt.datetime.now(dt.timezone.utc).timestamp()):
        raise TokenError("expired")
    return payload


# ---------------------------------------------------------------------------
# Refresh token (opaque)
# ---------------------------------------------------------------------------


def issue_refresh_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hex) for the DB. Caller stores the hash, hands
    the raw token to the client once.
    """
    raw = secrets.token_urlsafe(32)
    h = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return raw, h


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def refresh_token_expiry() -> dt.datetime:
    s = get_settings()
    return dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=s.refresh_token_ttl_seconds)


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------


def hash_password(plain: str) -> str:
    import bcrypt

    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    import bcrypt

    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False
