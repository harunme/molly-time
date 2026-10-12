"""Serve independently deployable TV assets; HTML never uses stale cache."""

from fastapi.staticfiles import StaticFiles


class TvWebFiles(StaticFiles):
    async def get_response(self, path, scope):
        # No SPA catch-all is needed: navigation is inside the application.
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-store"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' blob:; connect-src 'self'; media-src 'self' https:; frame-src 'none'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        return response
