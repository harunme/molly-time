"""Count media response bodies after ASGI sends, including partial streams."""

import asyncio
import datetime as dt
import logging

from .db import get_session_factory
from .usage_models import TrafficEvent

logger = logging.getLogger(__name__)


def meter_media(request, family_id):
    request.state.usage_family_id = family_id


def record_local(family_id, occurred_at, count):
    with get_session_factory()() as db:
        db.add(TrafficEvent(family_id=family_id, source="local",
                            occurred_at=occurred_at, bytes_sent=count))
        db.commit()


class UsageMeter:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "GET":
            return await self.app(scope, receive, send)
        started, count, status = dt.datetime.now(dt.UTC), 0, 0

        async def metered_send(message):
            nonlocal count, status
            await send(message)
            if message["type"] == "http.response.start":
                status = message["status"]
            elif message["type"] == "http.response.body" and status in (200, 206):
                count += len(message.get("body", b""))

        try:
            await self.app(scope, receive, metered_send)
        finally:
            family = scope.get("state", {}).get("usage_family_id")
            if family and count:
                try:
                    # Own session: streaming may outlive the endpoint's database dependency.
                    await asyncio.shield(asyncio.to_thread(record_local, family, started, count))
                except Exception:
                    logger.exception("Failed to persist media egress for family %s", family)
