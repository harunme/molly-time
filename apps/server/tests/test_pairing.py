# ruff: noqa: F811 -- imported pytest fixtures share parameter names
import datetime as dt
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db
from mollytime_server.api.pairing import digest
from mollytime_server.auth import hash_password, hash_refresh_token, verify_access_token
from mollytime_server.main import create_app
from mollytime_server.management_models import Device, DevicePairing, PairingRate
from mollytime_server.models import RefreshToken, User


def start(parent):
    response = parent.post('/api/auth/pairing/start', json={'name': '客厅电视'})
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    result = response.json()
    assert 'qrSvg' not in result
    assert result['deviceCode'] not in result['verificationUri']
    assert len(result['userCode']) == 4 and result['userCode'].isascii() and result['userCode'].isdigit()
    return result


def pollable(code):
    with Session(db.get_engine()) as session:
        session.get(DevicePairing, digest(code)).last_polled_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=4)
        session.commit()


def test_pairing_parent_consent_device_scope_retry_and_revocation(parent):
    row = start(parent)
    route = '/api/auth/pairing/poll'
    body = {'deviceCode': row['deviceCode']}
    assert parent.post(route, json=body).json() == {'status': 'pending'}
    assert parent.get(f"/api/manage/pairing/{row['userCode']}").json()['name'] == '客厅电视'
    approve = '/api/manage/pairing/confirm'
    assert parent.post(approve, json={'code': row['userCode'], 'name': '客厅'}).status_code == 200
    assert parent.post(approve, json={'code': row['userCode']}).status_code == 404
    assert parent.post(route, json=body).status_code == 429
    pollable(row['deviceCode'])
    response = parent.post(route, json=body)
    assert response.headers['cache-control'] == 'no-store'
    auth = response.json()['auth']
    claims = verify_access_token(auth['accessToken'])
    assert claims['role'] == 'device' and claims['device'] == auth['deviceId']
    headers = {'Authorization': 'Bearer ' + auth['accessToken']}
    assert parent.get('/api/home', headers=headers).status_code == 200
    pollable(row['deviceCode'])
    retry = parent.post(route, json=body).json()['auth']
    assert retry['deviceId'] == auth['deviceId'] and retry['refreshToken'] == auth['refreshToken']
    with Session(db.get_engine()) as session:
        assert session.query(Device).count() == 1
    assert parent.post(f"/api/manage/devices/{auth['deviceId']}/revoke").status_code == 200
    assert parent.get('/api/home', headers=headers).status_code == 401
    assert parent.post('/api/auth/refresh', json={'refreshToken': auth['refreshToken']}).status_code == 401
    pollable(row['deviceCode'])
    assert parent.post(route, json=body).json()['status'] == 'expired'
    parent.cookies.clear()
    assert parent.get('/api/manage/devices', headers=headers).status_code == 401


def test_pairing_requires_parent_csrf_and_admin(parent):
    row = start(parent)
    body = {'code': row['userCode']}
    assert parent.post('/api/manage/pairing/confirm', json=body, headers={'X-CSRF-Token': ''}).status_code == 403
    assert parent.post('/api/manage/pairing/confirm', json=body, headers={'Origin': 'https://evil.test'}).status_code == 403
    with Session(db.get_engine()) as session:
        session.get(User, 'u1').role = 'member'
        session.commit()
    assert parent.post('/api/manage/pairing/confirm', json=body).status_code == 403
    assert parent.get(f"/api/manage/pairing/{row['userCode']}").status_code == 403
    parent.cookies.clear()
    assert parent.post('/api/manage/pairing/confirm', json=body).status_code == 401


