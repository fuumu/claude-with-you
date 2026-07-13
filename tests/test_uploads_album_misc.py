# -*- coding: utf-8 -*-
"""Uploads / Album / バッチ / その他RESTの契約"""
import io
import json


def _make_png_bytes():
    """Pillow で最小のPNGを生成"""
    from PIL import Image
    img = Image.new('RGB', (64, 32), color=(200, 100, 50))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


# ── Uploads（v3.59）──────────────────────────────────────────────────

def test_uploads_roundtrip(server):
    content = 'TS0アップロードテスト本文'.encode('utf-8')
    r = server.post('/api/uploads/',
                    files={'file': ('ts0_doc.md', io.BytesIO(content), 'text/markdown')},
                    data={'comment': '契約テスト', 'tags': 'ts0, 資料'})
    assert r.status_code == 201
    meta = r.json()
    uid = meta['id']
    assert meta['filename'] == 'ts0_doc.md'
    assert meta['ext'] == 'md'
    assert meta['size'] == len(content)
    assert meta['tags'] == ['ts0', '資料']  # カンマ・読点・空白区切りをリスト化

    # 一覧に出る
    lst = server.get('/api/uploads/').json()
    assert any(f['id'] == uid for f in lst)

    # ダウンロードで原文が返る
    dl = server.get(f'/api/uploads/{uid}')
    assert dl.status_code == 200
    assert dl.content == content

    # MCP file_read はテキスト系なら content を含む（50K上限）
    d = server.tool('file_read', {'id': uid})
    assert 'TS0アップロードテスト本文' in d.get('content', '')

    # MCP file_list はタグフィルタ対応
    d2 = server.tool('file_list', {'tags': ['ts0']})
    items = d2.get('data', d2 if isinstance(d2, list) else d2.get('items', []))
    assert any(f['id'] == uid for f in items)

    # 削除（物理・復元不可）
    rm = server.delete(f'/api/uploads/{uid}')
    assert rm.status_code == 200
    assert server.get(f'/api/uploads/{uid}').status_code == 404


def test_uploads_delete_not_found(server):
    r = server.delete('/api/uploads/nonexistent_id_xyz')
    assert r.status_code == 404


# ── Album ────────────────────────────────────────────────────────────

def test_album_upload_list_patch_delete(server):
    png = _make_png_bytes()
    r = server.post('/api/album/upload',
                    files={'file': ('ts0.png', io.BytesIO(png), 'image/png')},
                    data={'comment': 'TS0画像', 'tags': 'ts0'})
    assert r.status_code in (200, 201), r.text
    meta = r.json()
    aid = meta['id']
    assert meta.get('width') and meta.get('height')

    # 一覧
    lst = server.get('/api/album/').json()
    items = lst['items'] if isinstance(lst, dict) else lst
    assert any(m['id'] == aid for m in items)

    # 画像本体
    img = server.get(f'/api/album/{aid}')
    assert img.status_code == 200
    assert img.content[:8] == b'\x89PNG\r\n\x1a\n'

    # メタデータ更新
    p = server.patch(f'/api/album/{aid}', json={'comment': '更新後コメント'})
    assert p.status_code == 200

    # 共有URL（認証なしで画像が返る）
    sh = server.post(f'/api/album/{aid}/share')
    assert sh.status_code == 200
    token = sh.json()['token']
    anon = server.anon().get(f'{server.base_url}/api/album/shared/{token}', timeout=10)
    assert anon.status_code == 200

    # album_list MCP（メタのみ）
    d = server.tool('album_list', {'tags': ['ts0']})
    items = d.get('items', d.get('data', []))
    assert any(m['id'] == aid for m in items)

    # 削除
    rm = server.delete(f'/api/album/{aid}')
    assert rm.status_code == 200
    assert server.get(f'/api/album/{aid}').status_code == 404


# ── バッチ ────────────────────────────────────────────────────────────

def test_batch_status_only(server):
    d = server.tool('batch_run_summary_layers', {'status_only': True})
    for key in ('running', 'total', 'processed', 'errors', 'skipped',
                'raw_pending', 'keywords_pending'):
        assert key in d, key
    r = server.get('/api/batch/status')
    assert r.status_code == 200
    assert 'running' in r.json()


# ── REST その他 ──────────────────────────────────────────────────────

def test_rest_memory_crud(server):
    # POST /api/memory（IDはサーバー採番: YYYYMMDD_HHMMSS_<先頭タグ>）
    r = server.post('/api/memory', json={
        'title': 'REST作成', 'body': 'rest body', 'tags': ['ts0rest']})
    assert r.status_code == 201
    entry = r.json()
    assert entry['id'].endswith('_ts0rest')

    # GET / PATCH / DELETE
    g = server.get(f"/api/memory/{entry['id']}")
    assert g.status_code == 200 and g.json()['title'] == 'REST作成'

    p = server.patch(f"/api/memory/{entry['id']}", json={'title': 'REST更新'})
    assert p.status_code == 200 and p.json()['title'] == 'REST更新'

    d = server.delete(f"/api/memory/{entry['id']}")
    assert d.status_code == 200

    # 削除は論理削除: index から消えるが、直接GETでは deleted=true で読める
    idx = server.get('/api/memory/index').json()
    assert not any(e['id'] == entry['id'] for e in idx)
    g2 = server.get(f"/api/memory/{entry['id']}")
    assert g2.status_code == 200 and g2.json()['deleted'] is True


def test_rest_hsearch_include_conversations(server):
    """REST hsearch も include_conversations=true 対応（v3.61）"""
    r = server.get('/api/memory/hsearch?q=存在しない語zzz&include_conversations=true')
    assert r.status_code == 200
    d = r.json()
    assert 'conversations' in d and 'conversations_total' in d


def test_rest_export_zip(server):
    r = server.get('/api/export')
    assert r.status_code == 200
    assert r.content[:2] == b'PK'  # ZIP マジック


def test_rest_reindex(server):
    r = server.post('/api/memory/reindex')
    assert r.status_code == 200


def test_import_status(server):
    r = server.get('/api/import-status')
    assert r.status_code == 200
