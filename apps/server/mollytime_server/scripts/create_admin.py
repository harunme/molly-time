"""Bootstrap: create the default Family + admin User.

Idempotent. Re-run safe.
"""

from __future__ import annotations

import sys

from ..api.auth import _hash_for_init
from ..config import get_settings
from ..db import session_scope
from ..models import Family, User


def main() -> int:
    s = get_settings()
    for db in session_scope():
        family = db.query(Family).filter(Family.name == s.initial_admin_family_name).first()
        if family is None:
            family = Family(name=s.initial_admin_family_name)
            db.add(family)
            db.flush()
            print(f"[create_admin] created family id={family.id} name={family.name}")
        else:
            print(f"[create_admin] family exists id={family.id}")

        user = (
            db.query(User)
            .filter(User.family_id == family.id, User.name == s.initial_admin_username)
            .first()
        )
        if user is None:
            user = User(
                family_id=family.id,
                name=s.initial_admin_username,
                password_hash=_hash_for_init(s.initial_admin_password),
                role="admin",
            )
            db.add(user)
            db.flush()
            print(f"[create_admin] created user id={user.id} role={user.role}")
        else:
            print(f"[create_admin] user exists id={user.id} role={user.role}")

        db.commit()
        break
    return 0


if __name__ == "__main__":
    sys.exit(main())