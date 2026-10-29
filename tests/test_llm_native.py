# -*- coding: utf-8 -*-
"""TS-1 リング5: LLM 依存ツール・album_save・file_upload(file_path)・友達セッションの契約。

LLM は conftest の MockLLM（Anthropic Messages 互換）に向けてある。期待値は Python 版 main.py の
挙動から取った（TS ネイティブ実装が同一契約であることの確認）。

バッチ系はグローバルな状態（全会話・全記憶エントリ）を走査・更新するため、データを一時的に
空にして実行し、終了後に元へ戻す（isolated_data）。他テストの前提を壊さないための措置。
"""
import contextlib
import io
import json
import os
import shutil
import tempfile
import time
import uuid as uuid_mod

import pytest
import requests

from conftest import make_conversation, new_uuid

_DIRS = ['conversations', 'memory', 'inbox', 'album', 'uploads', 'friends']
_FILES = ['index.json', 'oplog.json', 'share_tokens.json']


@contextlib.contextmanager
def isolated_data(server):
    """データ領域を一時的に空にして、終了時に元へ戻す（サーバーはリクエストごとにファイルを読む）"""
    root = server.data_root
    snap = tempfile.mkdtemp(prefix='mio-iso-')
    try:
        for n in _DIRS:
            p = os.path.join(root, n)
            if os.path.isdir(p):
                shutil.copytree(p, os.path.join(snap, n))
                shutil.rmtree(p)
            os.makedirs(p)  # 空で作り直す（サーバーは memory/ 等の存在を前提にする）
        for f in _FILES:
            p = os.path.join(root, f)
            if os.path.exists(p):
                shutil.copy2(p, os.path.join(snap, f))
                os.remove(p)
        yield
    finally:
        for n in _DIRS:
            p = os.path.join(root, n)
            if os.path.isdir(p):
                shutil.rmtree(p)
            s = os.path.join(snap, n)
            if os.path.isdir(s):
                shutil.copytree(s, p)
        for f in _FILES:
            p = os.path.join(root, f)
            if os.path.exists(p):
                os.remove(p)
            s = os.path.join(snap, f)
            if os.path.exists(s):
                shutil.copy2(s, p)
        shutil.rmtree(snap, ignore_errors=True)


def _import(server, make_conv_zip, convs, name='ln.zip'):
    zp = make_conv_zip(convs, name=name)
    with open(zp, 'rb') as f:
        r = server.post('/import', files={'file': (name, f, 'application/zip')},
                        data={'overwrite': 'false'})
    assert r.status_code == 200, r.text


def _wait_batch(server, tool, t0, timeout=60):
    """バッチ開始前の server_time（t0）より後に終了するまで待つ"""
    deadline = time.time() + timeout
    st = {}
    while time.time() < deadline:
        st = server.tool(tool, {'status_only': True})
        if not st.get('running') and st.get('finished_at') and st['finished_at'] > t0:
            return st
        time.sleep(0.3)
    raise AssertionError(f'batch did not finish: {st}')


def _server_time(server):
    return server.tool('batch_run_rating', {'status_only': True})['server_time']


def _index(server):
    p = os.path.join(server.data_root, 'conversations', '_index.json')
    with open(p, encoding='utf-8') as f:
        return {e['uuid']: e for e in json.load(f)}


def _entry(server, entry_id):
    with open(os.path.join(server.data_root, 'memory', f'{entry_id}.json'), encoding='utf-8') as f:
        return json.load(f)


# ── llm_status ───────────────────────────────────────────────────────

def test_llm_status_reports_mock_endpoint(server):
    d = server.tool('llm_status')
    assert d['ok_models'] == ['mock-model']
    ep = d['endpoints'][server.llm.base]
    assert ep['active_models'] == ['mock-model']
    assert ep['management_api'] is False
    assert ep['ok_active'] == [{'model': 'mock-model', 'ok_name': 'mock-model', 'priority': 0}]
    assert d['selection'] == {'endpoint': server.llm.base, 'model': 'mock-model', 'priority': 0}
    assert isinstance(d['recent_logs'], list) and d['server_time']
    r = server.get('/api/llm-status')
    assert r.status_code == 200
    assert r.json()['selection'] == d['selection']
    assert server.anon().get(server.base_url + '/api/llm-status', timeout=10).status_code == 401


