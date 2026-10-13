import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_tv_playback import client  # noqa: F401 -- isolated API fixture

from mollytime_server import config, db
from mollytime_server.auth import hash_password
from mollytime_server.management_models import SchemaRevision
from mollytime_server.models import Family, User
from mollytime_server.scripts.create_admin import main as create_admin


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "_settings", config.Settings(data_dir=tmp_path, initial_admin_email="bootstrap@example.test"))
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_SessionLocal", None)
    engine = db.get_engine()
    yield engine
    engine.dispose()


def legacy_users(engine, second_name):
    Family.__table__.create(engine)
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO families (id, name, created_at) VALUES "
                                "('f1', 'One', CURRENT_TIMESTAMP), "
                                "('f2', 'Two', CURRENT_TIMESTAMP)"))
        connection.execute(text("""
            CREATE TABLE users (
                id VARCHAR(36) PRIMARY KEY,
                family_id VARCHAR(36) NOT NULL REFERENCES families(id),
                name VARCHAR(64) NOT NULL,
                password_hash VARCHAR(128) NOT NULL,
                role VARCHAR(16) NOT NULL,
                is_disabled BOOLEAN NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_user_family_name UNIQUE (family_id, name)
            )
        """))
        connection.execute(text("""
            INSERT INTO users VALUES
                ('u1', 'f1', 'parent', 'original-hash', 'admin', 0, CURRENT_TIMESTAMP),
                ('u2', 'f2', :name, 'other-hash', 'member', 0, CURRENT_TIMESTAMP)
        """), {"name": second_name})


def test_legacy_migration_preserves_users_and_enforces_global_uniqueness(database):
    legacy_users(database, "other")
    with database.connect() as connection:
        before = connection.execute(text("SELECT * FROM users ORDER BY id")).all()
    db.init_db()
    db.init_db()
    with database.connect() as connection:
        assert connection.execute(text("SELECT * FROM users ORDER BY id")).all() == before
    index = next(i for i in inspect(database).get_indexes("users") if i["name"] == "uq_user_name")
    assert index["unique"] and index["column_names"] == ["name"]
    with Session(database) as session:
        assert session.get(SchemaRevision, "global-usernames-v1") is not None
        session.add(User(family_id="f2", name="parent", password_hash="test"))
        with pytest.raises(IntegrityError):
            session.commit()


def test_legacy_duplicate_names_stop_migration_without_renaming_accounts(database):
    legacy_users(database, "parent")
    with database.connect() as connection:
        before = connection.execute(text("SELECT * FROM users ORDER BY id")).all()
    with pytest.raises(RuntimeError, match="'parent' \\(2 accounts\\)"):
        db.init_db()
    with database.connect() as connection:
        assert connection.execute(text("SELECT * FROM users ORDER BY id")).all() == before
    assert not any(i["name"] == "uq_user_name" for i in inspect(database).get_indexes("users"))
    with Session(database) as session:
        assert session.get(SchemaRevision, "global-usernames-v1") is None
    with database.begin() as connection:
        connection.execute(text("UPDATE users SET name = 'other' WHERE id = 'u2'"))
    db.init_db()
    with Session(database) as session:
        assert session.get(User, "u1").name == "parent"
        assert session.get(User, "u2").name == "other"


@pytest.mark.parametrize("family", ["f1", "f2"])
def test_new_database_rejects_reusing_even_a_disabled_username(client, family):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.get(User, "u1").is_disabled = True
        session.commit()
        session.add(User(family_id=family, name="parent", password_hash="test"))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        assert session.query(User).count() == 1


def test_existing_user_cannot_be_renamed_to_another_familys_username(client):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.add(User(id="u2", family_id="f2", name="other", password_hash="test"))
        session.commit()
        session.get(User, "u2").name = "parent"
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        assert session.get(User, "u2").name == "other"


@pytest.mark.parametrize("path", ["/api/manage/auth/login", "/api/auth/login"])
@pytest.mark.parametrize("extra", [{}, {"familyId": "f2"}, {"familyId": "nonexistent"}])
def test_login_uses_unique_username_and_account_family(client, path, extra):  # noqa: F811
    with Session(db.get_engine()) as session:
        session.get(User, "u1").password_hash = hash_password("first-password")
        session.add(User(id="u2", family_id="f2", name="other",
                         password_hash=hash_password("second-password"), role="member"))
        session.commit()
    result = client.post(path, json={"username": "parent", "password": "first-password", **extra})
    assert result.status_code == 200
    assert result.json()["user"]["id"] == "u1"
    assert result.json()["family"]["id"] == "f1"
    assert client.post(path, json={"username": "parent", "password": "second-password",
                                   **extra}).status_code == 401
    result = client.post(path, json={"username": "other", "password": "second-password"})
    assert result.status_code == 200
    assert result.json()["family"]["id"] == "f2"
    assert result.json()["user"]["role"] == "member"
    assert client.post(path, json={"username": "missing", "password": "first-password"}).status_code == 401


@pytest.mark.parametrize("args", [[], ["--superadmin"]])
def test_bootstrap_rejects_username_owned_by_another_family(database, args, capsys):
    settings = config.get_settings()
    assert create_admin([]) == 0
    with Session(database) as session:
        user = session.query(User).one()
        original = (user.id, user.family_id, user.password_hash, user.role)
    settings.initial_admin_family_name = "Another family"
    assert create_admin(args) == 1
    assert "username already belongs to another family" in capsys.readouterr().out
    with Session(database) as session:
        user = session.query(User).one()
        assert (user.id, user.family_id, user.password_hash, user.role) == original
        assert session.query(Family).count() == 1


def test_bootstrap_unique_accounts_and_repeated_initialization(database):
    assert create_admin(["--superadmin"]) == 0
    with Session(database) as session:
        user = session.query(User).one()
        original = (user.id, user.family_id, user.password_hash)
    settings = config.get_settings()
    settings.initial_admin_password = "replacement-password"
    assert create_admin([]) == 0
    with Session(database) as session:
        user = session.query(User).one()
        assert (user.id, user.family_id, user.password_hash) == original
        assert user.role == "superadmin"
    settings.initial_admin_username = "other-admin"
    settings.initial_admin_email = "other-admin@example.test"
    settings.initial_admin_family_name = "Another family"
    assert create_admin([]) == 0
    assert create_admin([]) == 0
    with Session(database) as session:
        assert session.query(User).count() == 2
        assert session.query(Family).count() == 2
