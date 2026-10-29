# -*- coding: utf-8 -*-
"""レーティング可視化（v3.70・発注③）の契約。

- index rebuild / PATCH rating での rating 系メタ（reason/source/skip_reason）保全
- MCP conversation_index / conversation_search の rating 正規化
  （safe 判定済み = 明示的 "safe"・未判定 = null）
- rating バッチ status の pending / index_counts / skip_reasons / error_uuids
"""
import json
import os

from conftest import make_conversation


def _import_zip(server, make_conv_zip, conversations, name='rv.zip'):
    zp = make_conv_zip(conversations, name=name)
    with open(zp, 'rb') as f:
        r = server.post('/import', files={'file': (name, f, 'application/zip')})
    assert r.status_code == 200, r.text
    return r.json()


def _conv_path(server, uuid):
    return os.path.join(server.data_root, 'conversations', f'{uuid}.json')


def test_rebuild_preserves_rating_meta(server, make_conv_zip):
    conv = make_conversation(title='rv再構築rating保全')
    _import_zip(server, make_conv_zip, [conv], name='rv1.zip')
    r = server.patch(f"/api/conversations/{conv['uuid']}/rating",
                     json={'rating': 'mature', 'rating_reason': '検証用の理由',
                           'rating_source': 'auto'})
    assert r.status_code == 200

    os.remove(os.path.join(server.data_root, 'conversations', '_index.json'))
    assert server.post('/api/conversations/index/rebuild').status_code == 200

    d = server.get('/api/conversations/index?search=rv再構築rating保全').json()
    item = next(e for e in d['items'] if e['uuid'] == conv['uuid'])
    assert item['rating'] == 'mature'
    assert item['rating_reason'] == '検証用の理由'
    assert item['rating_source'] == 'auto'


def test_patch_rating_clears_skip_reason(server, make_conv_zip):
    conv = make_conversation(title='rvスキップ理由クリア')
    _import_zip(server, make_conv_zip, [conv], name='rv2.zip')

    # バッチが書く rating_skip_reason を直接注入（判定不能ログを再現）
    fpath = _conv_path(server, conv['uuid'])
    with open(fpath, encoding='utf-8') as f:
        data = json.load(f)
    data['rating_skip_reason'] = 'no_text'
    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    server.post('/api/conversations/index/rebuild')

    d = server.get('/api/conversations/index?search=rvスキップ理由クリア').json()
    item = next(e for e in d['items'] if e['uuid'] == conv['uuid'])
    assert item.get('rating_skip_reason') == 'no_text'  # rebuild が引き継ぐ

    # 手動上書きで解消される（会話ファイル・インデックス両方）
    r = server.patch(f"/api/conversations/{conv['uuid']}/rating", json={'rating': 'safe'})
    assert r.status_code == 200
    with open(fpath, encoding='utf-8') as f:
        assert 'rating_skip_reason' not in json.load(f)
    d = server.get('/api/conversations/index?search=rvスキップ理由クリア').json()
    item = next(e for e in d['items'] if e['uuid'] == conv['uuid'])
    assert 'rating_skip_reason' not in item


def test_mcp_conversation_index_rating_normalized(server, make_conv_zip):
    unrated = make_conversation(title='rvMCP未判定会話')
    rated = make_conversation(title='rvMCP判定済み会話')
    _import_zip(server, make_conv_zip, [unrated, rated], name='rv3.zip')

    # 未判定 → rating: null / rating_source: null が明示される
    d = server.tool('conversation_index', {'search': 'rvMCP未判定会話'})
    item = next(e for e in d['items'] if e['uuid'] == unrated['uuid'])
    assert item['rating'] is None
    assert item['rating_source'] is None

    # mature 手動 → そのまま
    server.patch(f"/api/conversations/{rated['uuid']}/rating", json={'rating': 'mature'})
    d = server.tool('conversation_index', {'search': 'rvMCP判定済み会話'})
    item = next(e for e in d['items'] if e['uuid'] == rated['uuid'])
    assert item['rating'] == 'mature'
    assert item['rating_source'] == 'manual'

    # safe 判定済み（rating フィールドなし・source あり）→ 明示的 "safe"
    server.patch(f"/api/conversations/{rated['uuid']}/rating",
                 json={'rating': 'safe', 'rating_source': 'auto'})
    d = server.tool('conversation_index', {'search': 'rvMCP判定済み会話'})
    item = next(e for e in d['items'] if e['uuid'] == rated['uuid'])
    assert item['rating'] == 'safe'
    assert item['rating_source'] == 'auto'

    # conversation_search も同じ正規化（リスト返却は {'data': [...]} に包まれる）
    hits = server.tool('conversation_search', {'q': 'rvMCP判定済み会話'})['data']
    hit = next(e for e in hits if e['uuid'] == rated['uuid'])
    assert hit['rating'] == 'safe' and hit['rating_source'] == 'auto'
    hits = server.tool('conversation_search', {'q': 'rvMCP未判定会話'})['data']
    hit = next(e for e in hits if e['uuid'] == unrated['uuid'])
    assert hit['rating'] is None


def test_rating_batch_status_counts(server, make_conv_zip):
    conv = make_conversation(title='rvバッチstatus会話')
    _import_zip(server, make_conv_zip, [conv], name='rv4.zip')

    r = server.get('/api/rating-batch/status')
    assert r.status_code == 200
    d = r.json()
    for key in ('running', 'total', 'processed', 'errors', 'skipped',
                'skip_reasons', 'error_uuids', 'pending', 'index_counts'):
        assert key in d, key
    counts = d['index_counts']
    for key in ('safe', 'mature', 'adult', 'unrated', 'unjudgeable', 'total'):
        assert key in counts, key
    # pending = 未判定件数（判定済み・判定不能を除く）と index_counts の整合
    assert d['pending'] == counts['unrated']
    assert counts['total'] == (counts['safe'] + counts['mature'] + counts['adult']
                               + counts['unrated'] + counts['unjudgeable'])

    # MCP status_only にも同じフィールド
    d = server.tool('batch_run_rating', {'status_only': True})
    assert 'index_counts' in d and 'pending' in d and 'skip_reasons' in d