def test_pairing_expiry_cancel_and_unknown_secret(parent):
    row = start(parent)
    assert parent.post('/api/auth/pairing/poll', json={'deviceCode': 'x' * 43}).json()['status'] == 'expired'
    assert parent.post('/api/auth/pairing/poll', json={'deviceCode': row['userCode']}).status_code == 422
    assert parent.post('/api/auth/pairing/cancel', json={'deviceCode': row['deviceCode']}).status_code == 200
    assert parent.post('/api/manage/pairing/confirm', json={'code': row['userCode']}).status_code == 404
    assert parent.post('/api/auth/pairing/poll', json={'deviceCode': row['deviceCode']}).json()['status'] == 'expired'
    row = start(parent)
    with Session(db.get_engine()) as session:
        session.get(DevicePairing, digest(row['deviceCode'])).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        session.commit()
    assert parent.post('/api/manage/pairing/confirm', json={'code': row['userCode']}).status_code == 404
    assert parent.post('/api/auth/pairing/poll', json={'deviceCode': row['deviceCode']}).json()['status'] == 'expired'
    with Session(db.get_engine()) as session:
        assert session.query(Device).count() == 0


def test_pairing_rate_limits_and_public_phone_link(parent, monkeypatch):
    monkeypatch.setattr(config.get_settings(), 'public_base_url', 'https://mollytime.example')
    row = start(parent)
    assert row['verificationUri'] == 'https://mollytime.example/manage/?pair=' + row['userCode']
    for _ in range(9):
        assert parent.post('/api/auth/pairing/start', json={}).status_code == 200
    blocked = parent.post('/api/auth/pairing/start', json={})
    assert blocked.status_code == 429
    assert 1 <= int(blocked.headers['Retry-After']) <= 600
    with Session(db.get_engine()) as session:
        session.query(PairingRate).one().resets_at = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=17)
        session.commit()
    blocked = parent.post('/api/auth/pairing/start', json={})
    assert blocked.status_code == 429
    assert 1 <= int(blocked.headers['Retry-After']) <= 17
    for _ in range(30):
        assert parent.post('/api/manage/pairing/confirm', json={'code': '22222222'}).status_code == 404
    assert parent.post('/api/manage/pairing/confirm', json={'code': '22222222'}).status_code == 429


def test_concurrent_pairing_confirm_claims_one_family(parent):
    row = start(parent)
    with Session(db.get_engine()) as session:
        session.add(User(id='other', family_id='f2', name='other', role='admin', password_hash=hash_password('other-password')))
        session.commit()
    with TestClient(create_app()) as other:
        auth = other.post('/api/manage/auth/login', json={'username': 'other', 'password': 'other-password'})
        other.headers['X-CSRF-Token'] = auth.json()['csrfToken']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda app: app.post('/api/manage/pairing/confirm', json={'code': row['userCode']}), [parent, other]))
        assert sorted(result.status_code for result in results) == [200, 404]
        owner = 'u1' if results[0].status_code == 200 else 'other'
    auth = parent.post('/api/auth/pairing/poll', json={'deviceCode': row['deviceCode']}).json()['auth']
    assert auth['user']['id'] == owner
    assert auth['user']['familyId'] == ('f1' if owner == 'u1' else 'f2')


def test_device_binding_is_durable_and_only_parent_can_cancel(parent):
    row = start(parent)
    parent.post('/api/manage/pairing/confirm', json={'code': row['userCode']})
    auth = parent.post('/api/auth/pairing/poll', json={'deviceCode': row['deviceCode']}).json()['auth']
    with Session(db.get_engine()) as session:
        session.get(RefreshToken, hash_refresh_token(auth['refreshToken'])).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(days=60)
        session.commit()
    for _ in range(2):
        refreshed = parent.post('/api/auth/refresh', json={'refreshToken': auth['refreshToken']})
        assert refreshed.status_code == 200
        assert refreshed.json()['refreshToken'] == auth['refreshToken']
        assert refreshed.json()['deviceId'] == auth['deviceId']
    assert parent.post('/api/auth/logout', json={'refreshToken': auth['refreshToken']}).status_code == 403
    assert parent.post(f"/api/manage/devices/{auth['deviceId']}/revoke").status_code == 200
    assert parent.post('/api/auth/refresh', json={'refreshToken': auth['refreshToken']}).status_code == 401


