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


# ── MCP ツールの境界挙動（TS ネイティブ化の回帰用）──────────────────────────

def test_post_validation_errors(server):
    assert server.tool('inbox_post', {'title': 't'})['error'] == 'to and title are required'
    assert server.tool('inbox_post', {'to': 'chat'})['error'] == 'to and title are required'
    d = server.tool('inbox_post', {'to': 'chat', 'title': 't', 'persistent': True, 'ttl_days': 1})
    assert 'exclusive' in d['error']
    d = server.tool('inbox_post', {'to': 'chat', 'title': 't', 'expires_at': 'not-a-date'})
    assert d['error'] == 'expires_at must be ISO 8601'
    d = server.tool('inbox_post', {'to': 'chat', 'title': 't', 'ttl_days': 'abc'})
    assert d['error'] == 'ttl_days must be a number'


def test_timed_standing_message_and_expired_demotion(server):
    """期間常駐は期限内なら常駐扱い、期限切れは check 時に既読へ自動降格（v3.70）"""
    live = server.tool('inbox_post', {'to': 'code', 'title': 'ts0期間常駐', 'body': 'b',
                                      'ttl_days': 1})
    assert live['expires_at']
    chk = server.tool('inbox_check', {})
    assert live['id'] in {m['id'] for m in chk['persistent']}
    assert live['id'] not in chk['non_persistent_unread_ids']

    dead = server.tool('inbox_post', {'to': 'code', 'title': 'ts0期限切れ', 'body': 'b',
                                      'expires_at': '2020-01-01T00:00:00+09:00'})
    chk = server.tool('inbox_check', {})
    assert dead['id'] not in {m['id'] for m in chk['persistent']}
    assert dead['id'] not in chk['ids']  # 降格＝既読アーカイブ（unread のみ表示では出ない）
    chk_all = server.tool('inbox_check', {'include_read': True})
    row = next(m for m in chk_all['messages'] if m['id'] == dead['id'])
    assert row['read'] is True


def test_check_limit_applies_to_non_standing_only(server):
    server.tool('inbox_post', {'to': 'ts0lim', 'title': 'lim常駐', 'persistent': True})
    for i in range(3):
        server.tool('inbox_post', {'to': 'ts0lim', 'title': f'lim通常{i}'})
    d = server.tool('inbox_check', {'to': 'ts0lim', 'limit': 2})
    assert d['count'] == 3  # 常駐1 + 通常2
    assert len(d['persistent']) == 1
    assert d['non_persistent_unread_count'] == 2


def test_check_days_filter_keeps_standing(server):
    server.tool('inbox_post', {'to': 'ts0days', 'title': 'days常駐', 'persistent': True})
    server.tool('inbox_post', {'to': 'ts0days', 'title': 'days通常'})
    d = server.tool('inbox_check', {'to': 'ts0days', 'days': 0})
    # days=0 は「今」より前を除外: 通常は落ち、常駐は残る
    assert len(d['persistent']) == 1
    assert d['non_persistent_unread_count'] == 0


def test_mymodel_checkin_upgrade(server):
    """inbox_check(mymodel=...) は出席簿に本登録を残す（v3.85）"""
    import json
    import os
    path = os.path.join(server.data_root, 'session_checkins.json')
    server.tool('inbox_check', {'mymodel': 'claude-sonnet-4-6'})
    with open(path, encoding='utf-8') as f:
        entries = json.load(f)
    # 直近の仮登録があればそれが昇格し（末尾とは限らない）、無ければ新規本登録される
    mine = [e for e in entries if e['model'] == 'claude-sonnet-4-6']
    assert mine, entries
    assert mine[-1]['individual'] == 'そねみ'
    assert mine[-1]['ttl_minutes'] is None


def test_update_expires_and_exclusivity(server):
    p = server.tool('inbox_post', {'to': 'code', 'title': 'ts0upd', 'persistent': True})
    # persistent 指定が優先: 期限を付けても persistent なら expires_at は消える
    u = server.tool('inbox_update', {'id': p['id'], 'persistent': True, 'ttl_days': 1})
    assert u['persistent'] is True and u['expires_at'] is None
    # 期限付きに切り替えると persistent は外れる
    u = server.tool('inbox_update', {'id': p['id'], 'persistent': False, 'ttl_days': 1})
    assert u['persistent'] is False and u['expires_at']
    assert server.tool('inbox_update', {})['error'] == 'id is required'
    assert 'message not found' in server.tool('inbox_update', {'id': 'nope'})['error']
    assert server.tool('inbox_delete', {})['error'] == 'id is required'


def test_id_with_path_traversal_is_not_found(server):
    for bad in ('../x', '..\\x', 'a/b'):
        assert 'message not found' in server.tool('inbox_read', {'id': bad})['error']
        assert 'message not found' in server.tool('inbox_delete', {'id': bad})['error']


def test_raw_title_pipeline_replaces_body_via_mcp_and_rest(server):
    """【生】を含む chat 宛は原文退避＋プレースホルダ化（v3.75）。LLM は到達不能でも
    同期部分（退避・置換）は必ず走る。MCP・REST どちらの入口でも同じ"""
    d = server.tool('inbox_post', {'to': 'chat', 'title': '【生】ts0昇華MCP', 'body': 'SECRET-MCP'})
    msg = server.tool('inbox_read', {'id': d['id'], 'peek': True})
    assert 'SECRET-MCP' not in msg['body']
    assert msg['body'].startswith('【処理中】')
    assert '【生】' not in msg['title']

    r = server.post('/api/inbox', json={'to': 'chat', 'title': '【生】ts0昇華REST',
                                        'body': 'SECRET-REST'})
    assert r.status_code == 201, r.text
    posted = r.json()
    msg = server.tool('inbox_read', {'id': posted['id'], 'peek': True})
    assert 'SECRET-REST' not in msg['body']
    assert msg['body'].startswith('【処理中】')
