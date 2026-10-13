"""Device reachability based on authenticated heartbeats, not parent page views."""

import datetime as dt

from sqlalchemy import update

from .manage_auth import aware
from .management_models import Device

# Idle TV pages check /api/me every 30 seconds; tolerate two missed checks.
ONLINE_WINDOW = dt.timedelta(seconds=90)


def device_online(device, at=None):
    at = at or dt.datetime.now(dt.UTC)
    return not device.revoked and dt.timedelta(0) <= at - aware(device.last_seen) <= ONLINE_WINDOW


def touch_device(db, device_id):
    now = dt.datetime.now(dt.UTC)
    # Bound writes from overlapping player and page heartbeats; never roll time back.
    result = db.execute(
        update(Device)
        .where(Device.id == device_id, Device.last_seen < now - dt.timedelta(seconds=10))
        .values(last_seen=now)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount:
        db.commit()
