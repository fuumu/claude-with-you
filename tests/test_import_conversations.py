# -*- coding: utf-8 -*-
"""ZIP / claude-code インポートと LogStore（会話ログ）の契約。

v3.60 の回帰テストを含む:
- 再インポートが重複エントリを作らない（_existing_source_threads の index.json 参照バグ修正）
- source_thread 自動紐づけ（memory_id: パターン / タイムスタンプ照合）
"""
import json

from conftest import make_conversation, new_uuid


def _import_zip(server, make_conv_zip, conversations, overwrite=False, name='imp.zip'):
    zp = make_conv_zip(conversations, name=name)
    with open(zp, 'rb') as f:
        r = server.post('/import', files={'file': (name, f, 'application/zip')},
                        data={'overwrite': 'true' if overwrite else 'false'})
    assert r.status_code == 200, r.text
    return r.json()


def _count_entries_for(server, uid):
    d = server.tool('memory_read_index', {})
    return sum(1 for e in d['data'] if uid[:8] in e['id'])


def test_zip_import_creates_entry_and_conversation(server, make_conv_zip):
    conv = make_conversation(title='ZIP取込テスト会話')
    res = _import_zip(server, make_conv_zip, [conv], name='t1.zip')
    assert res['imported'] == 1
    assert res['conversations_saved'] == 1
    assert 'source_threads_linked' in res  # v3.60

    # ExtMemory 側: [会話] エントリが source_thread 付きで生成される
    d = server.tool('memory_search', {'q': 'ZIP取込テスト会話'})
    assert d['total'] == 1
    assert d['results'][0]['source_thread'] == conv['uuid']
    assert d['results'][0]['title'].startswith('[会話] ')

    # LogStore 側: conversation_read で本文が読める
    body = server.tool('conversation_read', {'uuid': conv['uuid']})
    text = json.dumps(body, ensure_ascii=False)
    assert 'こんにちは' in text


def test_zip_reimport_skips_duplicates(server, make_conv_zip):
    """同一会話の再インポートは skip され、重複エントリを作らない（v3.60 根本修正の回帰）"""
    conv = make_conversation(title='重複チェック会話')
    r1 = _import_zip(server, make_conv_zip, [conv], name='dup1.zip')
    assert r1['imported'] == 1
    before = _count_entries_for(server, conv['uuid'])

    r2 = _import_zip(server, make_conv_zip, [conv], name='dup2.zip')
    assert r2['imported'] == 0
    assert r2['skipped'] >= 1
    after = _count_entries_for(server, conv['uuid'])
    assert after == before  # 増殖しない


def test_zip_reimport_dedup_survives_missing_import_log(server, make_conv_zip):
    """imported_uuids.json が消えても source_thread ベースの重複チェックが効く（v3.60）"""
    import os
    conv = make_conversation(title='ログ欠落耐性会話')
    _import_zip(server, make_conv_zip, [conv], name='ml1.zip')

    log_path = os.path.join(server.data_root, 'imported_uuids.json')
    os.remove(log_path)  # dedup ログを消す

    r2 = _import_zip(server, make_conv_zip, [conv], name='ml2.zip')
    assert r2['imported'] == 0, 'source_thread フォールバックが効いていない'
    assert r2['skipped'] >= 1


def test_source_thread_link_by_memory_id_pattern(server, make_conv_zip):
    """会話本文の memory_id: 記載から ExtMemory の source_thread が自動紐づけされる（v3.60）"""
    w = server.tool('memory_write', {
        'title': '紐づけ対象メモ', 'body': '会話中に書いたメモ', 'tags': ['ts0link']})
    eid = w['id']
    assert server.tool('memory_read', {'id': eid})['source_thread'] == ''

    conv = make_conversation(
        title='紐づけ元会話',
        texts=['メモを保存して', f'保存したよ。memory_id: {eid} に入れておいたね'])
    _import_zip(server, make_conv_zip, [conv], name='link.zip')

    got = server.tool('memory_read', {'id': eid})
    assert got['source_thread'] == conv['uuid']


def test_source_thread_link_does_not_overwrite(server, make_conv_zip):
    """既に source_thread が入っているエントリは上書きしない（v3.60）"""
    fixed_uuid = new_uuid()
    server.tool('memory_upsert', {'id': 'ts0_keep', 'title': 'keep', 'body': 'z'})
    # REST PATCH で source_thread を設定（更新可能フィールドの契約でもある）
    r = server.patch('/api/memory/ts0_keep', json={'source_thread': fixed_uuid})
    assert r.status_code == 200
    assert server.tool('memory_read', {'id': 'ts0_keep'})['source_thread'] == fixed_uuid

    conv = make_conversation(
        title='上書き禁止会話',
        texts=['memory_id: ts0_keep を参照'])
    _import_zip(server, make_conv_zip, [conv], name='keep.zip')
    got = server.tool('memory_read', {'id': 'ts0_keep'})
    assert got['source_thread'] == fixed_uuid  # 元のUUIDのまま


