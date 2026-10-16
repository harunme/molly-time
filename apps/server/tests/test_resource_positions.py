# ruff: noqa: F811
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.management_models import ResourcePosition
from mollytime_server.models import Item


def add_episode(parent, name, index):
    response = parent.post('/api/manage/resources', json={
        'name': name, 'type': 'Episode', 'indexNumber': index, 'parentId': 'season',
    })
    assert response.status_code == 200
    return response.json()['id']


def test_manual_positions_persist_across_pages_without_changing_episode_numbers(parent):
    keys = [add_episode(parent, f'手动排列 {index}', index) for index in range(1, 5)]
    path = '/api/manage/resources'
    params = {'parentId': 'season', 'sort': 'manual', 'ids': ','.join(keys), 'pageSize': 2}
    assert parent.put(f'/api/manage/resources/{keys[3]}/position', json={'beforeId': keys[0]}).status_code == 200
    first = parent.get(path, params={**params, 'page': 1}).json()
    second = parent.get(path, params={**params, 'page': 2}).json()
    assert [row['id'] for row in first['items'] + second['items']] == [keys[3], *keys[:3]]
    assert first['items'][0]['indexNumber'] == 4
    # Dropping at the end of a page uses its preceding visible card as an anchor,
    # rather than accidentally moving the card to the end of the entire catalog.
    assert parent.put(f'/api/manage/resources/{keys[3]}/position', json={'afterId': keys[1]}).status_code == 200
    rows = parent.get(path, params={**params, 'page': 1, 'pageSize': 20}).json()['items']
    assert [row['id'] for row in rows] == [keys[0], keys[1], keys[3], keys[2]]
    natural = parent.get(path, params={**params, 'sort': 'index', 'page': 1, 'pageSize': 20}).json()['items']
    assert [row['id'] for row in natural] == keys


def test_positions_validate_sibling_scope_and_archive_state(parent):
    key = add_episode(parent, '可移动', 1)
    with Session(db.get_engine()) as session:
        session.add(Item(id='foreign-sort', family_id='f2', type='Episode', name='外部', parent_id=None))
        session.commit()
    assert parent.put(f'/api/manage/resources/{key}/position', json={'beforeId': 'series'}).status_code == 422
    assert parent.put(f'/api/manage/resources/{key}/position', json={'beforeId': 'foreign-sort'}).status_code == 422
    assert parent.put('/api/manage/resources/foreign-sort/position', json={}).status_code == 404
    assert parent.put(f'/api/manage/resources/{key}/position', json={'beforeId': 'e1', 'afterId': 'e1'}).status_code == 422
    assert parent.post(f'/api/manage/resources/{key}/archive').status_code == 200
    assert parent.put(f'/api/manage/resources/{key}/position', json={}).status_code == 409
    with Session(db.get_engine()) as session:
        assert session.query(ResourcePosition).count() == 0


def test_moving_to_another_container_clears_old_position(parent):
    key = add_episode(parent, '带位置的视频', 8)
    assert parent.put(f'/api/manage/resources/{key}/position', json={'beforeId': 'e1'}).status_code == 200
    assert parent.post(f'/api/manage/resources/{key}/move', json={'folderId': 'series'}).status_code == 200
    with Session(db.get_engine()) as session:
        assert session.get(ResourcePosition, key) is None
        assert session.get(Item, key).index_number == 8


def test_root_collections_can_be_manually_arranged(parent):
    first = parent.post('/api/manage/resources', json={'type': 'Series', 'name': 'AAA'}).json()['id']
    second = parent.post('/api/manage/resources', json={'type': 'Series', 'name': 'ZZZ'}).json()['id']
    assert parent.put(f'/api/manage/resources/{second}/position', json={'beforeId': first}).status_code == 200
    rows = parent.get('/api/manage/resources', params={'sort': 'manual'}).json()
    keys = [row['id'] for row in rows]
    assert keys.index(second) < keys.index(first)
