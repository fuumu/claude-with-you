# -*- coding: utf-8 -*-
"""album / file / project / oplog_list / attendance_view の MCP ツール境界挙動。

TS-1 リング4 グループ5〜8（TS ネイティブ化）の回帰用。Python 単体モードが基準で、
MIO_TS1=1 でも同じ期待値で通ること＝実装差がないことの確認になる。
"""
import io
import json
import os

import pytest

from conftest import new_uuid


def _png():
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (40, 20), color=(10, 120, 200)).save(buf, format='PNG')
    return buf.getvalue()


def _upload_album(server, tags='ts0album', comment='ring4'):
    r = server.post('/api/album/upload',
                    files={'file': ('r4.png', io.BytesIO(_png()), 'image/png')},
                    data={'comment': comment, 'tags': tags})
    assert r.status_code in (200, 201), r.text
    return r.json()['id']


def _call(server, name, arguments):
    """tools/call の生の result を返す（image content 等を見るため）"""
    res = server.mcp('tools/call', {'name': name, 'arguments': arguments})
    assert 'error' not in res, res.get('error')
    return res['result']


# ── album ────────────────────────────────────────────────────────────

@pytest.mark.requires_python
def test_album_list_read_share_delete(server):
    aid = _upload_album(server, tags='ts0album_a')
    other = _upload_album(server, tags='ts0album_b')

    d = server.tool('album_list', {'tags': ['ts0album_a']})
    assert [i['id'] for i in d['items']] == [aid] and d['total'] == 1
    d = server.tool('album_list', {})
    ids = [i['id'] for i in d['items']]
    assert aid in ids and other in ids
    created = [i['created_at'] for i in d['items']]
    assert created == sorted(created, reverse=True)  # 新しい順

    # 画像本体は image content + メタ JSON text で返る
    res = _call(server, 'album_read', {'id': aid})
    kinds = [c['type'] for c in res['content']]
    assert kinds == ['image', 'text']
    assert res['content'][0]['mimeType'] == 'image/png'
    meta = json.loads(res['content'][1]['text'])
    assert meta['id'] == aid and 'server_time' in meta and 'server_version' in meta

    s = server.tool('album_share', {'id': aid})
    assert s['url'].endswith(f"/api/album/shared/{s['token']}") and s['expires_at']
    r = server.anon().get(s['url'], timeout=10)
    assert r.status_code == 200 and r.headers['Content-Type'].startswith('image/png')

    d = server.tool('album_delete', {'id': aid})
    assert d['status'] == 'deleted' and d['id'] == aid
    assert server.tool('album_list', {'tags': ['ts0album_a']})['total'] == 0
    # 別エントリには影響しない
    assert server.tool('album_list', {'tags': ['ts0album_b']})['total'] == 1


def test_album_errors_and_traversal(server):
    assert server.tool('album_read', {})['error'] == 'id is required'
    assert server.tool('album_share', {})['error'] == 'id is required'
    assert server.tool('album_delete', {})['error'] == 'id is required'
    assert server.tool('album_read', {'id': 'nope'})['error'] == 'not found: nope'
    assert server.tool('album_share', {'id': 'nope'})['error'] == 'not found: nope'
    assert server.tool('album_delete', {'id': 'nope'})['error'] == 'album entry not found: nope'
    for bad in ('../x', 'a/b'):
        assert 'not found' in server.tool('album_read', {'id': bad})['error']
        assert 'not found' in server.tool('album_delete', {'id': bad})['error']
    assert server.tool('album_list', {'tags': ['存在しないタグ']})['total'] == 0


