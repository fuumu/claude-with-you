# -*- coding: utf-8 -*-
"""MCP トランスポート＋ExtMemory ツールの契約"""


def test_initialize(server):
    res = server.mcp('initialize', {
        'protocolVersion': '2025-11-25',
        'capabilities': {},
        'clientInfo': {'name': 'ts0-test', 'version': '0.0.1'},
    })
    result = res['result']
    assert result['serverInfo']['name']
    assert 'instructions' in result
    assert 'CoreMem_read' in result['instructions']


def test_tools_list_34_tools(server):
    res = server.mcp('tools/list')
    tools = res['result']['tools']
    names = {t['name'] for t in tools}
    assert len(tools) == 34, f'expected 34 tools, got {len(tools)}'
    for expected in ('memory_read_index', 'memory_read', 'memory_write', 'memory_upsert',
                     'memory_search', 'memory_share',
                     'CoreMem_save', 'CoreMem_read', 'CoreMem_list', 'CoreMem_delete',
                     'conversation_index', 'conversation_search', 'conversation_read',
                     'conversation_share', 'conversation_digest', 'log_annotate',
                     'inbox_check', 'inbox_read', 'inbox_post', 'inbox_update', 'inbox_delete',
                     'batch_run_summary_layers', 'batch_run_rating',
                     'album_save', 'album_read', 'album_list', 'album_share', 'album_delete',
                     'file_upload', 'file_read', 'file_list', 'file_delete',
                     'attendance_view', 'sublimate'):
        assert expected in names, expected


def test_ping_and_unknown_method(server):
    assert server.mcp('ping')['result'] == {}
    res = server.mcp('nonexistent/method')
    assert res['error']['code'] == -32601


