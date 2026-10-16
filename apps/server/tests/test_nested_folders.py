# ruff: noqa: F811
from sqlalchemy.orm import Session
from test_management import native_token, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.models import Item


def create(parent, name, kind='Series', parent_id=None, index=None):
    response = parent.post('/api/manage/resources', json={
        'name': name, 'type': kind, 'parentId': parent_id, 'indexNumber': index,
    })
    assert response.status_code == 200, response.text
    return response.json()['id']


def test_nested_folders_keep_children_paths_stats_playback_and_sharing(parent):
    group = create(parent, '我的分组')
    second = create(parent, '另一层分组')
    # The fixture includes a playable e1 under series / season.
    assert parent.post('/api/manage/resources/series/move', json={'folderId': group}).status_code == 200
    assert parent.post(f'/api/manage/resources/{group}/move', json={'folderId': second}).status_code == 200
    root = parent.get('/api/manage/resources').json()
    assert {row['id'] for row in root} == {second}
    children = parent.get(f'/api/manage/resources?parentId={group}').json()
    assert [row['id'] for row in children] == ['series']
    detail = parent.get('/api/manage/resources/season').json()
    assert [row['id'] for row in detail['ancestors']] == [second, group, 'series']
    assert parent.get(f'/api/manage/resources/stats?folderId={second}').json()['videoCount'] == 1
    assert [row['id'] for row in parent.get(f'/api/manage/folders/{second}/videos').json()] == ['e1']
    headers = {**native_token(), 'X-Molly-Home-Schema': '2'}
    for query in ('', '?page=1&pageSize=20'):
        response = parent.get(f'/api/series/{second}/playlist{query}', headers=headers)
        assert response.status_code == 200, response.text
        assert [row['id'] for row in response.json()['episodes']] == ['e1']
    assert parent.get('/api/episodes/e1', headers=headers).json()['seriesId'] == second
    for query in ('', '?page=1&pageSize=20'):
        home = parent.get('/api/home' + query, headers=headers).json()
        library = next(row for row in home['rows'] if row['title'] == '我的媒体库')
        assert [item['id'] for item in library['items']] == [second]
    share = parent.post('/api/manage/shares', json={'resourceId': second})
    assert share.status_code == 200, share.text
    assert parent.post(f'/api/manage/resources/{second}/archive').status_code == 200
    assert parent.post(f'/api/manage/trash/{second}/restore').status_code == 200
    assert parent.get('/api/manage/resources/season').json()['parentId'] == 'series'


def test_move_rejects_cycles_cross_family_and_duplicate_folders(parent):
    group = create(parent, '分组')
    assert parent.post('/api/manage/resources/series/move', json={'folderId': group}).status_code == 200
    assert parent.post(f'/api/manage/resources/{group}/move', json={'folderId': group}).status_code == 422
    assert parent.post(f'/api/manage/resources/{group}/move', json={'folderId': 'season'}).status_code == 422
    assert parent.post(f'/api/manage/resources/{group}/move', json={'folderId': 'e1'}).status_code == 422
    with Session(db.get_engine()) as session:
        session.add(Item(id='foreign-folder', family_id='f2', type='Series', name='外部'))
        session.commit()
    assert parent.post(f'/api/manage/resources/{group}/move', json={'folderId': 'foreign-folder'}).status_code == 404
    original = create(parent, '同名文件夹')
    clone = create(parent, '同名文件夹', 'Season', 'series')
    target = create(parent, '目标季', 'Season', 'series')
    assert parent.post(f'/api/manage/resources/{clone}/move', json={'folderId': target}).status_code == 200
    other = create(parent, '同名文件夹', 'Season', 'series')
    assert parent.post(f'/api/manage/resources/{other}/move', json={'folderId': target}).status_code == 409
    # Containers can move back out; numbering and their children remain intact.
    assert parent.post('/api/manage/resources/series/move', json={'folderId': None}).status_code == 200
    assert parent.get('/api/manage/resources/series').json()['parentId'] is None
    assert parent.post('/api/manage/resources/season/move', json={'folderId': None}).status_code == 422
    assert parent.post(f'/api/manage/resources/{original}/archive').status_code == 200
    assert parent.post(f'/api/manage/resources/{group}/move', json={'folderId': original}).status_code == 409


def test_nested_seasons_play_and_parent_clock_updates(parent):
    from mollytime_server.catalog_versions import version
    group = create(parent, '父动画片')
    extra = create(parent, '第 2 季', 'Season', 'series', 2)
    assert parent.post('/api/manage/resources/season/move', json={'folderId': extra}).status_code == 200
    assert parent.post('/api/manage/resources/series/move', json={'folderId': group}).status_code == 200
    with Session(db.get_engine()) as session:
        # Moving a deep descendant invalidates every enclosing collection.
        before = version(session, 'f1', 'folder:' + group)
    assert parent.patch('/api/manage/resources/e1', json={'name': '新集名', 'indexNumber': 7}).status_code == 200
    with Session(db.get_engine()) as session:
        after = version(session, 'f1', 'folder:' + group)
    assert before != after
    response = parent.get(f'/api/series/{group}/playlist?page=1', headers=native_token())
    assert response.status_code == 200, response.text
    assert response.json()['episodes'][0]['indexNumber'] == 7
