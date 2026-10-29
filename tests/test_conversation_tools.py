# -*- coding: utf-8 -*-
"""会話ログ系 MCP ツール（conversation_index / search / read / share / log_annotate /
conversation_digest status_only）の境界挙動。

TS-1 リング4 グループ4（TS ネイティブ化）の回帰用。期待値は Python 版 main.py の挙動から取った。
"""
import json
import os

from conftest import make_conversation, new_uuid


def _import(server, make_conv_zip, convs, name='ct.zip'):
    zp = make_conv_zip(convs, name=name)
    with open(zp, 'rb') as f:
        r = server.post('/import', files={'file': (name, f, 'application/zip')},
                        data={'overwrite': 'false'})
    assert r.status_code == 200, r.text
    return r.json()


def _index_path(server):
    return os.path.join(server.data_root, 'conversations', '_index.json')


def _patch_index(server, uuid, **fields):
    """_index.json の該当エントリを直接書き換える（両実装とも毎回ファイルを読む）"""
    p = _index_path(server)
    with open(p, encoding='utf-8') as f:
        idx = json.load(f)
    for e in idx:
        if e.get('uuid') == uuid:
            for k, v in fields.items():
                if v is None:
                    e.pop(k, None)  # None はキー削除
                else:
                    e[k] = v
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)


def _read_text(server, uuid, **args):
    d = server.tool('conversation_read', {'uuid': uuid, **args})
    return d['text'] if 'text' in d else d


def test_index_and_search_filters_hidden_rating_individual(server, make_conv_zip):
    a = make_conversation(title='ct絞り込みA', updated_at='2026-03-01T00:00:00.000000Z')
    b = make_conversation(title='ct絞り込みB', updated_at='2026-03-05T00:00:00.000000Z')
    c = make_conversation(title='ct絞り込みC', updated_at='2026-03-09T00:00:00.000000Z')
    _import(server, make_conv_zip, [a, b, c], name='ct1.zip')
    _patch_index(server, a['uuid'], model='claude-opus-4-6', rating='adult')
    _patch_index(server, b['uuid'], participants=['claude-sonnet-4-6'], rating_source='auto')
    _patch_index(server, c['uuid'], hidden=True)

    d = server.tool('conversation_index', {'search': 'ct絞り込み'})
    titles = [i['title'] for i in d['items']]
    assert titles == ['ct絞り込みB', 'ct絞り込みA']  # hidden 除外・更新日降順
    assert d['total'] == 2
    rb = next(i for i in d['items'] if i['title'] == 'ct絞り込みB')
    assert rb['rating'] == 'safe'  # rating_source ありで rating なし = safe 判定済み
    assert 'rating_source' in rb

    d = server.tool('conversation_index', {'search': 'ct絞り込み', 'rating': 'adult'})
    assert [i['title'] for i in d['items']] == ['ct絞り込みA']
    d = server.tool('conversation_index', {'search': 'ct絞り込み', 'rating': 'safe'})
    assert [i['title'] for i in d['items']] == ['ct絞り込みB']

    # individual: 呼び名・モデル名どちらでも。participants があればそれを優先
    d = server.tool('conversation_index', {'search': 'ct絞り込み', 'individual': 'しずく'})
    assert [i['title'] for i in d['items']] == ['ct絞り込みA']
    d = server.tool('conversation_index', {'search': 'ct絞り込み', 'individual': 'そねみ'})
    assert [i['title'] for i in d['items']] == ['ct絞り込みB']

    # limit / offset
    d = server.tool('conversation_index', {'search': 'ct絞り込み', 'limit': 1, 'offset': 1})
    assert [i['title'] for i in d['items']] == ['ct絞り込みA'] and d['total'] == 2

    # 検索: 日付範囲・redact_status
    d = server.tool('conversation_search', {'q': 'ct絞り込み', 'date_from': '2026-03-04'})
    assert [i['title'] for i in d['data']] == ['ct絞り込みB']
    d = server.tool('conversation_search', {'q': 'ct絞り込み', 'date_to': '2026-03-01'})
    assert [i['title'] for i in d['data']] == ['ct絞り込みA']
    d = server.tool('conversation_search', {'q': 'ct絞り込み', 'rating': 'adult',
                                            'include_redact_status': True})
    assert d['data'][0]['redact_status'] == 'not_generated'

    # 後始末: 共有サーバー上の他テスト（adult 会話なしを前提にするもの）に影響させない
    _patch_index(server, a['uuid'], rating=None, model=None)


