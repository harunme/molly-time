import datetime as dt
from concurrent.futures import ThreadPoolExecutor

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.orm import Session
from test_email_accounts import operator  # noqa: F401
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.accounts import AccountIdentity, AccountInvitation, InvitationCode
from mollytime_server.api import account_invitations
from mollytime_server.auth import hash_refresh_token
from mollytime_server.models import Family, User

INVITES = "/api/manage/operations/invitations"
PREVIEW = "/api/manage/auth/invitation/preview"
ACTIVATE = "/api/manage/auth/invitation/activate"


def code(operator):  # noqa: F811 -- shared fixture name
    result = operator.post(INVITES, json={})
    assert result.status_code == 200, result.text
    return result.json()


def registration(value, email="guest@example.com", **extra):
    return {
        "code": value,
        "email": email,
        "familyName": "My family",
        "password": "guest-password",
        **extra,
    }


def test_code_registration_collects_recipient_data_and_consumes_code_once(operator):  # noqa: F811
    invitation = code(operator)
    raw = invitation["code"].replace("-", "")
    assert len(raw) == 12 and set(raw) <= set(account_invitations.CODE_ALPHABET)
    assert invitation["email"] is None and invitation["familyName"] is None
    assert invitation["id"] == hash_refresh_token(raw)
    with Session(db.get_engine()) as session:
        row = session.get(AccountInvitation, invitation["id"])
        assert row.email == row.family_name == ""
    preview = operator.post(PREVIEW, json={"code": " " + invitation["code"].lower() + " "})
    assert preview.status_code == 200
    assert preview.json()["email"] is None and preview.json()["familyName"] is None
    response = operator.post(ACTIVATE, json=registration(invitation["code"], " GUEST@EXAMPLE.COM "))
    assert response.status_code == 200
    assert response.json()["email"] == "guest@example.com"
    assert response.json()["familyName"] == "My family"
    with Session(db.get_engine()) as session:
        row = session.get(AccountInvitation, invitation["id"])
        assert row.email == "guest@example.com" and row.family_name == "My family"
        identity = session.get(AccountIdentity, row.user_id)
        assert identity.account_id == response.json()["accountId"]
        user = session.get(User, row.user_id)
        assert user.family_id not in ("f1", "f2") and user.role == "admin"
    assert operator.post(PREVIEW, json={"code": invitation["code"]}).status_code == 404
    assert (
        operator.post(
            ACTIVATE, json=registration(invitation["code"], "another@example.com")
        ).status_code
        == 404
    )


@pytest.mark.parametrize("missing", ["email", "familyName"])
def test_code_requires_email_and_family_and_failed_registration_does_not_consume_it(
    operator,  # noqa: F811 -- shared fixture name
    missing,
):
    invitation = code(operator)
    body = registration(invitation["code"])
    del body[missing]
    assert operator.post(ACTIVATE, json=body).status_code == 422
    assert operator.post(PREVIEW, json={"code": invitation["code"]}).status_code == 200
    assert operator.post(ACTIVATE, json=registration(invitation["code"])).status_code == 200


def test_duplicate_email_keeps_invitation_available_for_another_email(operator):  # noqa: F811
    first, second = code(operator), code(operator)
    assert operator.post(ACTIVATE, json=registration(first["code"])).status_code == 200
    assert (
        operator.post(ACTIVATE, json=registration(second["code"], "GUEST@EXAMPLE.COM")).status_code
        == 409
    )
    assert operator.post(PREVIEW, json={"code": second["code"]}).status_code == 200
    assert (
        operator.post(ACTIVATE, json=registration(second["code"], "other@example.com")).status_code
        == 200
    )


@pytest.mark.parametrize("reason", ["revoke", "expire", "disabled", "demoted"])
def test_invalidated_codes_cannot_register(operator, reason):  # noqa: F811
    invitation = code(operator)
    if reason == "revoke":
        assert operator.post(f"{INVITES}/{invitation['id']}/revoke").status_code == 200
    else:
        with Session(db.get_engine()) as session:
            if reason == "expire":
                session.get(AccountInvitation, invitation["id"]).expires_at = dt.datetime.now(
                    dt.UTC
                ) - dt.timedelta(seconds=1)
            elif reason == "disabled":
                session.get(User, "u1").is_disabled = True
            else:
                session.get(User, "u1").role = "admin"
            session.commit()
    assert operator.post(PREVIEW, json={"code": invitation["code"]}).status_code == 404
    assert operator.post(ACTIVATE, json=registration(invitation["code"])).status_code == 404