# ── conversation_digest ──────────────────────────────────────────────

def test_digest_generation_cache_and_safe_mode(server, make_conv_zip):
    server.llm.reset()
    conv = make_conversation(title='lnダイジェスト', texts=['はじめまして', 'こんにちは', 'さようなら'])
    _import(server, make_conv_zip, [conv], name='ln-dg1.zip')

    d = server.tool('conversation_digest', {'uuid': conv['uuid']})
    assert d['digest'] == 'モックチャンクダイジェスト'
    assert d['cached'] is False and d['chunks'] == 1 and d['safe_mode'] is False
    assert d['model'] == 'mock-model' and d['uuid'] == conv['uuid']
    assert os.path.exists(os.path.join(server.data_root, 'conversations', f"{conv['uuid']}_digest.json"))

    again = server.tool('conversation_digest', {'uuid': conv['uuid']})
    assert again['cached'] is True and again['digest'] == d['digest']

    n_before = len(server.llm.calls)
    forced = server.tool('conversation_digest', {'uuid': conv['uuid'], 'force': True})
    assert forced['cached'] is False and len(server.llm.calls) == n_before + 1

    safe = server.tool('conversation_digest', {'uuid': conv['uuid'], 'safe_mode': True})
    assert safe['safe_mode'] is True and safe['cached'] is False
    assert '昇華文体で書くこと' in server.llm.calls[-1]['prompt']
    st = server.tool('conversation_digest', {'uuid': conv['uuid'], 'status_only': True})
    assert st['has_digest'] is True and st['has_safe_digest'] is True


def test_digest_multi_chunk_integrates(server, make_conv_zip):
    server.llm.reset()
    texts = [f'発言{i}' for i in range(25)]  # 20 ターン区切り → 2 チャンク
    conv = make_conversation(title='lnダイジェスト長編', texts=texts)
    _import(server, make_conv_zip, [conv], name='ln-dg2.zip')
    d = server.tool('conversation_digest', {'uuid': conv['uuid']})
    assert d['chunks'] == 2
    assert d['digest'] == 'モック統合ダイジェスト'
    assert 'パート1:\nモックチャンクダイジェスト' in server.llm.calls[-1]['prompt']


def test_digest_chunk_failure_is_embedded(server, make_conv_zip):
    server.llm.reset()
    conv = make_conversation(title='lnダイジェスト失敗', texts=['a', 'b'])
    _import(server, make_conv_zip, [conv], name='ln-dg3.zip')
    server.llm.set(mode='fail')
    try:
        d = server.tool('conversation_digest', {'uuid': conv['uuid'], 'force': True})
    finally:
        server.llm.reset()
    assert d['digest'].startswith('[チャンク1のダイジェスト生成失敗:')
    assert d['chunks'] == 1


def test_digest_rest_and_errors(server, make_conv_zip):
    server.llm.reset()
    conv = make_conversation(title='lnダイジェストREST', texts=['x', 'y'])
    _import(server, make_conv_zip, [conv], name='ln-dg4.zip')
    r = server.post(f"/api/conversations/{conv['uuid']}/digest?force=true")
    assert r.status_code == 200
    assert r.json()['digest'] == 'モックチャンクダイジェスト' and r.json()['cached'] is False
    r = server.post(f"/api/conversations/{conv['uuid']}/digest?status_only=true")
    assert r.status_code == 200 and r.json()['has_digest'] is True
    r = server.post(f'/api/conversations/{new_uuid()}/digest')
    assert r.status_code == 404
    assert 'conversation not found' in server.tool('conversation_digest', {'uuid': new_uuid()})['error']


# ── sublimate ────────────────────────────────────────────────────────

