import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_global_usernames import database, legacy_users  # noqa: F401
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import accounts, config, db
from mollytime_server.accounts import AccountIdentity, AccountInvitation, ensure_identity
from mollytime_server.auth import hash_password, hash_refresh_token
from mollytime_server.models import Family, User
from mollytime_server.scripts.create_admin import main as create_admin

INVITES = "/api/manage/operations/invitations"
ACTIVATE = "/api/manage/auth/invitation/activate"
PREVIEW = "/api/manage/auth/invitation/preview"


@pytest.fixture
def operator(parent):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "superadmin"
        session.commit()
    return parent


def invite(operator, email="guest@example.com", **extra):
    response = operator.post(INVITES, json={"email": email, "familyName": "Guest family", **extra})
    assert response.status_code == 200, response.text
    row = response.json()
    token = parse_qs(urlsplit(row["activationUrl"]).fragment)["invite"][0]
    return row, token


def test_invited_account_can_login_by_email_or_id_with_family_isolation(operator):
    row, token = invite(operator, " Guest+One@Example.COM ")
    assert row["email"] == "guest+one@example.com"
    assert operator.post(PREVIEW, json={"token": token}).json()["email"] == row["email"]
    response = operator.post(ACTIVATE, json={"token": token, "password": "guest-password"})
    assert response.status_code == 200
    activated = response.json()
    assert len(activated["accountId"]) == 10 and activated["accountId"].isascii()
    assert activated["accountId"].isdigit() and not activated["accountId"].startswith("0")
    with Session(db.get_engine()) as session:
        identity = session.query(AccountIdentity).filter_by(email=row["email"]).one()
        internal_id = identity.user_id
        user = session.get(User, internal_id)
        family_id = user.family_id
        assert user.role == "admin" and family_id not in ("f1", "f2")
        assert session.get(AccountInvitation, row["id"]).accepted_at is not None
        assert session.get(AccountInvitation, row["id"]).user_id == internal_id
        stored_name = user.name
    for endpoint in ["/api/auth/login", "/api/manage/auth/login"]:
        for identifier in [" GUEST+ONE@EXAMPLE.COM ", activated["accountId"]]:
            result = operator.post(
                endpoint, json={"username": identifier, "password": "guest-password"}
            )
            assert result.status_code == 200
            assert result.json()["user"]["id"] == internal_id
            assert result.json()["user"]["accountId"] == activated["accountId"]
            assert result.json()["user"]["email"] == row["email"]
            assert result.json()["family"]["id"] == family_id
        assert (
            operator.post(
                endpoint, json={"username": activated["accountId"], "password": "wrong"}
            ).status_code
            == 401
        )
        assert (
            operator.post(
                endpoint, json={"username": stored_name, "password": "guest-password"}
            ).status_code
            == 401
        )
    assert operator.get("/api/manage/resources/e1").status_code == 404
    assert (
        operator.post(ACTIVATE, json={"token": token, "password": "guest-password"}).status_code
        == 404
    )


def test_email_binding_preserves_identity_password_family_and_stops_legacy_login(parent):  # noqa: F811
    original = parent.get("/api/manage/auth/session").json()
    response = parent.patch(
        "/api/manage/account/email",
        json={
            "email": " Parent@Example.COM ",
            "currentPassword": "test-parent",
        },
    )
    assert response.status_code == 200
    bound = response.json()
    assert bound["accountId"] == original["user"]["accountId"]
    assert bound["id"] == original["user"]["id"] == "u1"
    assert bound["email"] == "parent@example.com"
    assert parent.get("/api/manage/auth/session").json()["family"] == original["family"]
    for endpoint in ["/api/manage/auth/login", "/api/auth/login"]:
        assert (
            parent.post(
                endpoint, json={"username": "parent", "password": "test-parent"}
            ).status_code
            == 401
        )
        for identifier in [bound["accountId"], "PARENT@EXAMPLE.COM"]:
            result = parent.post(endpoint, json={"username": identifier, "password": "test-parent"})
            assert result.status_code == 200
            assert result.json()["user"]["id"] == "u1"
            assert result.json()["family"]["id"] == "f1"