def test_account_refresh_still_expires(parent):
    auth = parent.post('/api/auth/login', json={'username': 'parent', 'password': 'test-parent'}).json()
    with Session(db.get_engine()) as session:
        session.get(RefreshToken, hash_refresh_token(auth['refreshToken'])).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        session.commit()
    assert parent.post('/api/auth/refresh', json={'refreshToken': auth['refreshToken']}).status_code == 401


def test_concurrent_poll_delivers_one_device_and_expired_approval_cannot_issue(parent):
    row = start(parent)
    parent.post('/api/manage/pairing/confirm', json={'code': row['userCode']})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: parent.post('/api/auth/pairing/poll', json={'deviceCode': row['deviceCode']}), range(2)))
    assert sorted(result.status_code for result in results) == [200, 429]
    with Session(db.get_engine()) as session:
        assert session.query(Device).count() == 1
    another = start(parent)
    parent.post('/api/manage/pairing/confirm', json={'code': another['userCode']})
    with Session(db.get_engine()) as session:
        session.get(DevicePairing, digest(another['deviceCode'])).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        session.commit()
    assert parent.post('/api/auth/pairing/poll', json={'deviceCode': another['deviceCode']}).json()['status'] == 'expired'
    with Session(db.get_engine()) as session:
        assert session.query(Device).count() == 1


def test_tv_reset_revokes_only_its_own_binding_and_parent_tokens_cannot_reset(parent):
    def bind():
        row = start(parent)
        assert parent.post('/api/manage/pairing/confirm', json={'code': row['userCode']}).status_code == 200
        return parent.post('/api/auth/pairing/poll', json={'deviceCode': row['deviceCode']}).json()['auth']
    first, other = bind(), bind()
    assert parent.post('/api/auth/pairing/reset').status_code == 403
    route = '/api/auth/pairing/reset'
    headers = {'Authorization': 'Bearer ' + first['accessToken']}
    # An injected ID cannot change the target: identity is derived from the signed token.
    result = parent.post(route, headers=headers, json={'deviceId': other['deviceId']})
    assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
    assert parent.get('/api/home', headers=headers).status_code == 401
    assert parent.post('/api/auth/refresh', json={'refreshToken': first['refreshToken']}).status_code == 401
    assert parent.post('/api/auth/refresh', json={'refreshToken': other['refreshToken']}).status_code == 200
    assert parent.post(route, headers=headers).status_code == 401
    with Session(db.get_engine()) as session:
        assert session.get(Device, first['deviceId']).revoked
        assert not session.get(Device, other['deviceId']).revoked


def test_four_digit_codes_keep_leading_zero_and_resolve_collisions(parent, monkeypatch):
    monkeypatch.setattr('mollytime_server.api.pairing.secrets.randbelow', lambda _: 7)
    with ThreadPoolExecutor(max_workers=2) as pool:
        rows = list(pool.map(lambda _: start(parent), range(2)))
    assert {row['userCode'] for row in rows} == {'0007', '0008'}
    for row in rows:
        assert parent.get(f"/api/manage/pairing/{row['userCode']}").status_code == 200
        assert parent.post('/api/manage/pairing/confirm', json={'code': row['userCode']}).status_code == 200


def test_four_digit_code_space_exhaustion_and_expiry_reuse(parent, monkeypatch):
    monkeypatch.setattr('mollytime_server.api.pairing.CODE_SPACE', 2)
    monkeypatch.setattr('mollytime_server.api.pairing.secrets.randbelow', lambda _: 0)
    first, second = start(parent), start(parent)
    assert {first['userCode'], second['userCode']} == {'0000', '0001'}
    parent.post('/api/auth/pairing/cancel', json={'deviceCode': first['deviceCode']})
    assert parent.post('/api/auth/pairing/start', json={}).status_code == 503
    with Session(db.get_engine()) as session:
        session.get(DevicePairing, digest(first['deviceCode'])).expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)
        session.commit()
    assert start(parent)['userCode'] == '0000'


def test_pairing_rejects_non_numeric_and_wrong_length_codes(parent):
    for code in ('abcd', '123', '12345', '１２３４', '12-34'):
        assert parent.get(f"/api/manage/pairing/{code}").status_code == 404