def test_sublimate_text_ok_and_needs_human(server):
    server.llm.reset()
    d = server.tool('sublimate', {'text': '昇華テスト用の短い日記テキスト。'})
    assert d['sublimated'] == '昇華済みのモックテキスト。波のように静かに満ちていく。'
    assert d['rating'] == 'safe' and d['rating_reason'] == ''  # 最悪値の理由。safe のままなら空
    assert d['chunks'] == 1 and d['attempts'] == 1 and d['needs_human'] is False
    assert d['model'] == 'mock-model'
    # 昇華結果の検証判定は temperature=0（strict）で行う
    assert server.llm.calls[-1]['temperature'] == 0.0

    server.llm.set(rating='adult')
    try:
        d = server.tool('sublimate', {'text': '昇華テスト用の短い日記テキスト。'})
    finally:
        server.llm.reset()
    assert d['needs_human'] is True and d['attempts'] == 3 and d['rating'] == 'adult'
    assert d['rating_reason'] == 'モック判定'


def test_sublimate_input_too_large(server):
    d = server.tool('sublimate', {'text': 'あ' * 60001})
    assert 'error' in d and d['input_chars'] == 60001 and d['max_chars'] == 60000


def test_sublimate_from_conversation_range(server, make_conv_zip):
    server.llm.reset()
    conv = make_conversation(title='ln昇華範囲', texts=['一つ目', '二つ目', '三つ目'])
    _import(server, make_conv_zip, [conv], name='ln-sb1.zip')
    d = server.tool('sublimate', {'uuid': conv['uuid'], 'msg_from': 2, 'msg_to': 3})
    assert d['uuid'] == conv['uuid'] and d['chunks'] == 1
    sent = server.llm.calls[-2]['prompt']  # 最後は strict 判定、その前が昇華本体
    assert '二つ目' in sent and '三つ目' in sent and '一つ目' not in sent
    assert 'no messages in range' in server.tool(
        'sublimate', {'uuid': conv['uuid'], 'msg_from': 9, 'msg_to': 12})['error']


# ── レーティング判定バッチ ────────────────────────────────────────────

def test_rating_batch_via_mcp(server, make_conv_zip):
    server.llm.reset()
    with isolated_data(server):
        a = make_conversation(title='lnレーティングA', texts=['やあ', 'どうも'])
        _import(server, make_conv_zip, [a], name='ln-rb1.zip')
        t0 = _server_time(server)
        started = server.tool('batch_run_rating', {})
        assert started['started'] is True and started['backend'] == 'lmstudio'
        assert started['pending'] == 1
        st = _wait_batch(server, 'batch_run_rating', t0)
        assert st['processed'] == 1 and st['errors'] == 0 and st['total'] == 1
        assert st['backend'] == 'lmstudio'

        e = _index(server)[a['uuid']]
        assert e.get('rating') is None and e['rating_source'] == 'auto'
        with open(os.path.join(server.data_root, 'conversations', f"{a['uuid']}.json"), encoding='utf-8') as f:
            conv = json.load(f)
        assert conv['rating_source'] == 'auto' and conv['rating_model'] == 'mock-model'
        assert 'rating' not in conv  # safe は rating を持たない

        # 判定済みは対象外 → 再実行しても何も処理しない
        t1 = _server_time(server)
        server.tool('batch_run_rating', {})
        st = _wait_batch(server, 'batch_run_rating', t1)
        assert st['total'] == 0 and st['processed'] == 0

        b = make_conversation(title='lnレーティングB', texts=['ほげ', 'ふが'])
        _import(server, make_conv_zip, [b], name='ln-rb2.zip')
        server.llm.set(rating='adult')
        t2 = _server_time(server)
        try:
            server.tool('batch_run_rating', {})
            st = _wait_batch(server, 'batch_run_rating', t2)
        finally:
            server.llm.reset()
        assert st['processed'] == 1
        e = _index(server)[b['uuid']]
        assert e['rating'] == 'adult' and e['rating_reason'] == 'モック判定' and e['rating_source'] == 'auto'

        ops = server.get('/api/oplog').json()
        ops = ops if isinstance(ops, list) else ops.get('items', ops.get('data', []))
        assert any(o.get('operation') == 'conv_rating_auto' and o.get('entry_id') == b['uuid'] for o in ops)

        # 状態 REST
        r = server.get('/api/rating-batch/status').json()
        assert r['index_counts']['adult'] == 1 and r['index_counts']['safe'] == 1


