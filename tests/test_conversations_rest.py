# -*- coding: utf-8 -*-
"""会話ログ REST API（/api/conversations*）の契約。

MCP ツール側（conversation_search / read 等）は test_import_conversations.py。
ここは TS-1 リング3で移行する REST 面（検索・インデックス・再構築・取得・
注記一覧・共有・共有ビュー）を固定する。digest はリング5対象のため除外。
"""
import json
import os

from conftest import make_conversation, new_uuid


def _import_zip(server, make_conv_zip, conversations, name='r3v.zip'):
    zp = make_conv_zip(conversations, name=name)
    with open(zp, 'rb') as f:
        r = server.post('/import', files={'file': (name, f, 'application/zip')})
    assert r.status_code == 200, r.text
    return r.json()


def test_rest_conversations_search_filters(server, make_conv_zip):
    c1 = make_conversation(title='r3v検索対象アルファ',
                           created_at='2026-07-05T00:00:00.000000Z',
                           updated_at='2026-07-05T01:00:00.000000Z')
    c2 = make_conversation(title='r3v検索対象ベータ',
                           created_at='2026-07-07T00:00:00.000000Z',
                           updated_at='2026-07-07T01:00:00.000000Z')
    _import_zip(server, make_conv_zip, [c1, c2], name='r3v1.zip')

    # タイトル部分一致（小文字化）・新しい順
    r = server.get('/api/conversations/?q=r3v検索対象')
    assert r.status_code == 200
    hits = r.json()
    uuids = [e['uuid'] for e in hits]
    assert uuids.index(c2['uuid']) < uuids.index(c1['uuid'])  # updated_at 降順
    for key in ('uuid', 'title', 'created_at', 'updated_at', 'message_count'):
        assert key in hits[0], key

    # from/to は updated_at（なければ created_at）への文字列比較
    r = server.get('/api/conversations/?q=r3v検索対象&from=2026-07-06')
    assert [e['uuid'] for e in r.json()] == [c2['uuid']]
    r = server.get('/api/conversations/?q=r3v検索対象&to=2026-07-06')
    assert [e['uuid'] for e in r.json()] == [c1['uuid']]

    # limit
    r = server.get('/api/conversations/?q=r3v検索対象&limit=1')
    assert len(r.json()) == 1


def test_rest_conversations_body_search(server, make_conv_zip):
    conv = make_conversation(title='r3v本文検索会話',
                             texts=['合言葉は瑠璃色の朝焼け', 'なるほど'])
    _import_zip(server, make_conv_zip, [conv], name='r3v2.zip')

    # body_search なし: タイトル・uuid のみ照合 → ヒットしない
    r = server.get('/api/conversations/?q=瑠璃色の朝焼け')
    assert conv['uuid'] not in [e['uuid'] for e in r.json()]
    # body_search=true: 本文まで見る
    r = server.get('/api/conversations/?q=瑠璃色の朝焼け&body_search=true')
    assert conv['uuid'] in [e['uuid'] for e in r.json()]


def test_rest_conversations_index_paging(server, make_conv_zip):
    r = server.get('/api/conversations/index?search=r3v検索対象&limit=1&offset=0')
    assert r.status_code == 200
    d = r.json()
    assert d['total'] >= 2
    assert d['limit'] == 1 and d['offset'] == 0
    assert len(d['items']) == 1
    first = d['items'][0]['uuid']
    d2 = server.get('/api/conversations/index?search=r3v検索対象&limit=1&offset=1').json()
    assert d2['items'][0]['uuid'] != first


def test_rest_conversations_index_rebuild(server, make_conv_zip):
    conv = make_conversation(title='r3v再構築会話')
    _import_zip(server, make_conv_zip, [conv], name='r3v3.zip')
    # _index.json を消してから rebuild で復元される
    idx_path = os.path.join(server.data_root, 'conversations', '_index.json')
    os.remove(idx_path)
    r = server.post('/api/conversations/index/rebuild')
    assert r.status_code == 200
    assert r.json()['rebuilt'] >= 1
    d = server.get('/api/conversations/index?search=r3v再構築会話').json()
    assert any(e['uuid'] == conv['uuid'] for e in d['items'])
    for key in ('uuid', 'title', 'created_at', 'updated_at', 'message_count'):
        assert key in d['items'][0], key


def test_rest_conversation_get_full_json(server, make_conv_zip):
    conv = make_conversation(title='r3v取得会話', texts=['ひとつ', 'ふたつ'])
    _import_zip(server, make_conv_zip, [conv], name='r3v4.zip')
    r = server.get(f"/api/conversations/{conv['uuid']}")
    assert r.status_code == 200
    d = r.json()
    assert d['uuid'] == conv['uuid']
    assert 'ひとつ' in json.dumps(d, ensure_ascii=False)
    # 存在しない uuid は 404
    assert server.get(f'/api/conversations/{new_uuid()}').status_code == 404


def test_rest_conversation_annotations(server, make_conv_zip):
    conv = make_conversation(title='r3v注記会話')
    _import_zip(server, make_conv_zip, [conv], name='r3v5.zip')
    # 注記なし → 空配列
    r = server.get(f"/api/conversations/{conv['uuid']}/annotations")
    assert r.status_code == 200 and r.json() == []
    server.tool('log_annotate', {'uuid': conv['uuid'], 'note': 'REST注記テスト',
                                 'author': 'r3v', 'target': 'No.1'})
    anns = server.get(f"/api/conversations/{conv['uuid']}/annotations").json()
    assert len(anns) == 1
    a = anns[0]
    assert a['seq'] == 1 and a['note'] == 'REST注記テスト' and a['author'] == 'r3v'
    assert 'created_at' in a and 'target' in a


def test_rest_conversation_share_and_view(server, make_conv_zip):
    conv = make_conversation(title='r3v共有会話', texts=['共有される本文'])
    _import_zip(server, make_conv_zip, [conv], name='r3v6.zip')

    r = server.post(f"/api/conversations/share/{conv['uuid']}")
    assert r.status_code == 200
    d = r.json()
    assert set(d) >= {'token', 'url', 'expires_at'}
    assert 'share.html?token=' in d['url']

    # view は認証不要
    anon = server.anon()
    v = anon.get(server.base_url + f"/api/conversations/view?token={d['token']}")
    assert v.status_code == 200
    assert '共有される本文' in json.dumps(v.json(), ensure_ascii=False)

    # 不正トークンは 404
    assert anon.get(server.base_url + '/api/conversations/view?token=zzz').status_code == 404

    # 期限切れは 410（expires_in に負値を渡して即失効させる）
    r2 = server.post(f"/api/conversations/share/{conv['uuid']}",
                     json={'expires_in': -1})
    v2 = anon.get(server.base_url + f"/api/conversations/view?token={r2.json()['token']}")
    assert v2.status_code == 410

    # 存在しない会話の share は 404
    assert server.post(f'/api/conversations/share/{new_uuid()}').status_code == 404


def test_rest_conversations_require_auth(server, make_conv_zip):
    anon = server.anon()
    assert anon.get(server.base_url + '/api/conversations/').status_code == 401
    assert anon.get(server.base_url + '/api/conversations/index').status_code == 401
    assert anon.post(server.base_url + '/api/conversations/index/rebuild').status_code == 401
