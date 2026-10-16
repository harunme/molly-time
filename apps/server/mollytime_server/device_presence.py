"""Device reachability based on authenticated heartbeats, not parent page views."""

import datetime as dt

from sqlalchemy import update

from .manage_auth import aware
from .management_models import Device, DeviceBootState

# Idle TV pages check /api/me every 30 seconds; tolerate two missed checks.
ONLINE_WINDOW = dt.timedelta(seconds=90)


def device_online(device, at=None):
    at = at or dt.datetime.now(dt.UTC)
    return not device.revoked and dt.timedelta(0) <= at - aware(device.last_seen) <= ONLINE_WINDOW


def touch_device(db, device_id, boot_id=None, boot_elapsed_ms=None):
    now = dt.datetime.now(dt.UTC)
    # Bound writes from overlapping player and page heartbeats; never roll time back.
    result = db.execute(
        update(Device)
        .where(Device.id == device_id, Device.last_seen < now - dt.timedelta(seconds=10))
        .values(last_seen=now)
        .execution_options(synchronize_session=False)
    )
    changed = False
    # Uptime comes from a monotonic client clock, never from its wall clock.
    if (boot_id and len(boot_id) <= 128 and boot_id.isascii()
            and boot_elapsed_ms and boot_elapsed_ms.isdecimal()
            and len(boot_elapsed_ms) <= 12):
        elapsed = int(boot_elapsed_ms)
        if elapsed <= 10 * 366 * 24 * 60 * 60 * 1000:
            started = now - dt.timedelta(milliseconds=elapsed)
            boot = db.get(DeviceBootState, device_id)
            if boot is None:
                db.add(DeviceBootState(device_id=device_id, boot_id=boot_id, started_at=started))
                changed = True
            elif boot.boot_id != boot_id and started > aware(boot.started_at):
                boot.boot_id, boot.started_at = boot_id, started
                changed = True
    if result.rowcount or changed:
        db.commit()