def test_rating_batch_rest_start_and_conflict(server, make_conv_zip):
    server.llm.reset()
    with isolated_data(server):
        c = make_conversation(title='lnレーティングREST', texts=['a', 'b'])
        _import(server, make_conv_zip, [c], name='ln-rb3.zip')
        t0 = _server_time(server)
        r = server.post('/api/rating-batch/start', json={})
        assert r.status_code == 200 and r.json()['started'] is True
        _wait_batch(server, 'batch_run_rating', t0)
        assert _index(server)[c['uuid']]['rating_source'] == 'auto'
    r = server.post('/api/rating-batch/start', json={'backend': 'anthropic'})
    assert r.status_code == 400 and r.json()['error'] == 'ANTHROPIC_API_KEY required'


# ── 要約レイヤー生成バッチ ────────────────────────────────────────────

def test_summary_batch_layers_keywords_and_empty_raw(server):
    server.llm.reset()
    with isolated_data(server):
        long_body = 'これは要約対象の十分に長い本文です。' * 6
        # memory_write の ID は秒単位（{ts}_{tag}）で同タグが衝突するため、ID 指定の upsert で作る
        raw = server.tool('memory_upsert', {'id': 'ln_raw_long', 'title': 'lnRAW本文',
                                            'body': long_body, 'tags': ['raw']})
        empty = server.tool('memory_upsert', {'id': 'ln_raw_empty', 'title': 'ln空RAW',
                                              'body': '短い', 'tags': ['raw']})
        plain = server.tool('memory_upsert', {'id': 'ln_plain', 'title': 'ln通常メモ',
                                              'body': '検索キーワードだけ欲しい本文', 'tags': ['メモ']})

        t0 = _server_time(server)
        started = server.tool('batch_run_summary_layers', {})
        assert started['started'] is True and started['backend'] == 'lmstudio'
        assert started['raw_pending'] == 2 and started['keywords_pending'] == 1
        st = _wait_batch(server, 'batch_run_summary_layers', t0)
        assert st['processed'] == 2 and st['skipped'] == 1 and st['errors'] == 0 and st['total'] == 3

        e = _entry(server, raw['id'])
        assert '## 2層: 要約' in e['body'] and '## 3層: シンボリック圧縮' in e['body']
        assert '## 4層' not in e['body']
        assert e['keywords'] == ['モック要約', 'テスト', '層']
        assert 'summarized' in e['tags'] and 'raw' not in e['tags']
        assert e['body'].startswith(long_body.strip())

        e = _entry(server, empty['id'])
        assert e['deleted'] is True

        e = _entry(server, plain['id'])
        assert e['keywords'] == ['モックA', 'モックB', 'モックC']
        assert e['body'] == '検索キーワードだけ欲しい本文'  # 本文・タグは変更しない

        ops = server.get('/api/oplog').json()
        ops = ops if isinstance(ops, list) else ops.get('items', ops.get('data', []))
        assert any(o.get('operation') == 'batch_empty_delete' and o.get('entry_id') == empty['id'] for o in ops)

        # 状態 REST と二重起動なし
        r = server.get('/api/batch/status').json()
        assert r['running'] is False and r['processed'] == 2


def test_summary_batch_llm_failure_counts_errors(server):
    server.llm.reset()
    with isolated_data(server):
        server.tool('memory_write', {'title': 'ln失敗RAW', 'body': '失敗確認用の十分に長い本文です。' * 5,
                                     'tags': ['raw']})
        server.llm.set(mode='fail')
        t0 = _server_time(server)
        try:
            server.tool('batch_run_summary_layers', {})
            st = _wait_batch(server, 'batch_run_summary_layers', t0)
        finally:
            server.llm.reset()
        assert st['errors'] == 1 and st['processed'] == 0