def test_member_can_bind_but_cannot_invite_and_binding_checks_password_csrf(parent):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        session.commit()
    body = {"email": "member@example.com", "currentPassword": "test-parent"}
    assert (
        parent.patch(
            "/api/manage/account/email", headers={"X-CSRF-Token": ""}, json=body
        ).status_code
        == 403
    )
    assert (
        parent.patch(
            "/api/manage/account/email", json={**body, "currentPassword": "wrong"}
        ).status_code
        == 403
    )
    assert parent.patch("/api/manage/account/email", json=body).status_code == 200
    assert parent.patch("/api/manage/account/email", json=body).status_code == 409
    assert (
        parent.post(INVITES, json={"email": "other@example.com", "familyName": "Other"}).status_code
        == 403
    )


@pytest.mark.parametrize("role", ["admin", "member"])
def test_invitations_require_superadmin_even_for_reading(parent, role):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = role
        session.commit()
    assert parent.get(INVITES).status_code == 403
    assert (
        parent.post(INVITES, json={"email": "guest@example.com", "familyName": "Other"}).status_code
        == 403
    )
    assert parent.post(INVITES + "/fake/revoke").status_code == 403


def test_invitation_secrets_are_hashed_and_creation_requires_csrf_origin(operator):
    body = {"email": "guest@example.com", "familyName": "Other"}
    assert operator.post(INVITES, headers={"X-CSRF-Token": ""}, json=body).status_code == 403
    assert (
        operator.post(
            INVITES, headers={"Origin": "https://other.example.com"}, json=body
        ).status_code
        == 403
    )
    row, token = invite(operator)
    assert row["id"] == hash_refresh_token(token)
    listing = operator.get(INVITES)
    assert listing.status_code == 200
    assert token not in listing.text and "activationUrl" not in listing.text
    with db.get_engine().connect() as connection:
        assert token not in str(connection.execute(text("SELECT * FROM account_invitations")).all())
    operator.cookies.clear()
    assert operator.get(INVITES).status_code == 401
    assert operator.post(INVITES, json=body).status_code == 401


@pytest.mark.parametrize(
    "reason", ["revoke", "expire", "disabled-inviter", "demoted-inviter", "reissue"]
)
def test_unusable_invites_cannot_preview_or_activate(operator, reason):
    row, token = invite(operator)
    if reason == "revoke":
        assert operator.post(f"{INVITES}/{row['id']}/revoke").status_code == 200
    elif reason == "reissue":
        invite(operator)
    else:
        with Session(db.get_engine()) as session:
            if reason == "expire":
                session.get(AccountInvitation, row["id"]).expires_at = dt.datetime.now(
                    dt.UTC
                ) - dt.timedelta(seconds=1)
            elif reason == "disabled-inviter":
                session.get(User, "u1").is_disabled = True
            else:
                session.get(User, "u1").role = "admin"
            session.commit()
    assert operator.post(PREVIEW, json={"token": token}).status_code == 404
    assert (
        operator.post(ACTIVATE, json={"token": token, "password": "guest-password"}).status_code
        == 404
    )
    with Session(db.get_engine()) as session:
        assert session.query(User).count() == 1 and session.query(Family).count() == 2


@pytest.mark.parametrize(
    "extra", [{"role": "superadmin"}, {"familyId": "f1"}, {"email": "other@example.com"}]
)
def test_invite_activation_rejects_client_selected_identity_or_permissions(operator, extra):
    _, token = invite(operator)
    assert (
        operator.post(
            ACTIVATE, json={"token": token, "password": "guest-password", **extra}
        ).status_code
        == 422
    )
    assert (
        operator.post(ACTIVATE, json={"token": "x" * 43, "password": "guest-password"}).status_code
        == 404
    )
    assert (
        operator.post(
            "/api/auth/register", json={"email": "other@example.com", "password": "guest-password"}
        ).status_code
        == 404
    )


@pytest.mark.parametrize(
    "email",
    [
        "not-email",
        "a@@example.com",
        "a@example",
        "a..b@example.com",
        "a@-example.com",
        "a@exa mple.com",
    ],
)
def test_invitation_rejects_invalid_emails(operator, email):
    assert operator.post(INVITES, json={"email": email, "familyName": "Other"}).status_code == 422


