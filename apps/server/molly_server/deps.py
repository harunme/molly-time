"""FastAPI dependencies: DB session + current user from access token."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from .auth import TokenError, verify_access_token
from .db import session_scope
from .models import User


def get_db() -> Session:
    yield from session_scope()


DbSession = Annotated[Session, Depends(get_db)]


def _extract_token(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None, alias="token"),
) -> str | None:
    """Accept `Authorization: Bearer <token>` (preferred) or `?token=` query."""
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            return value
    if token:
        return token
    return None


def get_current_user(
    request: Request,
    db: DbSession,
    raw: Annotated[str | None, Depends(_extract_token)],
) -> User:
    if not raw:
        from .manage_auth import get_parent

        user = get_parent(request, db)
        request.state.parent_preview = True
        return user
    try:
        claims = verify_access_token(raw)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    user = db.get(User, user_id)
    if user is None or user.is_disabled:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    if claims.get("device"):
        from .management_models import Device

        device = db.get(Device, claims["device"])
        if (
            device is None
            or device.revoked
            or device.user_id != user.id
            or device.family_id != user.family_id
        ):
            raise HTTPException(401, "设备已撤销")
        request.state.device_id = device.id
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_optional_user(
    db: DbSession,
    raw: Annotated[str | None, Depends(_extract_token)],
) -> User | None:
    if not raw:
        return None
    try:
        claims = verify_access_token(raw)
    except TokenError:
        return None
    user_id = claims.get("sub")
    if not user_id:
        return None
    user = db.get(User, user_id)
    return user if (user and not user.is_disabled) else None


OptionalUser = Annotated[User | None, Depends(get_optional_user)]