# ── inbox 自動昇華パイプライン（【生】）──────────────────────────────────

def _wait_inbox_title(server, msg_id, prefix, timeout=30):
    deadline = time.time() + timeout
    m = {}
    while time.time() < deadline:
        m = server.tool('inbox_read', {'id': msg_id, 'peek': True})
        if m.get('title', '').startswith(prefix):
            return m
        time.sleep(0.2)
    raise AssertionError(f'inbox title did not reach {prefix}: {m}')


def test_inbox_raw_trigger_sublimates_and_backs_up(server):
    server.llm.reset()
    with isolated_data(server):
        secret = 'ひみつの原文テキストです'
        p = server.tool('inbox_post', {'to': 'chat', 'title': '【生】テスト日記', 'body': secret,
                                       'from': 'code'})
        m = _wait_inbox_title(server, p['id'], '【未承認】')
        assert m['title'] == '【未承認】テスト日記'
        assert '昇華済みのモックテキスト' in m['body'] and secret not in m['body']
        assert 'レーティング: safe' in m['body']

        # 原文は ExtMemory に rating=adult / local_only で退避されている
        idx = server.tool('memory_read_index', {'include_adult': True, 'include_local': True})
        idx = idx if isinstance(idx, list) else idx.get('data', idx)
        hit = [e for e in idx if 'バカンス日記' in (e.get('tags') or [])]
        assert len(hit) == 1
        e = _entry(server, hit[0]['id'])
        assert e['rating'] == 'adult' and e['local_only'] is True and secret in e['body']
        assert hit[0]['id'] in m['body']

        # adult しか出せない場合は【要人手】
        server.llm.set(rating='adult')
        try:
            p2 = server.tool('inbox_post', {'to': 'chat', 'title': '【生】要人手', 'body': '本文2', 'from': 'code'})
            m2 = _wait_inbox_title(server, p2['id'], '【要人手】')
        finally:
            server.llm.reset()
        assert '人手での昇華をお願いします' in m2['body']


def test_inbox_raw_trigger_rest_post(server):
    server.llm.reset()
    with isolated_data(server):
        r = server.post('/api/inbox', json={'to': 'chat', 'title': '【生】REST', 'body': 'rest本文', 'from': 'code'})
        assert r.status_code == 201
        msg = r.json()
        assert msg['title'] == '【処理中】REST' and '【処理中】' in msg['body']
        m = _wait_inbox_title(server, msg['id'], '【未承認】')
        assert 'rest本文' not in m['body']


# ── album_save ───────────────────────────────────────────────────────

def _png(path, size=(2000, 1000), mode='RGB', fmt='PNG'):
    from PIL import Image
    img = Image.new(mode, size, color=(200, 100, 50) if mode == 'RGB' else (200, 100, 50, 128))
    img.save(path, format=fmt)
    return str(path)


def test_album_save_file_path_resizes_png(server, tmp_path):
    p = _png(tmp_path / 'big.png')
    d = server.tool('album_save', {'file_path': p, 'comment': 'ln大きい画像',
                                   'tags': ['ln テスト', '犬'], 'rating': 'mature', 'guard_message': '注意'})
    assert 'error' not in d, d
    assert d['ext'] == 'png' and d['width'] == 1024 and d['height'] == 512
    assert d['id'].endswith('_ln_テスト') and d['tags'] == ['ln テスト', '犬']
    assert d['original_filename'] == 'big.png' and d['source_url'] == ''
    assert d['rating'] == 'mature' and d['guard_message'] == '注意'
    img = os.path.join(server.data_root, 'album', f"{d['id']}.png")
    assert os.path.getsize(img) == d['size_bytes']
    from PIL import Image
    assert Image.open(img).size == (1024, 512)
    got = server.tool('album_read', {'id': d['id'], 'include_adult': True})
    assert got['id'] == d['id']
    server.tool('album_delete', {'id': d['id']})


