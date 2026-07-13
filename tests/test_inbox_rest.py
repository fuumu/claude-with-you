# -*- coding: utf-8 -*-
"""inbox REST（/api/inbox*）の契約。TS-1 リング3（inbox スライス）に先立つ追補。

MCP ツール側の契約は test_inbox.py。ここは admin.html 等が使う REST 面を固定する。
"""


def _post_rest(server, title='REST件名', body='REST本文', to='code', **kw):
    r = server.post('/api/inbox', json={'to': to, 'title': title, 'body': body, **kw})
    assert r.status_code == 201
    return r.json()


def test_rest_inbox_post_shape_and_list(server):
    msg = _post_rest(server, title='rest一覧テスト', from_model='claude-test')
    assert msg['id'].startswith('inbox_')
    assert msg['to'] == 'code' and msg['read'] is False and msg['persistent'] is False
    assert msg['from'] == 'code'
    assert msg['from_model'] == ['claude-test']  # 文字列→配列正規化
    assert msg['reply_to_id'] is None

    # 既定はサマリー（count + ids）
    r = server.get('/api/inbox?to=code')
    d = r.json()
    assert r.status_code == 200 and msg['id'] in d['ids'] and d['count'] >= 1

    # full=true で本文込み・status=new で未読のみ
    r = server.get('/api/inbox?to=code&full=true&status=new')
    full = r.json()
    assert isinstance(full, list)
    assert any(m['id'] == msg['id'] for m in full)


def test_rest_inbox_post_requires_to_and_title(server):
    r = server.post('/api/inbox', json={'to': 'code'})
    assert r.status_code == 400
    r = server.post('/api/inbox', json={'title': 'x'})
    assert r.status_code == 400


def test_rest_inbox_get_read_unread(server):
    msg = _post_rest(server, title='rest既読テスト')
    mid = msg['id']

    r = server.get(f'/api/inbox/{mid}')
    assert r.status_code == 200 and r.json()['read'] is False

    r = server.patch(f'/api/inbox/{mid}/read')
    assert r.status_code == 200 and r.json()['read'] is True

    r = server.patch(f'/api/inbox/{mid}/unread')
    assert r.status_code == 200 and r.json()['read'] is False

    r = server.get('/api/inbox/inbox_99999999_000000_ffffffff')
    assert r.status_code == 404


def test_rest_inbox_persistent_is_not_marked_read(server):
    msg = _post_rest(server, title='rest常駐テスト', persistent=True)
    mid = msg['id']
    # persistent は /read でも既読にならない（MCP と同じ振る舞い）
    r = server.patch(f'/api/inbox/{mid}/read')
    assert r.status_code == 200 and r.json()['read'] is False
    # persistent フラグの付け外し
    r = server.patch(f'/api/inbox/{mid}/persistent?value=false')
    assert r.status_code == 200 and r.json()['persistent'] is False


def test_rest_inbox_partial_update_and_delete(server):
    msg = _post_rest(server, title='rest更新前')
    mid = msg['id']

    r = server.patch(f'/api/inbox/{mid}', json={'title': 'rest更新後', 'persistent': True})
    d = r.json()
    assert r.status_code == 200 and d['title'] == 'rest更新後' and d['persistent'] is True
    assert d['body'] == 'REST本文'  # 未指定キーは維持

    r = server.delete(f'/api/inbox/{mid}')
    assert r.status_code == 200 and r.json()['deleted'] == mid
    assert server.get(f'/api/inbox/{mid}').status_code == 404
    assert server.delete(f'/api/inbox/{mid}').status_code == 404
