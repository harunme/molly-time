"""Runtime configuration via environment variables.

Paths and credential material all default under `MOLLY_DATA_DIR`
(default `.local/molly-server/`) so the service is self-contained.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MOLLY_",
        env_file=".env",
        extra="ignore",
    )

    # ---- Paths ----------------------------------------------------------------
    data_dir: Path = Field(default=Path(".local/molly-server"))
    media_dir: Path | None = None  # defaults to data_dir / "media"
    db_url: str | None = None

    # ---- Network --------------------------------------------------------------
    listen_host: str = "127.0.0.1"
    listen_port: int = 8096
    server_name: str = "Molly Server"
    server_version: str = "0.2.0"
    tv_web_dir: Path = Path(__file__).resolve().parents[2] / "tv-web" / "dist"
    parent_web_dir: Path = Path(__file__).resolve().parents[2] / "parent-web" / "dist"
    media_worker_enabled: bool = True
    max_upload_bytes: int = 10 * 1024**3

    # ---- Auth (HMAC access token + opaque refresh) ---------------------------
    # HMAC secret used to sign short-lived access tokens (JWT-like).
    # Override in production via MOLLY_AUTH_SECRET. The literal "dev-secret-do-not-use-in-prod"
    # is the dev fallback so the service runs without env configuration.
    auth_secret: str = "dev-secret-do-not-use-in-prod"
    access_token_ttl_seconds: int = 60 * 60           # 1h
    refresh_token_ttl_seconds: int = 60 * 60 * 24 * 30  # 30 days

    # ---- Admin bootstrap -------------------------------------------------------
    initial_admin_username: str = "admin"
    initial_admin_password: str = "molly"
    initial_admin_family_name: str = "Default Family"

    # ---- Storage ---------------------------------------------------------------
    storage_backend: str = "local"  # "local" | "oss"

    oss_endpoint: str | None = None
    oss_bucket: str | None = None
    oss_access_key_id: str | None = None
    oss_access_key_secret: str | None = None
    oss_cdn_domain: str | None = None
    oss_signed_url_ttl: int = 60 * 60 * 4

    # ---- Helpers ---------------------------------------------------------------
    def resolved_db_url(self) -> str:
        if self.db_url:
            return self.db_url
        db_path = self.data_dir / "server.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{db_path}"

    def resolved_media_dir(self) -> Path:
        if self.media_dir is not None:
            return self.media_dir
        return self.data_dir / "media"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
        _settings.data_dir.mkdir(parents=True, exist_ok=True)
    return _settings