def test_concurrent_registration_with_different_emails_consumes_code_once(operator):  # noqa: F811
    invitation = code(operator)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda email: (
                    operator.post(
                        ACTIVATE, json=registration(invitation["code"], email)
                    ).status_code
                ),
                ["first@example.com", "second@example.com"],
            )
        )
    assert sorted(results) == [200, 404]
    with Session(db.get_engine()) as session:
        assert session.query(User).count() == 2 and session.query(Family).count() == 3


@pytest.mark.parametrize(
    "extra", [{"role": "superadmin"}, {"familyId": "f1"}, {"accountId": "1234567890"}]
)
def test_registration_code_cannot_select_existing_family_role_or_id(operator, extra):  # noqa: F811
    invitation = code(operator)
    assert (
        operator.post(ACTIVATE, json=registration(invitation["code"], **extra)).status_code == 422
    )
    assert (
        operator.post(
            ACTIVATE,
            json={
                "email": "guest@example.com",
                "familyName": "Guest",
                "password": "guest-password",
            },
        ).status_code
        == 422
    )


def test_guessing_codes_is_rate_limited_before_password_hashing(operator):  # noqa: F811
    body = {"code": "AAAA-AAAA-AAAA"}
    for _ in range(30):
        assert operator.post(PREVIEW, json=body).status_code == 404
    assert operator.post(PREVIEW, json=body).status_code == 429


def test_codes_are_encrypted_in_storage_and_retrievable_in_authorized_history(operator):  # noqa: F811
    invitation = code(operator)
    raw = invitation["code"].replace("-", "")
    listing = operator.get(INVITES)
    assert listing.json()["items"][0]["code"] == invitation["code"]
    assert listing.json()["items"][0]["email"] is None
    with Session(db.get_engine()) as session:
        row = session.get(AccountInvitation, invitation["id"])
        assert row.id != raw and row.id == hash_refresh_token(raw)
        stored = session.get(InvitationCode, row.id)
        assert raw not in stored.ciphertext and invitation["code"] not in stored.ciphertext
    db.init_db()
    assert operator.get(INVITES).json()["items"][0]["code"] == invitation["code"]


@pytest.mark.parametrize("role", ["admin", "member"])
def test_saved_code_is_not_disclosed_to_non_operators(operator, role):  # noqa: F811
    invitation = code(operator)
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = role
        session.commit()
    result = operator.get(INVITES)
    assert result.status_code == 403 and invitation["code"] not in result.text


def test_code_is_not_disclosed_in_public_invitation_preview(operator):  # noqa: F811
    invitation = code(operator)
    preview = operator.post(PREVIEW, json={"code": invitation["code"]})
    assert preview.status_code == 200
    assert "code" not in preview.json() and invitation["code"] not in preview.text


def test_missing_old_code_is_not_fabricated_and_additive_table_migration_preserves_it(operator):  # noqa: F811
    invitation = code(operator)
    InvitationCode.__table__.drop(db.get_engine())
    db.init_db()
    db.init_db()
    row = operator.get(INVITES).json()["items"][0]
    assert row["code"] is None and row["id"] == invitation["id"] and row["status"] == "pending"
    assert operator.post(PREVIEW, json={"code": invitation["code"]}).status_code == 200


@pytest.mark.parametrize("problem", ["missing", "wrong-key"])
def test_unreadable_saved_codes_do_not_break_history_or_registration_validation(operator, problem):  # noqa: F811
    invitation = code(operator)
    key = config.get_settings().data_dir / "operations-storage.key"
    if problem == "missing":
        key.unlink()
    else:
        key.write_bytes(Fernet.generate_key())
    listing = operator.get(INVITES)
    assert listing.status_code == 200 and listing.json()["items"][0]["code"] is None
    assert operator.post(PREVIEW, json={"code": invitation["code"]}).status_code == 200


def test_encrypted_code_cannot_be_swapped_between_invitation_records(operator):  # noqa: F811
    first, second = code(operator), code(operator)
    with Session(db.get_engine()) as session:
        session.get(InvitationCode, first["id"]).ciphertext = session.get(
            InvitationCode, second["id"]
        ).ciphertext
        session.commit()
    rows = {row["id"]: row for row in operator.get(INVITES).json()["items"]}
    assert rows[first["id"]]["code"] is None
    assert rows[second["id"]]["code"] == second["code"]


def test_code_generation_retries_collision(operator, monkeypatch):  # noqa: F811
    previous = code(operator)["code"].replace("-", "")
    replacement = "BBBBBBBBBBBB" if previous != "BBBBBBBBBBBB" else "CCCCCCCCCCCC"
    choices = iter(previous + replacement)
    monkeypatch.setattr(account_invitations.secrets, "choice", lambda _: next(choices))
    assert code(operator)["code"].replace("-", "") == replacement