def test_album_save_small_not_enlarged_and_invalid_rating_ignored(server, tmp_path):
    p = _png(tmp_path / 'small.png', size=(100, 50))
    d = server.tool('album_save', {'file_path': p, 'rating': 'bogus'})
    assert d['width'] == 100 and d['height'] == 50 and 'rating' not in d
    assert d['tags'] == [] and d['id'].endswith('_photo') and d['comment'] == ''
    server.tool('album_delete', {'id': d['id']})


def test_album_save_converts_other_formats_to_jpeg(server, tmp_path):
    p = _png(tmp_path / 'scan.tif', size=(300, 200), fmt='TIFF')
    d = server.tool('album_save', {'file_path': p, 'tags': ['tiff']})
    assert 'error' not in d, d
    assert d['ext'] == 'jpg' and d['width'] == 300 and d['height'] == 200
    with open(os.path.join(server.data_root, 'album', f"{d['id']}.jpg"), 'rb') as f:
        assert f.read(3) == b'\xff\xd8\xff'  # JPEG マジック
    server.tool('album_delete', {'id': d['id']})


def test_album_save_errors(server, tmp_path):
    assert server.tool('album_save', {})['error'] == 'url or file_path is required'
    missing = str(tmp_path / 'nope.png')
    assert server.tool('album_save', {'file_path': missing})['error'] == f'file not found: {missing}'
    txt = tmp_path / 'not_image.txt'
    txt.write_text('画像ではありません', encoding='utf-8')
    assert server.tool('album_save', {'file_path': str(txt)})['error'].startswith('not a valid image')


def test_album_save_url_and_html_extraction(server, tmp_path):
    p = _png(tmp_path / 'web.png', size=(640, 480))
    with open(p, 'rb') as f:
        data = f.read()
    img_url = server.llm.serve('/ln/pic.png', data, 'image/png')
    d = server.tool('album_save', {'url': img_url, 'tags': ['url']})
    assert d['source_url'] == img_url and d['original_filename'] == 'pic.png'
    assert d['width'] == 640 and d['ext'] == 'png'
    server.tool('album_delete', {'id': d['id']})

    html = ('<html><head><meta property="og:image" content="/ln/pic.png">'
            '<meta charset="utf-8"></head><body><img src="/ln/other.png"></body></html>')
    page = server.llm.serve('/ln/page.html', html.encode('utf-8'), 'text/html; charset=utf-8')
    d = server.tool('album_save', {'url': page, 'tags': ['html']})
    assert 'error' not in d, d
    assert d['source_url'] == img_url  # og:image が <img> より優先される
    server.tool('album_delete', {'id': d['id']})

    empty = server.llm.serve('/ln/empty.html', '<html><body>画像なし</body></html>'.encode('utf-8'), 'text/html')
    assert server.tool('album_save', {'url': empty})['error'] == 'HTML page contained no extractable images'


# ── file_upload(file_path) ───────────────────────────────────────────

def test_file_upload_file_path_mime_and_errors(server, tmp_path):
    md = tmp_path / 'ln_note.md'
    md.write_text('# ノート\n本文', encoding='utf-8')
    d = server.tool('file_upload', {'file_path': str(md), 'comment': 'c', 'tags': ['ln']})
    assert d['filename'] == 'ln_note.md' and d['mimetype'] == 'text/markdown' and d['size'] == len(md.read_bytes())
    read = server.tool('file_read', {'id': d['id']})
    assert '本文' in read['content'] and read['ext'] == 'md'
    server.tool('file_delete', {'id': d['id']})

    unk = tmp_path / 'ln_blob.zzz'
    unk.write_bytes(b'\x00\x01\x02')
    d = server.tool('file_upload', {'file_path': str(unk), 'filename': 'renamed.zzz'})
    assert d['filename'] == 'renamed.zzz' and d['mimetype'] == 'application/octet-stream'
    server.tool('file_delete', {'id': d['id']})

    assert 'File not found' in server.tool('file_upload', {'file_path': str(tmp_path / 'none.bin')})['error']
    assert server.tool('file_upload', {})['error'] == 'url or file_path is required'


