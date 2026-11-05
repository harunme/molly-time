# ruff: noqa: F811 -- shared isolated fixtures
import datetime as dt

from sqlalchemy import select, update
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db, usage
from mollytime_server.management_models import UploadSession
from mollytime_server.models import MediaFile
from mollytime_server.share_models import ContentShare, ShareFile
from mollytime_server.storage_snapshots import FamilyStorageSnapshot, save_snapshots


def test_stable_settings_skip_media_queries_and_file_measurement(parent, monkeypatch):
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 18
    def unexpected(*args):
        raise AssertionError('stable reads must reuse the storage snapshot')
    monkeypatch.setattr(usage, 'object_rows', unexpected)
    monkeypatch.setattr(usage, 'measure_objects', unexpected)
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 18
    assert parent.get('/api/manage/usage').json()['storage']['usedBytes'] == 18


def test_commit_invalidates_but_rollback_does_not(parent, monkeypatch):
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 18
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id='remote', family_id='f1', item_id='e1', kind='video',
                              storage='oss', path='remote.mp4', size_bytes=1000))
        session.flush()
        session.rollback()
    original = usage.measure_objects
    monkeypatch.setattr(usage, 'measure_objects', lambda *args: (_ for _ in ()).throw(AssertionError('rollback invalidated snapshot')))
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 18
    monkeypatch.setattr(usage, 'measure_objects', original)
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id='remote', family_id='f1', item_id='e1', kind='video',
                              storage='oss', path='remote.mp4', size_bytes=1000))
        session.commit()
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 1018
    with Session(db.get_engine()) as session:
        session.execute(update(MediaFile).where(MediaFile.id == 'remote').values(kind='deleted'))
        session.commit()
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 18


def test_late_old_snapshot_cannot_mask_new_committed_file(parent):
    parent.get('/api/manage/settings')
    with Session(db.get_engine()) as session:
        old = session.execute(select(FamilyStorageSnapshot.__table__).where(FamilyStorageSnapshot.family_id == 'f1')).mappings().one()
        old = dict(old)
        session.add(MediaFile(id='remote', family_id='f1', item_id='e1', kind='video',
                              storage='oss', path='remote.mp4', size_bytes=1000))
        session.commit()
    # A calculation begun before the writer returns after the writer committed.
    save_snapshots(db.get_engine(), [old])
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 1018


def test_reservations_and_offsets_update_without_rescanning_catalog(parent, monkeypatch):
    parent.get('/api/manage/settings')
    with Session(db.get_engine()) as session:
        session.add(UploadSession(id='upload', family_id='f1', item_id='e1', filename='x.mp4',
                                  size=1000, offset=250, status='uploading', kind='video', fingerprint='x'))
        session.commit()
    def unexpected(*args):
        raise AssertionError('upload chunks should not rescan catalog')
    monkeypatch.setattr(usage, 'measure_objects', unexpected)
    result = parent.get('/api/manage/usage').json()['storage']
    assert (result['usedBytes'], result['reservedBytes'], result['pendingBytes']) == (18, 1000, 250)
    with Session(db.get_engine()) as session:
        session.get(UploadSession, 'upload').offset = 500
        session.commit()
    assert parent.get('/api/manage/usage').json()['storage']['pendingBytes'] == 500


def test_share_pin_expires_even_without_a_database_write(parent, monkeypatch):
    now = dt.datetime.now(dt.UTC)
    with Session(db.get_engine()) as session:
        session.add(ContentShare(id='pin', family_id='f1', created_by='u1', code_hash='pin',
                                 expires_at=now + dt.timedelta(minutes=5), snapshot={}))
        session.flush()
        session.add(ShareFile(id='pin-file', share_id='pin', source_media_id='retired',
                             source_item_id='e1', storage='oss', path='pin.mp4', size_bytes=1000, metadata_={}))
        session.commit()
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 1018
    class Later(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return (now + dt.timedelta(minutes=6)).astimezone(tz) if tz else (now + dt.timedelta(minutes=6)).replace(tzinfo=None)
    monkeypatch.setattr(dt, 'datetime', Later)
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 18


def test_other_family_mutations_do_not_invalidate_own_snapshot(parent, monkeypatch):
    parent.get('/api/manage/settings')
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id='other', family_id='f2', item_id='e2', kind='video',
                              storage='oss', path='other.mp4', size_bytes=2000))
        session.commit()
    def unexpected(*args):
        raise AssertionError('another family invalidated our snapshot')
    monkeypatch.setattr(usage, 'measure_objects', unexpected)
    assert parent.get('/api/manage/settings').json()['storage']['usedBytes'] == 18
