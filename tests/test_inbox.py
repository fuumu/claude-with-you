# -*- coding: utf-8 -*-
"""inbox 5ツール（post / check / read＋peek / update / delete）の契約"""


def _post(server, title='件名', body='本文', to='code', **kw):
    return server.tool('inbox_post', {'to': to, 'title': title, 'body': body, **kw})


def test_post_and_check_unread(server):
    p = _post(server, title='TS0未読テスト')
    assert p['id'].startswith('inbox_')
    d = server.tool('inbox_check', {'to': 'code'})
    assert p['id'] in d['non_persistent_unread_ids']
    assert d['non_persistent_unread_count'] >= 1
    assert isinstance(d['persistent'], list)


def test_read_marks_read_but_peek_does_not(server):
    """inbox_read は既読化する。peek=true（v3.60）は既読フラグを変えない"""
    p = _post(server, title='peekテスト', body='のぞき見')

    peeked = server.tool('inbox_read', {'id': p['id'], 'peek': True})
    assert peeked['body'] == 'のぞき見'
    assert peeked['read'] is False  # peek では既読にならない

    d = server.tool('inbox_check', {'to': 'code'})
    assert p['id'] in d['non_persistent_unread_ids']  # まだ未読

    r = server.tool('inbox_read', {'id': p['id']})
    assert r['read'] is True

    d2 = server.tool('inbox_check', {'to': 'code'})
    assert p['id'] not in d2['non_persistent_unread_ids']


def test_read_not_found(server):
    d = server.tool('inbox_read', {'id': 'inbox_00000000_000000_nothing'})
    assert 'error' in d


def test_persistent_message_full_body_in_check(server):
    """persistent=true は常駐扱い：check の persistent[] に本文ごと入り、read しても既読にならない"""
    p = _post(server, title='常駐テスト', body='常駐本文', persistent=True)
    d = server.tool('inbox_check', {'to': 'code'})
    mine = [m for m in d['persistent'] if m['id'] == p['id']]
    assert len(mine) == 1
    assert mine[0]['body'] == '常駐本文'

    r = server.tool('inbox_read', {'id': p['id']})
    assert r['read'] is False  # persistent は既読化されない

    # 掃除（常駐は他テストの check 結果に混ざるため）
    server.tool('inbox_delete', {'id': p['id']})


def test_reply_to_id_roundtrip(server):
    order = _post(server, title='【発注】x')
    rep = _post(server, title='【完了報告】x', to='chat', reply_to_id=order['id'])
    got = server.tool('inbox_read', {'id': rep['id'], 'peek': True})
    assert got['reply_to_id'] == order['id']


def test_from_model_string_normalized_to_array(server):
    """from_model は文字列で送っても配列に正規化される（v3.57）"""
    p = _post(server, title='モデル名テスト', from_model='claude-fable-5')
    assert p['from_model'] == ['claude-fable-5']
    p2 = _post(server, title='モデル名配列', from_model=['claude-fable-5', '澪'])
    assert p2['from_model'] == ['claude-fable-5', '澪']


def test_check_filters(server):
    _post(server, title='フィルタ用', from_model='filter-model-xyz')
    d = server.tool('inbox_check', {'to': 'code', 'from_model': 'filter-model-xyz'})
    assert d['non_persistent_unread_count'] >= 1
    d2 = server.tool('inbox_check', {'to': 'code', 'from_model': 'no-such-model-abc'})
    assert d2['non_persistent_unread_count'] == 0
    # limit
    d3 = server.tool('inbox_check', {'to': 'code', 'limit': 1})
    assert len(d3['non_persistent_unread_ids']) <= 1


def test_update_partial(server):
    p = _post(server, title='更新前', body='更新前本文')
    u = server.tool('inbox_update', {'id': p['id'], 'title': '更新後'})
    assert u['title'] == '更新後'
    assert u['body'] == '更新前本文'  # 未指定フィールドは維持


def test_delete_is_physical(server):
    p = _post(server, title='削除テスト')
    d = server.tool('inbox_delete', {'id': p['id']})
    assert 'error' not in d
    r = server.tool('inbox_read', {'id': p['id']})
    assert 'error' in r