def test_file_upload_url_json_roundtrip(server):
    payload = json.dumps({'a': 1}).encode('utf-8')
    url = server.llm.serve('/ln/data.json', payload, 'application/json')
    d = server.tool('file_upload', {'url': url})
    assert d['filename'] == 'data.json' and d['mimetype'] == 'application/json'
    read = server.tool('file_read', {'id': d['id']})
    assert json.loads(read['content']) == {'a': 1}
    server.tool('file_delete', {'id': d['id']})


# ── 友達セッション ────────────────────────────────────────────────────

def _friend_post(server, token, method, params=None, id_=1, extra_headers=None):
    payload = {'jsonrpc': '2.0', 'id': id_, 'method': method}
    if params is not None:
        payload['params'] = params
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
    headers.update(extra_headers or {})
    return requests.post(server.base_url + '/mcp', json=payload, headers=headers, timeout=15)


def _friend_tool(server, token, name, args=None):
    r = _friend_post(server, token, 'tools/call', {'name': name, 'arguments': args or {}})
    assert r.status_code == 200, r.text
    return json.loads(r.json()['result']['content'][0]['text'])


def _write_registry(server, reg):
    d = os.path.join(server.data_root, 'friends')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'registry.json'), 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)


def test_friend_session_full_flow(server):
    with isolated_data(server):
        token = str(uuid_mod.uuid4())
        _write_registry(server, {token: {'seq_no': 1, 'nickname': 'テスト友', 'email': 'f@example.com',
                                         'status': 'active', 'created_at': '2026-10-01T00:00:00+09:00'}})

        r = _friend_post(server, token, 'initialize',
                         {'protocolVersion': '2025-03-26', 'clientInfo': {'name': 't', 'version': '1'}})
        assert r.status_code == 200
        assert r.headers.get('Mcp-Session-Id')
        res = r.json()['result']
        assert 'テスト友' in res['instructions'] and '## この人との記憶' in res['instructions']
        assert 'まだ何も記憶していません。' in res['instructions']
        assert res['serverInfo']['name'] == 'mio-memory' and res['protocolVersion'] == '2025-03-26'

        tools = _friend_post(server, token, 'tools/list').json()['result']['tools']
        assert [t['name'] for t in tools] == [
            'friend_memory_read', 'friend_memory_write', 'friend_memory_delete',
            'mio_self_note', 'friend_inbox_check', 'friend_inbox_read']

        assert _friend_tool(server, token, 'friend_memory_read') == {'content': 'まだ何も記憶していません。'}
        assert _friend_tool(server, token, 'friend_memory_write', {}) == {'error': 'content is required'}

        w = _friend_tool(server, token, 'friend_memory_write', {'content': 'カレーが好き', 'hitokoto': 'またね'})
        assert w['ok'] is True and len(w['updated']) == 10
        _friend_tool(server, token, 'friend_memory_write', {'content': '犬を飼っている'})
        text = _friend_tool(server, token, 'friend_memory_read')['content']
        assert text.startswith('# memory.md — テスト友との記憶')
        assert 'カレーが好き' in text and '犬を飼っている' in text and '（まだ何も記録していません）' not in text
        assert text.rstrip().endswith('またね')
        mem_file = os.path.join(server.data_root, 'friends', '001', 'memory.md')
        assert os.path.exists(mem_file)

        # 新しいセッションの instructions に記憶が入る
        res = _friend_post(server, token, 'initialize', {'protocolVersion': '2025-11-25'}).json()['result']
        assert 'カレーが好き' in res['instructions'] and res['protocolVersion'] == '2025-11-25'

        assert _friend_tool(server, token, 'friend_memory_delete', {'target': 'カレー'}) == {'ok': True, 'deleted': 1}
        assert _friend_tool(server, token, 'friend_memory_delete', {'target': 'nomatch'}) == {'ok': True, 'deleted': 0}
        assert _friend_tool(server, token, 'friend_memory_delete', {}) == {'error': 'target is required'}
        assert _friend_tool(server, token, 'friend_memory_delete', {'target': 'all'}) == {'ok': True, 'deleted': 'all'}
        text = _friend_tool(server, token, 'friend_memory_read')['content']
        assert '犬を飼っている' not in text and '（まだ何も記録していません）' in text

        # 澪メモ → 澪（chat）の inbox へ
        n = _friend_tool(server, token, 'mio_self_note', {'note': '抽象化された気づき'})
        assert n['ok'] is True
        msg = server.tool('inbox_read', {'id': n['id'], 'peek': True})
        assert msg['title'] == '【澪メモ】' and msg['body'] == '抽象化された気づき' and msg['from'] == 'friend'
        assert _friend_tool(server, token, 'mio_self_note', {'note': '  '}) == {'error': 'note is required'}

        # 友達宛の inbox
        chk = _friend_tool(server, token, 'friend_inbox_check')
        assert chk['non_persistent_unread_count'] == 0 and chk['persistent'] == []
        posted = server.tool('inbox_post', {'to': f'friend:{token}', 'title': '友へ', 'body': 'こんにちは'})
        chk = _friend_tool(server, token, 'friend_inbox_check')
        assert chk['non_persistent_unread_ids'] == [posted['id']]
        got = _friend_tool(server, token, 'friend_inbox_read', {'id': posted['id']})
        assert got['title'] == '友へ' and got['read'] is True
        assert _friend_tool(server, token, 'friend_inbox_check')['non_persistent_unread_count'] == 0
        assert 'message not found' in _friend_tool(server, token, 'friend_inbox_read', {'id': 'nope'})['error']
        assert _friend_tool(server, token, 'no_such_tool')['error'] == 'unknown friend tool: no_such_tool'

        # 友達セッションに通常ツールは存在しない（ツール名は friend 専用ハンドラへ）
        assert 'unknown friend tool' in _friend_tool(server, token, 'memory_read', {'id': 'x'})['error']

        # last_seen が記録される
        with open(os.path.join(server.data_root, 'friends', 'registry.json'), encoding='utf-8') as f:
            reg = json.load(f)
        assert reg[token]['last_seen']


