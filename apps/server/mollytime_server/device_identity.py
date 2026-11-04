"""Stable installation identity and revocable, family-scoped authorization."""
import hashlib
import secrets
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError

from .management_models import Device, DeviceIdentity, DeviceIdentityBinding, DeviceAuthorizationVersion, DeviceRefresh
from .models import RefreshToken


class IdentityProof(BaseModel):
    id: str = Field(min_length=36, max_length=36)
    secret: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$", repr=False)

    @field_validator("id")
    @classmethod
    def valid_id(cls, value):
        return str(UUID(value))


def authenticate_identity(db, proof):
    digest = hashlib.sha256(proof.secret.encode()).hexdigest()
    identity = db.query(DeviceIdentity).filter_by(id=proof.id).with_for_update().first()
    if identity is None:
        try:
            with db.begin_nested():
                db.add(DeviceIdentity(id=proof.id, secret_hash=digest))
                db.flush()
        except IntegrityError:
            pass  # A concurrent start may have registered this identity.
        identity = db.query(DeviceIdentity).filter_by(id=proof.id).with_for_update().one()
    if not secrets.compare_digest(identity.secret_hash, digest):
        raise HTTPException(401, "设备身份验证失败")
    return identity


def authorization_version(db, device_id, *, locked=False):
    row = (db.query(DeviceAuthorizationVersion).filter_by(device_id=device_id).populate_existing().with_for_update().first()
           if locked else db.get(DeviceAuthorizationVersion, device_id))
    return row.version if row else 0


def revoke_binding(db, device):
    version = db.get(DeviceAuthorizationVersion, device.id)
    if version is None:
        version = DeviceAuthorizationVersion(device_id=device.id, version=0)
        db.add(version)
    version.version += 1
    device.revoked = True
    for link in db.query(DeviceRefresh).filter_by(device_id=device.id).all():
        token = db.get(RefreshToken, link.token_id)
        db.delete(link)
        if token is not None:
            db.delete(token)
    db.flush()


def previous_device(db, identity_id, family_id):
    binding = db.query(DeviceIdentityBinding).filter_by(identity_id=identity_id, family_id=family_id).with_for_update().first()
    return db.query(Device).filter_by(id=binding.device_id).populate_existing().with_for_update().first() if binding else None
