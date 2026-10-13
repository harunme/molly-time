"""Bootstrap: create the default Family + admin User.

Idempotent. Re-run safe.
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy.exc import IntegrityError

from ..accounts import AccountIdentity, ensure_identity, normalize_email
from ..api.auth import _hash_for_init
from ..config import get_settings
from ..db import init_db, session_scope
from ..models import Family, User


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Create a family admin or platform superadmin")
    parser.add_argument(
        "--superadmin", action="store_true", help="Grant platform operations access"
    )
    args = parser.parse_args(argv)
    init_db()
    s = get_settings()
    try:
        email = normalize_email(s.initial_admin_email) if s.initial_admin_email else None
    except ValueError as exc:
        print(f"[create_admin] {exc}")
        return 1
    for db in session_scope():
        user = db.query(User).filter(User.name == s.initial_admin_username).one_or_none()
        if email:
            identity = db.query(AccountIdentity).filter(AccountIdentity.email == email).one_or_none()
            if identity is not None:
                if user is not None and user.id != identity.user_id:
                    print("[create_admin] email belongs to a different account")
                    return 1
                user = db.get(User, identity.user_id)
        if user is None and email is None:
            print("[create_admin] set MOLLYTIME_INITIAL_ADMIN_EMAIL to create a new account")
            return 1
        if user is not None and user.family.name != s.initial_admin_family_name:
            print("[create_admin] username already belongs to another family; choose a unique username")
            return 1
        family = db.query(Family).filter(Family.name == s.initial_admin_family_name).first()
        if family is None:
            family = Family(name=s.initial_admin_family_name)
            db.add(family)
            db.flush()
            print(f"[create_admin] created family id={family.id} name={family.name}")
        else:
            print(f"[create_admin] family exists id={family.id}")

        if user is not None and user.family_id != family.id:
            print("[create_admin] username already belongs to another family; choose a unique username")
            return 1
        if user is None:
            user = User(
                family_id=family.id,
                name=s.initial_admin_username,
                password_hash=_hash_for_init(s.initial_admin_password),
                role="superadmin" if args.superadmin else "admin",
            )
            db.add(user)
            try:
                db.flush()
            except IntegrityError:
                db.rollback()
                print("[create_admin] username already exists; choose a unique username")
                return 1
            print(f"[create_admin] created user id={user.id} role={user.role}")
        else:
            print(f"[create_admin] user exists id={user.id} role={user.role}")

        identity = ensure_identity(db, user)
        if email:
            if identity.email is not None and identity.email != email:
                db.rollback()
                print("[create_admin] account email is already bound; refusing to replace it")
                return 1
            identity.email = email

        if args.superadmin:
            other = db.query(User).filter(User.role == "superadmin", User.id != user.id).first()
            if other:
                db.rollback()
                print("[create_admin] a superadmin already exists; refusing a second account")
                return 1
            user.role = "superadmin"
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            print("[create_admin] email or username already exists; choose a unique account")
            return 1
        print(f"[create_admin] ready email={identity.email or 'not-bound'} accountId={identity.account_id} role={user.role}")
        break
    return 0


if __name__ == "__main__":
    sys.exit(main())