def test_claude_code_jsonl_import(server, tmp_path):
    """.jsonl 単体の Claude Code セッション取り込み（v3.54）"""
    sid = new_uuid()
    lines = [
        {'type': 'user', 'uuid': new_uuid(), 'timestamp': '2026-07-02T01:00:00.000Z',
         'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'コードのテストして'}]}},
        {'type': 'assistant', 'uuid': new_uuid(), 'timestamp': '2026-07-02T01:00:10.000Z',
         'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'テスト完了です'}]}},
    ]
    p = tmp_path / f'{sid}.jsonl'
    p.write_text('\n'.join(json.dumps(l, ensure_ascii=False) for l in lines), encoding='utf-8')

    with open(p, 'rb') as f:
        r = server.post('/api/import/claude-code',
                        files={'file': (f'{sid}.jsonl', f, 'application/octet-stream')})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d['imported'] == 1
    assert d['errors'] == 0
    assert 'source_threads_linked' in d  # v3.60

    # 会話として読める＋Codeエントリはタグで識別される
    hits = server.tool('memory_search', {'q': sid[:8]})
    body = server.tool('conversation_read', {'uuid': sid})
    assert 'テスト完了です' in json.dumps(body, ensure_ascii=False)

    # 再インポートは skip
    with open(p, 'rb') as f:
        r2 = server.post('/api/import/claude-code',
                         files={'file': (f'{sid}.jsonl', f, 'application/octet-stream')})
    assert r2.json()['imported'] == 0
    assert r2.json()['skipped'] == 1


def test_conversation_search_and_index(server, make_conv_zip):
    conv = make_conversation(title='犀の角の会話',
                             created_at='2026-07-03T00:00:00.000000Z',
                             updated_at='2026-07-03T01:00:00.000000Z')
    _import_zip(server, make_conv_zip, [conv], name='cs.zip')

    d = server.tool('conversation_search', {'q': '犀の角'})
    assert any(c['uuid'] == conv['uuid'] for c in d['data'])
    for key in ('uuid', 'title', 'created_at', 'updated_at', 'message_count'):
        assert key in d['data'][0], key

    # 日付範囲フィルタ
    d2 = server.tool('conversation_search',
                     {'q': '犀の角', 'date_from': '2026-07-04'})
    assert not any(c['uuid'] == conv['uuid'] for c in d2['data'])

    # conversation_index はページング付き
    idx = server.tool('conversation_index', {'search': '犀の角', 'limit': 5})
    assert idx['total'] >= 1
    assert any(c['uuid'] == conv['uuid'] for c in idx['items'])


def test_conversation_read_turn_slicing(server, make_conv_zip):
    conv = make_conversation(title='スライス会話',
                             texts=[f'メッセージ{i}' for i in range(6)])
    _import_zip(server, make_conv_zip, [conv], name='slice.zip')
    full = server.tool('conversation_read', {'uuid': conv['uuid']})
    tail = server.tool('conversation_read',
                       {'uuid': conv['uuid'], 'turn_offset': -2, 'turn_limit': 0})
    tail_text = json.dumps(tail, ensure_ascii=False)
    assert 'メッセージ5' in tail_text
    assert 'メッセージ0' not in tail_text


def test_annotations_append_only(server, make_conv_zip):
    conv = make_conversation(title='注記対象会話')
    _import_zip(server, make_conv_zip, [conv], name='ann.zip')

    a1 = server.tool('log_annotate', {
        'uuid': conv['uuid'], 'note': '一つ目の注記', 'author': 'ts0', 'target': 'No.1'})
    assert a1.get('seq') == 1 or a1.get('annotation', {}).get('seq') == 1

    a2 = server.tool('log_annotate', {
        'uuid': conv['uuid'], 'note': '二つ目の注記', 'author': 'ts0'})
    read = server.tool('conversation_read',
                       {'uuid': conv['uuid'], 'include_annotations': True})
    text = json.dumps(read, ensure_ascii=False)
    assert '一つ目の注記' in text and '二つ目の注記' in text
    assert '[No.1]' in text  # 通番プレフィックス


def test_conversation_rating_gate(server, make_conv_zip):
    """rating=adult の会話はデフォルトで原文が返らない（v3.56）。include_raw=true で原文"""
    conv = make_conversation(title='レーティング対象会話', texts=['秘密の合言葉は柘榴'])
    _import_zip(server, make_conv_zip, [conv], name='rate.zip')

    r = server.patch(f"/api/conversations/{conv['uuid']}/rating", json={'rating': 'adult'})
    assert r.status_code == 200

    gated = server.tool('conversation_read', {'uuid': conv['uuid']})
    assert '柘榴' not in json.dumps(gated, ensure_ascii=False)

    raw = server.tool('conversation_read', {'uuid': conv['uuid'], 'include_raw': True})
    assert '柘榴' in json.dumps(raw, ensure_ascii=False)

    # 不正な rating 値は 400
    bad = server.patch(f"/api/conversations/{conv['uuid']}/rating", json={'rating': 'ultra'})
    assert bad.status_code == 400


# ── source_thread in index (v3.82) ──────────────────────────────────

def test_source_thread_in_index(server):
    """source_thread がインデックスに含まれる（Memory→会話ログ導線用・v3.82）"""
    test_uuid = new_uuid()
    d = server.tool('memory_write', {
        'title': 'source_threadインデックステスト',
        'body': 'x', 'tags': ['テスト']})
    eid = d['id']
    server.patch(f'/api/memory/{eid}', json={'source_thread': test_uuid})
    r = server.get('/api/memory/index')
    index = r.json()
    hit = [e for e in index if e['id'] == eid]
    assert hit
    assert hit[0].get('source_thread') == test_uuid


def test_source_thread_absent_not_in_index(server):
    """source_thread が空のエントリはインデックスに source_thread フィールドを持たない"""
    server.tool('memory_write', {
        'title': 'source_threadなしテスト', 'body': 'y', 'tags': ['テスト']})
    r = server.get('/api/memory/index')
    index = r.json()
    hit = [e for e in index if e['title'] == 'source_threadなしテスト']
    assert hit
    assert 'source_thread' not in hit[0]


# ── 会話更新時の再処理 (v3.84) ──────────────────────────────────────

def test_reimport_with_more_messages_updates_conversation(server, make_conv_zip):
    """追加メッセージ付き再インポートで会話データが更新される（v3.84）"""
    uid = new_uuid()
    conv1 = make_conversation(uuid=uid, title='追加メッセージ会話',
                              texts=['最初のメッセージ', '最初の返信'])
    r1 = _import_zip(server, make_conv_zip, [conv1], name='upd1.zip')
    assert r1['imported'] == 1

    conv2 = make_conversation(uuid=uid, title='追加メッセージ会話',
                              texts=['最初のメッセージ', '最初の返信',
                                     '追加のメッセージ', '追加の返信'])
    r2 = _import_zip(server, make_conv_zip, [conv2], name='upd2.zip')
    assert r2['imported'] == 0
    assert r2['conversations_updated'] == 1

    body = server.tool('conversation_read', {'uuid': uid})
    text = json.dumps(body, ensure_ascii=False)
    assert '追加のメッセージ' in text


def test_reimport_with_more_messages_remarks_entry(server, make_conv_zip):
    """追加メッセージ付き再インポートでExtMemoryエントリが再処理対象になる（v3.84）"""
    uid = new_uuid()
    conv1 = make_conversation(uuid=uid, title='再処理テスト会話',
                              texts=['挨拶', '返事'])
    r1 = _import_zip(server, make_conv_zip, [conv1], name='rmk1.zip')
    assert r1['imported'] == 1

    entry = server.tool('memory_search', {'q': '再処理テスト会話'})
    assert entry['total'] == 1
    eid = entry['results'][0]['id']
    assert 'raw' in entry['results'][0]['tags']

    server.patch(f'/api/memory/{eid}', json={
        'tags': ['会話ログ', 'summarized'],
        'body': '## 2層: 要約\n古い要約\n\n## 3層: シンボリック圧縮\n旧',
    })
    got = server.tool('memory_read', {'id': eid})
    assert 'summarized' in got['tags']
    assert 'raw' not in got['tags']

    conv2 = make_conversation(uuid=uid, title='再処理テスト会話',
                              texts=['挨拶', '返事', '追加', '追加返事'])
    r2 = _import_zip(server, make_conv_zip, [conv2], name='rmk2.zip')
    assert r2.get('entries_remarked', 0) == 1

    updated = server.tool('memory_read', {'id': eid})
    assert 'raw' in updated['tags']
    assert 'summarized' not in updated['tags']
    assert '## 2層: 要約' not in updated.get('body', '')