def test_friend_session_batch_notifications_and_ping(server):
    with isolated_data(server):
        token = str(uuid_mod.uuid4())
        _write_registry(server, {token: {'seq_no': 2, 'nickname': 'バッチ友', 'email': 'b@example.com',
                                         'status': 'active', 'created_at': '2026-10-01T00:00:00+09:00'}})
        headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
        batch = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'ping'},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'no/such'},
        ]
        r = requests.post(server.base_url + '/mcp', json=batch, headers=headers, timeout=15)
        assert r.status_code == 200
        by_id = {m['id']: m for m in r.json()}
        assert len(by_id[1]['result']['tools']) == 6
        assert by_id[3]['result'] == {}
        assert by_id[4]['error']['code'] == -32601
        r = requests.post(server.base_url + '/mcp',
                          json={'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                          headers=headers, timeout=15)
        assert r.status_code == 202


def test_friend_token_not_active_or_unknown_is_unauthorized(server):
    with isolated_data(server):
        pending = str(uuid_mod.uuid4())
        revoked = str(uuid_mod.uuid4())
        _write_registry(server, {
            pending: {'seq_no': 3, 'nickname': '保留', 'email': 'p@example.com', 'status': 'pending',
                      'created_at': '2026-10-01T00:00:00+09:00'},
            revoked: {'seq_no': 4, 'nickname': '失効', 'email': 'r@example.com', 'status': 'revoked',
                      'created_at': '2026-10-01T00:00:00+09:00'},
        })
        for tok in (pending, revoked, str(uuid_mod.uuid4())):
            r = _friend_post(server, tok, 'tools/list')
            assert r.status_code == 401, tok
            assert r.json() == {'error': 'Unauthorized'}
