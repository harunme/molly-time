"""FastAPI application factory + CLI entry."""

from __future__ import annotations

import logging

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from . import manage_auth
from .api import auth as api_auth
from .api import (
    account_invitations,
    catalog,
    children,
    client_release_uploads,
    client_updates,
    downloads,
    manage_client_releases,
    manage_family,
    manage_home,
    manage_overview,
    manage_resources,
    manage_trash,
    operations,
    pairing,
    playback,
    playback_settings,
    reminders,
    usage,
    users,
    watch,
)
from .config import get_settings
from .db import init_db
from .tv_web import TvWebFiles
from .usage_meter import UsageMeter


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="MollyTime Server",
        version=settings.server_version,
        description=(
            "MollyTime media catalog. Own protocol under /api/*. No Jellyfin compatibility."
        ),
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],  # TV page is same-origin; Vite uses a development proxy.
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def private_api(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.add_middleware(UsageMeter)

    @app.on_event("startup")
    def _startup() -> None:
        init_db()
        if settings.media_worker_enabled:
            from .media_worker import start_worker

            app.state.media_worker = start_worker()
        logging.getLogger(__name__).info(
            "mollytime-server %s ready: data=%s media=%s listen=%s:%s",
            settings.server_version,
            settings.data_dir,
            settings.resolved_media_dir(),
            settings.listen_host,
            settings.listen_port,
        )

    @app.on_event("shutdown")
    def _shutdown() -> None:
        worker = getattr(app.state, "media_worker", None)
        if worker:
            worker[0].set()
            worker[1].join(timeout=5)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True, "version": settings.server_version}

    @app.get("/")
    def root() -> dict:
        return {
            "name": settings.server_name,
            "version": settings.server_version,
            "apiBase": "/api",
        }

    app.include_router(api_auth.router)
    app.include_router(account_invitations.router)
    app.include_router(client_updates.router)
    app.include_router(pairing.router)
    app.include_router(users.router)
    app.include_router(children.router)
    app.include_router(catalog.router)
    app.include_router(playback.router)
    app.include_router(playback_settings.router)
    app.include_router(reminders.router)
    app.include_router(manage_auth.router)
    app.include_router(downloads.router)
    app.include_router(manage_resources.router)
    app.include_router(manage_trash.router)
    app.include_router(manage_home.router)
    app.include_router(manage_overview.router)
    app.include_router(manage_family.router)
    app.include_router(operations.router)
    app.include_router(usage.router)
    app.include_router(manage_client_releases.router)
    app.include_router(client_release_uploads.router)
    app.include_router(watch.router)
    if (settings.tv_web_dir / "index.html").is_file():
        app.mount("/tv", TvWebFiles(directory=settings.tv_web_dir, html=True), name="tv-web")
    if (settings.parent_web_dir / "index.html").is_file():
        app.mount(
            "/manage", TvWebFiles(directory=settings.parent_web_dir, html=True), name="parent-web"
        )
    return app


def run() -> None:  # console-script entry
    s = get_settings()
    uvicorn.run(
        "mollytime_server.main:create_app",
        factory=True,
        host=s.listen_host,
        port=s.listen_port,
        log_level="info",
    )


if __name__ == "__main__":
    run()