@pytest.mark.requires_python
def test_album_adult_protection_flow(server):
    aid = _upload_album(server, tags='ts0album_adult')
    r = server.patch(f'/api/album/{aid}', json={'rating': 'adult', 'guard_message': '見る前に読んで'})
    assert r.status_code == 200, r.text

    # 一覧は既定で除外、include_adult で表示
    assert server.tool('album_list', {'tags': ['ts0album_adult']})['total'] == 0
    assert server.tool('album_list', {'tags': ['ts0album_adult'], 'include_adult': True})['total'] == 1

    d = server.tool('album_read', {'id': aid})
    assert d['protected'] is True and 'guard_message' not in d  # include_adult なし
    d = server.tool('album_read', {'id': aid, 'include_adult': True})
    assert d['protected'] is True and d['guard_message'] == '見る前に読んで'
    res = _call(server, 'album_read', {'id': aid, 'include_adult': True,
                                       'acknowledged': True, 'viewer': 'ts0'})
    assert [c['type'] for c in res['content']] == ['image', 'text']
    # 閲覧記録が残る
    meta = json.loads(res['content'][1]['text'])
    again = _call(server, 'album_read', {'id': aid, 'include_adult': True, 'acknowledged': True})
    meta2 = json.loads(again['content'][1]['text'])
    assert len(meta2['view_log']) == len(meta.get('view_log', [])) + 1
    assert meta2['view_log'][0]['viewer'] == 'ts0'


# ── file ─────────────────────────────────────────────────────────────

def test_file_upload_from_url_and_lifecycle(server):
    # 自分自身の /health（認証不要・JSON）をダウンロード元にする
    # （拡張子 .json は Python 版で実体とメタデータが衝突する既知の不具合があるため .txt で保存）
    d = server.tool('file_upload', {'url': server.base_url + '/health',
                                    'filename': 'ts0 health.txt', 'comment': 'ring4',
                                    'tags': ['ts0file', '  ', 'r4']})
    assert 'error' not in d, d
    fid = d['id']
    assert d['filename'] == 'ts0 health.txt'
    assert d['mimetype'] == 'application/json'  # Content-Type ヘッダ由来
    assert d['size'] > 0 and fid.endswith('_ts0 health')

    r = server.tool('file_read', {'id': fid})
    assert r['ext'] == 'txt' and r['tags'] == ['ts0file', 'r4'] and r['comment'] == 'ring4'
    assert json.loads(r['content'])  # テキスト系は content が付く

    lst = server.tool('file_list', {'tags': ['TS0FILE']})  # タグは大文字小文字を区別しない
    assert lst['count'] == 1 and lst['items'][0]['id'] == fid
    assert set(lst['items'][0]) == {'id', 'filename', 'mimetype', 'size', 'comment', 'tags',
                                    'uploaded_at'}

    assert server.tool('file_delete', {'id': fid})['deleted'] == fid
    assert server.tool('file_read', {'id': fid})['error'] == f'Upload not found: {fid}'


def test_file_errors_and_path_variants(server):
    assert server.tool('file_read', {})['error'] == 'id is required'
    assert server.tool('file_delete', {})['error'] == 'id is required'
    assert server.tool('file_delete', {'id': 'nope'})['error'] == 'Upload not found: nope'
    assert 'Upload not found' in server.tool('file_read', {'id': '../x'})['error']
    # url も file_path も無い
    assert server.tool('file_upload', {})['error'] == 'url or file_path is required'
    # 存在しない file_path（Python 側の検証）
    d = server.tool('file_upload', {'file_path': '/no/such/file.txt'})
    assert 'File not found' in d['error']


# ── project ──────────────────────────────────────────────────────────

def test_project_create_list_and_isolation(server):
    d = server.tool('project_create', {'name': 'ts0proj'})
    assert d['created'] == 'ts0proj' and d['path'] == 'projects/ts0proj'
    assert d['files'] == ['PROJECT.md', 'todo.md', 'design.md', 'notes.md', 'inbox.md',
                          'conversations.md', 'log.md', 'files/']
    assert 'already exists' in server.tool('project_create', {'name': 'ts0proj'})['error']
    assert server.tool('project_create', {})['error'] == 'name is required'
    for bad in ('../x', 'a/b', '_template'):
        assert 'invalid project name' in server.tool('project_create', {'name': bad})['error']

    # テンプレートの置換（プロジェクト名・作成日）と、プロジェクト内ファイルの CoreMem 操作
    pm = server.tool('CoreMem_read', {'name': 'PROJECT.md', 'target': 'ts0proj'})
    assert pm['content'].startswith('# ts0proj\n') and '{project_name}' not in pm['content']
    assert '{date}' not in pm['content'] and '- 状態: 準備中' in pm['content']
    server.tool('CoreMem_save', {'name': 'notes.md', 'target': 'ts0proj', 'content': '# 隔離メモ'})
    assert server.tool('CoreMem_read', {'name': 'notes.md', 'target': 'ts0proj'})['content'] == '# 隔離メモ'
    # 家の CoreMem とは別名前空間
    assert 'error' in server.tool('CoreMem_read', {'name': 'notes.md'}) \
        or server.tool('CoreMem_read', {'name': 'notes.md'})['content'] != '# 隔離メモ'

    lst = server.tool('project_list', {})
    mine = [p for p in lst['projects'] if p['name'] == 'ts0proj']
    assert mine and mine[0]['summary'] == ''  # 概要が未記入（（…）で始まる）なら空
    # 概要を書くと summary に出る
    body = pm['content'].replace('（プロジェクトの目的・ゴールを記載）', 'ring4 の検証用プロジェクト')
    server.tool('CoreMem_save', {'name': 'PROJECT.md', 'target': 'ts0proj', 'content': body})
    lst = server.tool('project_list', {})
    assert [p for p in lst['projects'] if p['name'] == 'ts0proj'][0]['summary'] \
        == 'ring4 の検証用プロジェクト'