def test_existing_email_cannot_be_reinvited_or_bound_by_another_user(operator):
    _, token = invite(operator)
    assert (
        operator.post(ACTIVATE, json={"token": token, "password": "guest-password"}).status_code
        == 200
    )
    assert (
        operator.post(
            INVITES, json={"email": "GUEST@EXAMPLE.COM", "familyName": "Other"}
        ).status_code
        == 409
    )
    assert (
        operator.patch(
            "/api/manage/account/email",
            json={"email": "GUEST@EXAMPLE.COM", "currentPassword": "test-parent"},
        ).status_code
        == 409
    )


def test_concurrent_activation_creates_exactly_one_family_and_account(operator):
    _, token = invite(operator)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda _: (
                    operator.post(
                        ACTIVATE, json={"token": token, "password": "guest-password"}
                    ).status_code
                ),
                range(2),
            )
        )
    assert sorted(results) == [200, 404]
    with Session(db.get_engine()) as session:
        assert session.query(User).count() == 2
        assert session.query(Family).count() == 3
        assert session.query(AccountIdentity).filter_by(email="guest@example.com").count() == 1


def test_email_and_numeric_id_have_database_unique_constraints(operator):
    with Session(db.get_engine()) as session:
        first = session.get(AccountIdentity, "u1")
        first.email = "parent@example.com"
        session.add(User(id="u2", name="other", family_id="f2", password_hash="test"))
        session.commit()
        number = first.account_id
        session.add(
            AccountIdentity(user_id="u2", account_id="1234567890", email="PARENT@EXAMPLE.COM")
        )
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        session.add(AccountIdentity(user_id="u2", account_id=number, email="other@example.com"))
        with pytest.raises(IntegrityError):
            session.commit()


def test_numeric_id_collision_is_retried_in_code(operator, monkeypatch):
    with Session(db.get_engine()) as session:
        first = session.get(AccountIdentity, "u1").account_id
        session.add(User(id="u2", name="other", family_id="f2", password_hash="test"))
        session.commit()
        next_id = "1234567890" if first != "1234567890" else "1234567891"
        values = iter([int(first) - 1_000_000_000, int(next_id) - 1_000_000_000])
        monkeypatch.setattr(accounts.secrets, "randbelow", lambda _: next(values))
        identity = ensure_identity(session, session.get(User, "u2"))
        session.commit()
        assert identity.account_id == next_id
        assert session.get(AccountIdentity, "u1").account_id == first


def test_numeric_id_allocation_reserves_legacy_numeric_usernames(operator, monkeypatch):
    with Session(db.get_engine()) as session:
        session.add(User(id="numeric", name="2345678901", family_id="f2", password_hash="test"))
        session.add(User(id="new", name="other", family_id="f2", password_hash="test"))
        session.commit()
        values = iter([1_345_678_901, 1_345_678_902])
        monkeypatch.setattr(accounts.secrets, "randbelow", lambda _: next(values))
        identity = ensure_identity(session, session.get(User, "new"))
        session.commit()
        assert identity.account_id == "2345678902"
        assert accounts.find_login_user(session, "2345678901").id == "numeric"


def test_legacy_account_ids_are_backfilled_once_without_changing_user_records(database):  # noqa: F811
    legacy_users(database, "other")
    db.init_db()
    with Session(database) as session:
        before = {row.user_id: row.account_id for row in session.query(AccountIdentity).all()}
        assert set(before) == {"u1", "u2"} and len(set(before.values())) == 2
        assert all(row.email is None for row in session.query(AccountIdentity).all())
    db.init_db()
    with Session(database) as session:
        assert {
            row.user_id: row.account_id for row in session.query(AccountIdentity).all()
        } == before
        assert session.get(User, "u1").family_id == "f1"
        assert session.get(User, "u1").password_hash == "original-hash"


def test_bootstrap_requires_email_for_new_accounts_and_accepts_existing_legacy_account(database):  # noqa: F811
    config.get_settings().initial_admin_email = None
    assert create_admin([]) == 1
    with Session(database) as session:
        assert session.query(User).count() == session.query(Family).count() == 0
        family = Family(name=config.get_settings().initial_admin_family_name)
        session.add(family)
        session.flush()
        session.add(
            User(name="admin", family_id=family.id, password_hash=hash_password("legacy-password"))
        )
        session.commit()
    assert create_admin(["--superadmin"]) == 0
    with Session(database) as session:
        user = session.query(User).one()
        assert user.role == "superadmin"
        assert session.get(AccountIdentity, user.id).email is None