def test_search_body_and_semantics(server, make_conv_zip):
    conv = make_conversation(title='ct本文検索', texts=['琥珀色の鯨が泳ぐ', '蛸壺の底'])
    _import(server, make_conv_zip, [conv], name='ct2.zip')
    # タイトルのみでは見つからず、body_search=true で本文ヒット（AND）
    assert server.tool('conversation_search', {'q': '琥珀色 蛸壺'})['data'] == []
    d = server.tool('conversation_search', {'q': '琥珀色 蛸壺', 'body_search': True})
    assert [i['uuid'] for i in d['data']] == [conv['uuid']]
    assert server.tool('conversation_search', {'q': '琥珀色 存在しないXYZ',
                                               'body_search': True})['data'] == []


def test_read_slicing_and_ranges(server, make_conv_zip):
    conv = make_conversation(title='ctスライス',
                             texts=[f'メッセージ{i}' for i in range(1, 7)])
    _import(server, make_conv_zip, [conv], name='ct3.zip')
    full = _read_text(server, conv['uuid'])
    assert full.startswith('# ctスライス')
    assert all(f'メッセージ{i}' in full for i in range(1, 7))
    assert '表示:' not in full

    t = _read_text(server, conv['uuid'], turn_offset=1, turn_limit=2)
    assert '表示: 全6件中 2-3' in t
    assert 'メッセージ2' in t and 'メッセージ3' in t and 'メッセージ1' not in t

    t = _read_text(server, conv['uuid'], turn_offset=-2)  # 末尾2件
    assert '表示: 全6件中 5-6' in t and 'メッセージ5' in t and 'メッセージ4' not in t

    t = _read_text(server, conv['uuid'], message_from=3, message_to=4)  # No. 指定
    assert '表示: 全6件中 3-4' in t and 'メッセージ3' in t and 'メッセージ5' not in t

    t = _read_text(server, conv['uuid'], turn_offset=99, turn_limit=2)
    assert '表示: 全6件中 該当なし' in t

    # 役割ラベルは [sender]、assistant はモデル由来の個体名（なければ assistant）
    assert '[human]' in full and '[assistant]' in full
    _patch_conv_model(server, conv['uuid'], 'claude-opus-4-6')
    assert '[しずく]' in _read_text(server, conv['uuid'])


def _patch_conv_model(server, uuid, model):
    p = os.path.join(server.data_root, 'conversations', f'{uuid}.json')
    with open(p, encoding='utf-8') as f:
        conv = json.load(f)
    conv['model'] = model
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(conv, f, ensure_ascii=False)


def test_read_caps_thinking_and_annotations(server, make_conv_zip):
    long_text = 'あ' * 700
    conv = make_conversation(title='ct注記とthinking', texts=['一つ目', long_text, '三つ目'])
    # 2 番目のメッセージに thinking ブロックを足す
    conv['chat_messages'][1]['content'] = [
        {'type': 'thinking', 'thinking': 'い' * 50},
        {'type': 'text', 'text': long_text},
    ]
    _import(server, make_conv_zip, [conv], name='ct4.zip')

    t = _read_text(server, conv['uuid'])
    assert 'あ' * 500 in t and 'あ' * 501 not in t  # 本文は 500 字で切る
    assert 'thinking ブロックが 1 件あります' in t
    assert '💭' not in t

    t = _read_text(server, conv['uuid'], include_thinking=True, thinking_limit=10)
    assert '💭[thinking]\n' + 'い' * 10 + '\n[/thinking]' in t
    assert 'い' * 11 not in t
    assert 'あ' * 700 in t  # thinking 時は上限緩和

    # 注記: 通番付き・全体・対象外メッセージ
    r = server.tool('log_annotate', {'uuid': conv['uuid'], 'note': '二番目への注記',
                                     'author': 'ts0', 'target': 'No.2'})
    assert r['ok'] is True and r['seq'] == 1
    r = server.tool('log_annotate', {'uuid': conv['uuid'], 'note': '全体への注記', 'author': 'ts0'})
    assert r['seq'] == 2 and r['target'] is None
    server.tool('log_annotate', {'uuid': conv['uuid'], 'note': '範囲外への注記',
                                 'author': 'ts0', 'target': 9})

    t = _read_text(server, conv['uuid'], include_annotations=True)
    assert '[No.2][' in t
    assert '📝[annotation #1 by ts0 @' in t and '二番目への注記' in t
    assert '全体への注記' in t
    assert '以下は対象メッセージが表示されなかった注記' in t and '[No.9]' in t

    t = _read_text(server, conv['uuid'], include_annotations=True, include_body=False)
    assert '[No.2][' in t and '一つ目' not in t


