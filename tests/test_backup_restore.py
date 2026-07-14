# -*- coding: utf-8 -*-
"""バックアップ復元 import（POST /api/import/backup・B1後半・v3.63）の契約。

export（GET /api/export・v3.46）が生成する ZIP を復元する。
- mode=skip（デフォルト）: 既存 ID / 既存 CoreMem 名は触らず conflicts に列挙
- mode=overwrite: 既存を上書き（CoreMem は版管理経由の新バージョン積み）
- dry_run=true: 書き込みなしで件数プレビュー
TS1 モードでは未移行エンドポイントなので Python へプロキシされる（それで正しい）。
"""
import io
import json
import zipfile


def _make_backup_zip(entries=None, coremem=None):
    """export ZIP と同一構造の ZIP をメモリ上で作る"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for e in (entries or []):
            z.writestr(f'extmemory/memory/{e["id"]}.json',
                       json.dumps(e, ensure_ascii=False, indent=2))
        for name, content in (coremem or {}).items():
            z.writestr(f'coremem/{name}', content)
        z.writestr('export_meta.json', json.dumps(
            {'exported_at': 'test', 'note': 'synthetic backup for tests'}))
    buf.seek(0)
    return buf


def _entry(entry_id, title, body='復元テスト本文'):
    return {
        'id': entry_id, 'created_at': '2026-07-01T10:00:00+09:00',
        'updated_at': '2026-07-01T10:00:00+09:00', 'title': title,
        'body': body, 'tags': ['復元テスト'], 'source_thread': '',
        'importance': 'normal', 'author': 'mio', 'deleted': False,
    }


def _import(server, zip_buf, **form):
    return server.post('/api/import/backup',
                       files={'file': ('backup.zip', zip_buf, 'application/zip')},
                       data=form)


def test_restore_new_entries_and_coremem(server):
    """新規ID・新規CoreMem名の復元: restored にカウントされ、実際に読める＋indexに載る"""
    zbuf = _make_backup_zip(
        entries=[_entry('20260701_100000_復元テスト', '復元された記憶')],
        coremem={'b1_restore_note.md': '# 復元されたコアメモリ\n中身'})
    r = _import(server, zbuf)
    assert r.status_code == 200
    d = r.json()
    assert d['mode'] == 'skip' and d['dry_run'] is False
    assert d['memory'] == {'restored': 1, 'skipped': 0, 'overwritten': 0}
    assert d['coremem'] == {'restored': 1, 'skipped': 0, 'overwritten': 0}
    assert d['errors'] == []
    assert 'export_meta' in d

    got = server.get('/api/memory/20260701_100000_復元テスト')
    assert got.status_code == 200
    assert got.json()['title'] == '復元された記憶'

    idx = server.get('/api/memory/index').json()
    assert any(e['id'] == '20260701_100000_復元テスト' for e in idx)

    core = server.get('/api/coremem/b1_restore_note.md')
    assert core.status_code == 200
    assert '復元されたコアメモリ' in core.json()['content']


def test_real_export_roundtrip_skips_everything(server):
    """実 export の ZIP をそのまま再インポート → mode=skip では全件スキップ＋衝突列挙"""
    r = server.get('/api/export')
    assert r.status_code == 200
    d = _import(server, io.BytesIO(r.content)).json()
    assert d['memory']['restored'] == 0 and d['memory']['overwritten'] == 0
    assert d['coremem']['restored'] == 0 and d['coremem']['overwritten'] == 0
    assert d['memory']['skipped'] >= 1  # 少なくとも前テストの復元エントリが存在
    assert d['coremem']['skipped'] >= 1
    assert any(c.startswith('memory:') for c in d['conflicts'])
    assert any(c.startswith('coremem:') for c in d['conflicts'])


def test_overwrite_restores_original_content(server):
    """改変後に mode=overwrite で復元 → 内容がバックアップ時点に戻る。CoreMem は新版が積まれる"""
    # バックアップ時点の状態を ZIP 化
    zbuf = _make_backup_zip(
        entries=[_entry('20260701_110000_復元テスト', 'バックアップ時点のタイトル')],
        coremem={'b1_overwrite.md': 'バックアップ時点の内容'})
    assert _import(server, zbuf).json()['memory']['restored'] == 1

    # その後の改変
    r = server.patch('/api/memory/20260701_110000_復元テスト',
                     json={'title': '改変後のタイトル'})
    assert r.status_code == 200
    server.post('/api/coremem/b1_overwrite.md', json={'content': '改変後の内容'})

    # skip では戻らない
    zbuf2 = _make_backup_zip(
        entries=[_entry('20260701_110000_復元テスト', 'バックアップ時点のタイトル')],
        coremem={'b1_overwrite.md': 'バックアップ時点の内容'})
    d = _import(server, zbuf2).json()
    assert d['memory']['skipped'] == 1
    assert server.get('/api/memory/20260701_110000_復元テスト').json()['title'] == '改変後のタイトル'

    # overwrite で戻る
    zbuf3 = _make_backup_zip(
        entries=[_entry('20260701_110000_復元テスト', 'バックアップ時点のタイトル')],
        coremem={'b1_overwrite.md': 'バックアップ時点の内容'})
    d = _import(server, zbuf3, mode='overwrite').json()
    assert d['memory'] == {'restored': 0, 'skipped': 0, 'overwritten': 1}
    assert d['coremem']['overwritten'] == 1
    assert server.get('/api/memory/20260701_110000_復元テスト').json()['title'] == 'バックアップ時点のタイトル'
    core = server.get('/api/coremem/b1_overwrite.md').json()
    assert core['content'] == 'バックアップ時点の内容'
    # 版管理経由: 改変前の版も残っている（破壊しない）
    versions = server.get('/api/coremem').json()
    ver = next(i['version'] for i in versions if i['name'] == 'b1_overwrite.md')
    assert ver >= 3


def test_dry_run_writes_nothing(server):
    zbuf = _make_backup_zip(
        entries=[_entry('20260701_120000_復元テスト', 'dry_run はファイルを作らない')],
        coremem={'b1_dryrun.md': 'dry run'})
    d = _import(server, zbuf, dry_run='true').json()
    assert d['dry_run'] is True
    assert d['memory']['restored'] == 1 and d['coremem']['restored'] == 1
    assert server.get('/api/memory/20260701_120000_復元テスト').status_code == 404
    assert server.get('/api/coremem/b1_dryrun.md').status_code == 404


def test_rejects_bad_input(server):
    # file なし
    r = server.post('/api/import/backup', data={'mode': 'skip'})
    assert r.status_code == 400
    # ZIP でない
    r = server.post('/api/import/backup',
                    files={'file': ('x.zip', io.BytesIO(b'not a zip'), 'application/zip')})
    assert r.status_code == 400
    # export 構造でない ZIP
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('unrelated.txt', 'x')
    buf.seek(0)
    r = server.post('/api/import/backup', files={'file': ('x.zip', buf, 'application/zip')})
    assert r.status_code == 400
    # 不正 mode
    zbuf = _make_backup_zip(coremem={'b1_mode.md': 'x'})
    r = _import(server, zbuf, mode='merge')
    assert r.status_code == 400
    # パストラバーサルを含む CoreMem 名は errors に落ちて書き込まれない
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('coremem/../evil.md', 'x')
    buf.seek(0)
    d = server.post('/api/import/backup',
                    files={'file': ('x.zip', buf, 'application/zip')}).json()
    assert d['coremem'] == {'restored': 0, 'skipped': 0, 'overwritten': 0}
    assert any('invalid name' in e for e in d['errors'])
