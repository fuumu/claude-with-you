# -*- coding: utf-8 -*-
"""UserCoreMemory REST API（/api/coremem*）の契約。

MCP ツール側の契約は test_coremem.py。ここは TS-1 リング3で移行する
REST 面（一覧・保存・版指定読み・削除・エラー系）を固定する。
"""


def test_rest_save_returns_201_and_versions_increment(server):
    r1 = server.post('/api/coremem/r3c_note.md', json={'content': '# rest v1'})
    assert r1.status_code == 201
    d1 = r1.json()
    assert d1['name'] == 'r3c_note.md'
    assert d1['version'] == 1 and d1['version_str'] == '001'

    r2 = server.post('/api/coremem/r3c_note.md', json={'content': '# rest v2'})
    assert r2.json()['version'] == 2


def test_rest_read_latest_and_specific_version(server):
    latest = server.get('/api/coremem/r3c_note.md')
    assert latest.status_code == 200
    d = latest.json()
    assert d['content'] == '# rest v2'
    assert d['version'] is None  # 最新読みは version: null

    old = server.get('/api/coremem/r3c_note.md?version=1')
    assert old.status_code == 200
    assert old.json()['content'] == '# rest v1'
    assert old.json()['version'] == 1


def test_rest_list_shape_and_version(server):
    r = server.get('/api/coremem')
    assert r.status_code == 200
    items = r.json()
    assert isinstance(items, list)
    by_name = {i['name']: i for i in items}
    assert 'r3c_note.md' in by_name
    entry = by_name['r3c_note.md']
    assert entry['version'] == 2
    assert 'updated_at' in entry


def test_rest_save_without_content_is_400(server):
    r = server.post('/api/coremem/r3c_bad.md', json={'note': 'contentキーなし'})
    assert r.status_code == 400
    r2 = server.post('/api/coremem/r3c_bad.md',
                     data='not json', headers={'Content-Type': 'text/plain'})
    assert r2.status_code in (400, 415)


def test_rest_read_missing_is_404(server):
    assert server.get('/api/coremem/r3c_nothing.md').status_code == 404
    assert server.get('/api/coremem/r3c_note.md?version=99').status_code == 404


def test_rest_delete_removes_all_versions(server):
    server.post('/api/coremem/r3c_gone.md', json={'content': '1'})
    server.post('/api/coremem/r3c_gone.md', json={'content': '2'})
    r = server.delete('/api/coremem/r3c_gone.md')
    assert r.status_code == 200
    assert r.json() == {'deleted': 'r3c_gone.md'}
    assert server.get('/api/coremem/r3c_gone.md').status_code == 404
    assert server.get('/api/coremem/r3c_gone.md?version=1').status_code == 404
    # 再削除は 404
    assert server.delete('/api/coremem/r3c_gone.md').status_code == 404


def test_rest_requires_auth(server):
    anon = server.anon()
    assert anon.get(server.base_url + '/api/coremem').status_code == 401
    assert anon.post(server.base_url + '/api/coremem/r3c_note.md',
                     json={'content': 'x'}).status_code == 401