def test_notification_returns_202(server):
    import requests
    r = requests.post(server.base_url + '/mcp',
                      json={'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                      headers={'Authorization': f'Bearer {server.token}'}, timeout=10)
    assert r.status_code == 202


def test_server_time_and_version_on_responses(server):
    d = server.tool('inbox_check', {})
    assert 'server_time' in d
    assert 'server_version' in d


def test_memory_write_read_roundtrip(server):
    w = server.tool('memory_write', {
        'title': 'TS0テストエントリ', 'body': '特性テスト本文。キーワード：はちみつ',
        'tags': ['ts0', 'テスト'], 'importance': 'high'})
    assert 'id' in w
    eid = w['id']
    # ID形式: YYYYMMDD_HHMMSS_<先頭タグ>
    assert eid.endswith('_ts0'), eid

    r = server.tool('memory_read', {'id': eid})
    assert r['title'] == 'TS0テストエントリ'
    assert r['importance'] == 'high'
    assert r['tags'] == ['ts0', 'テスト']
    assert r['deleted'] is False
    assert r['source_thread'] == ''


def test_memory_search_hits_title_and_returns_summary_shape(server):
    server.tool('memory_write', {
        'title': '検索用ユニーク鰻タイトル', 'body': '本文うなぎ', 'tags': ['ts0']})
    d = server.tool('memory_search', {'q': '鰻'})
    assert d['total'] >= 1
    hit = d['results'][0]
    for key in ('id', 'title', 'tags', 'match_layer', 'summary', 'symbolic', 'source_thread'):
        assert key in hit, key
    assert 'body' not in hit  # full_body=false（デフォルト）では body を返さない
    assert hit['match_layer'] == 'keyword'


def test_memory_search_and_semantics(server):
    """複合キーワードはAND判定（v3.48）"""
    server.tool('memory_write', {
        'title': '林檎と蜜柑の話', 'body': '果物メモ', 'tags': ['ts0']})
    assert server.tool('memory_search', {'q': '林檎 蜜柑'})['total'] >= 1
    assert server.tool('memory_search', {'q': '林檎 存在しない語XYZQ'})['total'] == 0


def test_memory_search_include_conversations(server, make_conv_zip):
    """統合検索（v3.61）: 会話タイトルも conversations[] で返る"""
    from conftest import make_conversation
    conv = make_conversation(title='鯨についての夜話')
    zp = make_conv_zip([conv], name='unified.zip')
    with open(zp, 'rb') as f:
        r = server.post('/import', files={'file': ('unified.zip', f, 'application/zip')})
    assert r.status_code == 200

    d = server.tool('memory_search', {'q': '鯨', 'include_conversations': True})
    assert 'conversations' in d and 'conversations_total' in d
    assert d['conversations_total'] >= 1
    c = d['conversations'][0]
    for key in ('uuid', 'title', 'created_at', 'updated_at', 'message_count'):
        assert key in c, key
    # デフォルト（include_conversations なし）では会話キーが無い
    d2 = server.tool('memory_search', {'q': '鯨'})
    assert 'conversations' not in d2


def test_memory_upsert_overwrites_fixed_id(server):
    server.tool('memory_upsert', {'id': 'ts0_fixed', 'title': '初版', 'body': 'v1'})
    d = server.tool('memory_upsert', {'id': 'ts0_fixed', 'title': '二版', 'body': 'v2'})
    assert d['title'] == '二版'
    r = server.tool('memory_read', {'id': 'ts0_fixed'})
    assert r['body'] == 'v2'


def test_memory_upsert_preserves_rating_and_local_only(server):
    """v3.73: upsert で rating / local_only 未指定時は既存値を温存する"""
    w = server.tool('memory_write', {
        'title': 'rating温存テスト', 'body': 'v1', 'tags': ['ts0'],
        'rating': 'mature', 'local_only': True})
    entry_id = w['id']
    # upsert with no rating/local_only args — should preserve
    d = server.tool('memory_upsert', {'id': entry_id, 'title': 'rating温存テスト改', 'body': 'v2'})
    assert d.get('rating') == 'mature', f"rating lost: {d}"
    assert d.get('local_only') is True, f"local_only lost: {d}"
    r = server.tool('memory_read', {'id': entry_id})
    assert r['rating'] == 'mature'
    assert r['local_only'] is True
    # upsert with explicit rating change
    d2 = server.tool('memory_upsert', {'id': entry_id, 'title': 'rating温存テスト改2', 'body': 'v3', 'rating': 'adult'})
    assert d2['rating'] == 'adult'
    # upsert with local_only=false to clear it
    d3 = server.tool('memory_upsert', {'id': entry_id, 'title': 'rating温存テスト改3', 'body': 'v4', 'local_only': False})
    assert d3.get('local_only') is not True


def test_memory_read_index_and_random(server):
    """memory_read_index のリスト返却は {'data': [...], server_time, server_version} にラップされる"""
    server.tool('memory_write', {'title': 'index確認用', 'body': 'x', 'tags': ['ts0']})
    d = server.tool('memory_read_index', {})
    assert isinstance(d['data'], list) and len(d['data']) >= 1
    assert 'server_time' in d and 'server_version' in d
    for key in ('id', 'title', 'tags', 'created_at', 'importance'):
        assert key in d['data'][0], key
    d2 = server.tool('memory_read_index', {'random': 2})
    assert isinstance(d2['data'], list) and len(d2['data']) <= 2


def test_rating_protection(server):
    """v3.56: local_only / rating=adult はデフォルト除外・明示フラグで見える"""
    server.tool('memory_write', {
        'title': '秘匿ユニーク麒麟メモ', 'body': '内緒', 'tags': ['ts0'], 'local_only': True})
    assert server.tool('memory_search', {'q': '麒麟'})['total'] == 0
    assert server.tool('memory_search', {'q': '麒麟', 'include_local': True})['total'] == 1

    server.tool('memory_write', {
        'title': 'アダルト鳳凰メモ', 'body': '成人向け', 'tags': ['ts0'], 'rating': 'adult'})
    assert server.tool('memory_search', {'q': '鳳凰'})['total'] == 0
    assert server.tool('memory_search', {'q': '鳳凰', 'include_adult': True})['total'] == 1


def test_memory_share_creates_24h_url(server):
    """memory_share は admin.html?token=...&id=... 形式のURLと token / expires_at を返す。
    エントリ本体は GET /api/share/<token> で認証なしに取得できる"""
    w = server.tool('memory_write', {'title': '共有テスト', 'body': 'share', 'tags': ['ts0']})
    d = server.tool('memory_share', {'id': w['id']})
    assert 'token' in d and 'expires_at' in d
    assert '/admin.html?token=' in d['url'] and w['id'] in d['url']
    r = server.anon().get(f"{server.base_url}/api/share/{d['token']}", timeout=10)
    assert r.status_code == 200
    assert r.json()['title'] == '共有テスト'