def test_log_annotate_validation(server, make_conv_zip):
    assert 'required' in server.tool('log_annotate', {'uuid': 'x', 'note': 'n'})['error']
    assert 'required' in server.tool('log_annotate', {'note': 'n', 'author': 'a'})['error']
    assert 'conversation not found' in server.tool(
        'log_annotate', {'uuid': new_uuid(), 'note': 'n', 'author': 'a'})['error']
    assert 'conversation not found' in server.tool(
        'log_annotate', {'uuid': '../x', 'note': 'n', 'author': 'a'})['error']


def test_adult_gate_variants(server, make_conv_zip):
    conv = make_conversation(title='ctアダルトゲート', texts=['秘密のメッセージ一', '秘密のメッセージ二'])
    _import(server, make_conv_zip, [conv], name='ct5.zip')
    r = server.patch(f"/api/conversations/{conv['uuid']}/rating", json={'rating': 'adult'})
    assert r.status_code == 200

    # 既定: safe ダイジェスト未生成 → 本文を返さず notice
    d = server.tool('conversation_read', {'uuid': conv['uuid']})
    assert d['gated'] is True and '秘密' not in json.dumps(d, ensure_ascii=False)
    assert 'safe ダイジェスト未生成' in d['notice']

    # redact=true で承認済みなし → 案内
    d = server.tool('conversation_read', {'uuid': conv['uuid'], 'redact': True})
    assert d['gated'] is True and d['redacted'] is False

    # safe ダイジェストがあればそれを返す
    base = os.path.join(server.data_root, 'conversations', f"{conv['uuid']}_digest_safe.json")
    with open(base, 'w', encoding='utf-8') as f:
        json.dump({'digest': '安全な要約'}, f, ensure_ascii=False)
    d = server.tool('conversation_read', {'uuid': conv['uuid']})
    assert d['digest'] == '安全な要約'

    # 承認済み伏せ字があればスライス込みで返す
    red = os.path.join(server.data_root, 'conversations', f"{conv['uuid']}_redacted.json")
    with open(red, 'w', encoding='utf-8') as f:
        json.dump({'approved': True, 'mask_count': 3, 'redacted_messages': [
            {'role': 'human', 'text': '伏せ字一'}, {'role': 'assistant', 'text': '伏せ字二'},
            {'role': 'human', 'text': '伏せ字三'}]}, f, ensure_ascii=False)
    d = server.tool('conversation_read', {'uuid': conv['uuid']})
    assert d['redacted'] is True and d['mask_count'] == 3
    assert '[human] 伏せ字一' in d['body'] and '[assistant] 伏せ字二' in d['body']
    d = server.tool('conversation_read', {'uuid': conv['uuid'], 'turn_offset': 1, 'turn_limit': 1})
    assert d['body'] == '[assistant] 伏せ字二' and d['slice'] == '2-2' and d['total_messages'] == 3

    # include_raw=true は原文
    d = server.tool('conversation_read', {'uuid': conv['uuid'], 'include_raw': True})
    assert '秘密のメッセージ一' in (d['text'] if 'text' in d else json.dumps(d, ensure_ascii=False))

    # index の redact_status
    _patch_index(server, conv['uuid'], rating='adult')
    d = server.tool('conversation_index', {'search': 'アダルトゲート', 'include_redact_status': True})
    assert d['items'][0]['redact_status'] == 'approved'

    # 後始末: adult 会話を残さない（他テストが redact-status 空を前提にしている）
    r = server.patch(f"/api/conversations/{conv['uuid']}/rating", json={'rating': 'safe'})
    assert r.status_code == 200


def test_share_and_digest_status_only(server, make_conv_zip):
    conv = make_conversation(title='ct共有とダイジェスト状態')
    _import(server, make_conv_zip, [conv], name='ct6.zip')
    s = server.tool('conversation_share', {'uuid': conv['uuid']})
    assert s['url'].endswith(f"/share.html?token={s['token']}") and s['expires_at']
    r = server.anon().get(server.base_url + f"/api/conversations/view?token={s['token']}", timeout=10)
    assert r.status_code == 200 and r.json()['uuid'] == conv['uuid']
    assert 'conversation not found' in server.tool('conversation_share', {'uuid': new_uuid()})['error']

    d = server.tool('conversation_digest', {'uuid': conv['uuid'], 'status_only': True})
    assert d['status_only'] is True and d['has_digest'] is False and d['has_safe_digest'] is False
    assert server.tool('conversation_digest', {})['error'] == 'uuid is required'
    assert 'conversation not found' in server.tool(
        'conversation_digest', {'uuid': new_uuid(), 'status_only': True})['error']
    assert 'conversation not found' in server.tool('conversation_read', {'uuid': new_uuid()})['error']
    assert 'conversation not found' in server.tool('conversation_read', {'uuid': '../x'})['error']
