# ruff: noqa: F811
import datetime as dt

from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.management_models import ResourceState
from mollytime_server.models import Item


def create(parent, **body):
    response = parent.post('/api/manage/resources', json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_season_hierarchy_move_and_scoped_stats(parent):
    season = create(parent, type='Season', name='第二季', parentId='series', indexNumber=2)
    direct = create(parent, type='Episode', name='旧视频', parentId='series', indexNumber=12)
    children = parent.get('/api/manage/resources', params={'parentId': 'series', 'page': 1}).json()
    assert {row['id'] for row in children['items']} == {'season', season['id'], direct['id']}
    assert 'e1' not in {row['id'] for row in children['items']}
    result = parent.post(f"/api/manage/resources/{direct['id']}/move", json={'folderId': season['id']})
    assert result.status_code == 200
    assert result.json()['parentId'] == season['id']
    episodes = parent.get('/api/manage/resources', params={'parentId': season['id'], 'page': 1}).json()
    assert [row['id'] for row in episodes['items']] == [direct['id']]
    assert parent.get(f"/api/manage/resources/stats?folderId={season['id']}").json()['videoCount'] == 1
    candidates = parent.get('/api/manage/resources', params={
        'parentId': 'series', 'summary': True, 'resourceType': 'Season', 'page': 1,
    }).json()
    assert {row['id'] for row in candidates['items']} == {'season', season['id']}
    duplicate = create(parent, type='Episode', name='旧视频', parentId='season')
    assert parent.post(f"/api/manage/resources/{duplicate['id']}/move", json={'folderId': season['id']}).status_code == 409
    with Session(db.get_engine()) as session:
        session.add(Item(id='foreign-season', family_id='f2', type='Season', name='外部季'))
        session.commit()
    assert parent.post(f"/api/manage/resources/{direct['id']}/move", json={'folderId': 'foreign-season'}).status_code == 404
    assert parent.post(f"/api/manage/resources/{season['id']}/archive").status_code == 200
    assert parent.post(f"/api/manage/resources/{duplicate['id']}/move", json={'folderId': season['id']}).status_code == 409


def test_sorting_happens_before_pagination_and_places_missing_numbers_last(parent):
    with Session(db.get_engine()) as session:
        for index, name, number in [(0, 'C', 10), (1, 'B', 2), (2, 'A', None)]:
            key = f'sort-{index}'
            session.add(Item(id=key, family_id='f1', type='Episode', name=name,
                             sort_name=name, index_number=number, parent_id='season',
                             runtime_ticks=(index + 1) * 10_000_000))
            session.flush()
            session.add(ResourceState(item_id=key, status='published', ready=True,
                                      published_at=dt.datetime(2026, 1, index + 1)))
        session.commit()
    def ordered(sort):
        return [parent.get('/api/manage/resources', params={
            'parentId': 'season', 'sort': sort, 'page': page, 'pageSize': 1,
            'ids': 'sort-0,sort-1,sort-2',
        }).json()['items'][0]['id'] for page in (1, 2, 3)]
    assert ordered('index') == ['sort-1', 'sort-0', 'sort-2']
    assert ordered('index-desc') == ['sort-0', 'sort-1', 'sort-2']
    assert ordered('name') == ['sort-2', 'sort-1', 'sort-0']
    assert ordered('name-desc') == ['sort-0', 'sort-1', 'sort-2']
    assert ordered('published') == ordered('duration') == ['sort-2', 'sort-1', 'sort-0']
    assert parent.get('/api/manage/resources?sort=invalid').status_code == 422
