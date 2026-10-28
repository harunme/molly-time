"""Runtime configuration via environment variables.

Paths and credential material all default under `MOLLYTIME_DATA_DIR`
(default `.local/molly-server/`) so the service is self-contained.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import AliasChoices, AliasGenerator, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Source checkouts use apps/server/mollytime_server; images use /app/mollytime_server.
_config_parents = Path(__file__).resolve().parents
_project_root = _config_parents[3] if len(_config_parents) > 3 else _config_parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MOLLYTIME_",
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=lambda field: AliasChoices(
                "MOLLYTIME_" + field.upper(),
                "MOLLY_" + field.upper(),
            )
        ),
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
    server_name: str = "MollyTime Server"
    server_version: str = "0.2.0"
    tv_web_dir: Path = Path(__file__).resolve().parents[2] / "tv" / "web" / "dist"
    parent_web_dir: Path = Path(__file__).resolve().parents[2] / "web" / "dist"
    site_web_dir: Path | None = None  # defaults to parent_web_dir / "site"
    media_worker_enabled: bool = True
    max_upload_bytes: int = Field(default=10 * 1024**3, gt=0)
    public_base_url: str = ""  # Phone-accessible server origin for pairing QR links.
    android_build_tools_dir: Path = (
        _project_root / ".local/android-sdk/build-tools/36.0.0"
    )
    android_java_home: Path | None = None  # Optional JRE/JDK location for APK verification.

    # ---- Auth (HMAC access token + opaque refresh) ---------------------------
    # HMAC secret used to sign short-lived access tokens (JWT-like).
    # Override in production via MOLLYTIME_AUTH_SECRET. The literal "dev-secret-do-not-use-in-prod"
    # is the dev fallback so the service runs without env configuration.
    auth_secret: str = "dev-secret-do-not-use-in-prod"
    access_token_ttl_seconds: int = 60 * 60  # 1h
    refresh_token_ttl_seconds: int = 60 * 60 * 24 * 30  # 30 days

    # ---- Admin bootstrap -------------------------------------------------------
    initial_admin_username: str = "admin"
    initial_admin_email: str | None = None
    initial_admin_password: str = "molly"
    initial_admin_family_name: str = "Default Family"

    # ---- Storage ---------------------------------------------------------------
    storage_backend: str = "local"  # "local" | "oss"

    oss_endpoint: str | None = None
    oss_bucket: str | None = None
    oss_access_key_id: str | None = None
    oss_access_key_secret: str | None = None
    oss_internal_endpoint: str | None = None
    oss_cdn_domain: str | None = None  # reserved; never rewrite a signed host
    oss_upload_ttl: int = Field(default=900, ge=60, le=3600)
    upload_expiry_hours: int = Field(default=72, ge=1)
    family_storage_limit_bytes: int = Field(default=0, ge=0)  # 0 = unlimited
    media_processing_max_bytes: int = Field(default=10 * 1024**3, gt=0)
    oss_signed_url_ttl: int = Field(default=3600, ge=60, le=14400)

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