# ── oplog_list / attendance_view ─────────────────────────────────────

def test_oplog_list_filters_and_order(server):
    w = server.tool('memory_write', {'title': 'oplog境界', 'body': 'x', 'tags': ['ts0op']})
    server.tool('memory_upsert', {'id': 'ts0_op_fixed', 'title': 'u', 'body': 'u'})
    d = server.tool('oplog_list', {'limit': 5})
    assert d['total'] >= 2 and len(d['rows']) <= 5
    stamps = [r['timestamp'] for r in d['rows']]
    assert stamps == sorted(stamps, reverse=True)  # 新しい順
    assert set(d['rows'][0]) == {'timestamp', 'operation', 'target_id'}

    d = server.tool('oplog_list', {'operation': 'create'})
    assert w['id'] in [r['target_id'] for r in d['rows']]
    assert all(r['operation'] == 'create' for r in d['rows'])
    d = server.tool('oplog_list', {'operation': 'upsert'})
    assert 'ts0_op_fixed' in [r['target_id'] for r in d['rows']]
    # 期間: date_to が日付のみなら当日末まで含む
    today = w['created_at'][:10]
    d = server.tool('oplog_list', {'date_from': today, 'date_to': today, 'operation': 'create'})
    assert w['id'] in [r['target_id'] for r in d['rows']]
    d = server.tool('oplog_list', {'date_to': '2000-01-01'})
    assert d['total'] == 0 and d['rows'] == []


def test_attendance_view_individual_kind_and_period(server):
    server.tool('CoreMem_read', {'name': 'core.md', 'current_model': 'claude-opus-4-6'})
    server.tool('memory_write', {'title': 'しずくの足跡', 'body': 'x', 'tags': ['しずく']})
    server.tool('inbox_post', {'to': 'chat', 'title': 'ts0出席簿', 'from_model': ['claude-opus-4-6']})

    d = server.tool('attendance_view', {'individual': 'しずく'})
    assert d['individual'] == 'しずく'
    assert d['count'] >= 3 and d['last_seen'] and d['days_since'] == 0
    kinds = {r['kind'] for r in d['rows']}
    assert {'memory', 'inbox', 'session_checkin'} <= kinds
    dates = [r['date'] for r in d['rows']]
    assert dates == sorted(dates, reverse=True)
    assert d['period'] == {'from': None, 'to': None}

    d = server.tool('attendance_view', {'individual': 'しずく', 'kind': 'memory, inbox'})
    assert {r['kind'] for r in d['rows']} <= {'memory', 'inbox'}

    d = server.tool('attendance_view', {'individual': 'しずく', 'limit': 1})
    assert len(d['rows']) == 1 and d['total'] >= 3

    # 全体ビュー: 個体別サマリ
    d = server.tool('attendance_view', {})
    assert d['individual'] == 'all' and 'しずく' in d['individuals']
    assert set(d['individuals']['しずく']) == {'last_seen', 'days_since', 'count'}

    # 期間外は空（最終稼働日は全期間で出る）
    d = server.tool('attendance_view', {'individual': 'しずく', 'date_to': '2000-01-01'})
    assert d['total'] == 0 and d['last_seen']
