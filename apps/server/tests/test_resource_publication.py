# ruff: noqa: F811
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.management_models import ResourceState
from mollytime_server.models import Item


def bulk(parent, **body):
    return parent.post('/api/manage/resources/publication', json=body)


def test_bulk_publication_skips_unready_and_preserves_hidden_folders(parent):
    pending = parent.post('/api/manage/resources', json={
        'type': 'Episode', 'name': 'Pending', 'parentId': 'season',
    }).json()['id']
    assert parent.post('/api/manage/resources/series/unpublish').status_code == 200
    assert bulk(parent, action='unpublish', ids=['e1']).json()['changed'] == 1
    result = bulk(parent, action='publish', ids=['e1', 'e1', pending]).json()
    assert result['changed'] == 1
    assert result['hidden'] == 1
    assert [row['id'] for row in result['skipped']] == [pending]
    episode = parent.get('/api/manage/resources/e1').json()
    assert episode['status'] == 'published'
    assert episode['hiddenByFolder'] == {'id': 'series', 'name': 'Stories'}
    assert parent.get('/api/manage/resources/series').json()['status'] == 'draft'
    assert bulk(parent, action='publish', ids=['e1']).json()['unchanged'] == 1
    assert parent.post('/api/manage/resources/series/publish').status_code == 200
    assert parent.get('/api/manage/resources/e1').json()['hiddenByFolder'] is None
    assert parent.get(f'/api/manage/resources/{pending}').json()['status'] == 'draft'


def test_recursive_publish_includes_other_pages_but_excludes_trash(parent):
    with Session(db.get_engine()) as session:
        for index in range(24):
            session.add(Item(id=f'pending-{index}', family_id='f1', type='Episode',
                             name=f'Pending {index}', parent_id='season'))
        session.flush()
        for index in range(24):
            session.add(ResourceState(item_id=f'pending-{index}', status='draft', ready=False))
        session.add(Item(id='trashed-folder', family_id='f1', type='Series', name='Trash', parent_id='series'))
        session.flush()
        session.add(ResourceState(item_id='trashed-folder', status='archived', ready=True))
        session.add(Item(id='trashed-video', family_id='f1', type='Episode', name='Trash video', parent_id='trashed-folder'))
        session.commit()
    bulk(parent, action='unpublish', ids=['e1'])
    result = bulk(parent, action='publish', folderId='series').json()
    assert result['changed'] == 1
    assert len(result['skipped']) == 24
    assert 'trashed-video' not in {item['id'] for item in result['skipped']}


def test_selection_is_validated_atomically_and_family_scoped(parent):
    with Session(db.get_engine()) as session:
        session.add(Item(id='foreign', family_id='f2', type='Episode', name='Foreign'))
        session.commit()
    for invalid in ['foreign', 'missing', 'series']:
        response = bulk(parent, action='unpublish', ids=['e1', invalid])
        assert response.status_code in (404, 422)
        assert parent.get('/api/manage/resources/e1').json()['status'] == 'published'
    assert bulk(parent, action='publish', folderId='foreign').status_code == 404
    assert bulk(parent, action='publish', folderId='e1').status_code == 422
    assert bulk(parent, action='archive', ids=['e1']).status_code == 422
    assert bulk(parent, action='publish').status_code == 422
    assert bulk(parent, action='publish', folderId='series', ids=['e1']).status_code == 422
    assert bulk(parent, action='publish', ids=['e1'] * 201).status_code == 422
    assert parent.post('/api/manage/resources/e1/archive').status_code == 200
    assert bulk(parent, action='publish', ids=['e1']).status_code == 409
