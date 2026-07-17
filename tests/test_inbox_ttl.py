# -*- coding: utf-8 -*-
"""inbox 期間常駐（TTL・v3.70）と未読戻し（read:false）の契約。

- expires_at / ttl_days: 期限内は persistent 同様の常駐（既読化しない・
  inbox_check の persistent[] に本文つきで載る）
- 期限切れはチェック時に既読アーカイブへ自動降格
- persistent との排他
- inbox_update の read:false（既読→未読の書き戻し）と期限変更
"""


def _post_rest(server, title, to='code', **kw):
    r = server.post('/api/inbox', json={'to': to, 'title': title, 'body': 'TTL本文', **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_ttl_post_and_standing(server):
    msg = _post_rest(server, 'ttl常駐テスト', ttl_days=1)
    assert msg['persistent'] is False
    assert msg['expires_at']  # ttl_days から期限が計算される

    # 期限内は inbox_check の persistent[] に本文つきで載る（expires_at で区別）
    d = server.tool('inbox_check', {'to': 'code'})
    standing = next(m for m in d['persistent'] if m['id'] == msg['id'])
    assert standing['body'] == 'TTL本文'
    assert standing['expires_at'] == msg['expires_at']
    assert msg['id'] not in d['non_persistent_unread_ids']

    # inbox_read しても既読にならない（persistent と同じ保護）
    server.tool('inbox_read', {'id': msg['id']})
    r = server.get(f"/api/inbox/{msg['id']}")
    assert r.json()['read'] is False

    # REST PATCH /read でも既読にならない
    r = server.patch(f"/api/inbox/{msg['id']}/read")
    assert r.status_code == 200 and r.json()['read'] is False


def test_ttl_expired_demotion(server):
    msg = _post_rest(server, 'ttl期限切れテスト', expires_at='2020-01-01T00:00:00+09:00')
    # チェック時に既読アーカイブへ自動降格
    d = server.tool('inbox_check', {'to': 'code'})
    assert all(m['id'] != msg['id'] for m in d['persistent'])
    assert msg['id'] not in d['non_persistent_unread_ids']
    r = server.get(f"/api/inbox/{msg['id']}")
    assert r.json()['read'] is True


def test_ttl_exclusive_with_persistent(server):
    r = server.post('/api/inbox', json={'to': 'code', 'title': 'x', 'body': 'y',
                                        'persistent': True, 'ttl_days': 1})
    assert r.status_code == 400
    r = server.post('/api/inbox', json={'to': 'code', 'title': 'x', 'body': 'y',
                                        'expires_at': '2030-01-01T00:00:00+09:00',
                                        'ttl_days': 1})
    assert r.status_code == 400
    # MCP 側も同じエラー
    d = server.tool('inbox_post', {'to': 'code', 'title': 'x', 'body': 'y',
                                   'persistent': True, 'ttl_days': 1})
    assert 'error' in d


def test_ttl_update_extend_and_clear(server):
    msg = _post_rest(server, 'ttl更新テスト', expires_at='2020-01-01T00:00:00+09:00')
    server.get('/api/inbox?to=code')  # 降格を発火
    assert server.get(f"/api/inbox/{msg['id']}").json()['read'] is True

    # 期限を延長すると未読・常駐に復帰する
    r = server.patch(f"/api/inbox/{msg['id']}", json={'ttl_days': 1})
    d = r.json()
    assert r.status_code == 200
    assert d['read'] is False and d['persistent'] is False and d['expires_at']

    # persistent=true を指定すると期限は解除される（排他）
    r = server.patch(f"/api/inbox/{msg['id']}", json={'persistent': True})
    d = r.json()
    assert d['persistent'] is True and d['expires_at'] is None

    # expires_at: null で期限解除（通常メッセージ化）
    r = server.patch(f"/api/inbox/{msg['id']}",
                     json={'persistent': False, 'expires_at': None})
    d = r.json()
    assert d['persistent'] is False and d['expires_at'] is None
    server.delete(f"/api/inbox/{msg['id']}")


def test_inbox_update_read_false(server):
    msg = _post_rest(server, '未読戻しテスト')
    server.patch(f"/api/inbox/{msg['id']}/read")
    assert server.get(f"/api/inbox/{msg['id']}").json()['read'] is True

    # REST PATCH で既読→未読へ書き戻し
    r = server.patch(f"/api/inbox/{msg['id']}", json={'read': False})
    assert r.status_code == 200 and r.json()['read'] is False

    # MCP inbox_update でも同じ
    server.tool('inbox_read', {'id': msg['id']})  # 既読化
    assert server.get(f"/api/inbox/{msg['id']}").json()['read'] is True
    d = server.tool('inbox_update', {'id': msg['id'], 'read': False})
    assert d['read'] is False
    server.delete(f"/api/inbox/{msg['id']}")
