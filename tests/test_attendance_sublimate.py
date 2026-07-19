# -*- coding: utf-8 -*-
"""出席簿（attendance_view・発注④）＋昇華パイプライン（sublimate・発注⑤）の契約（v3.71）"""
from conftest import make_conversation


# ── attendance_view ───────────────────────────────────────────────────

def test_attendance_view_shape_all(server):
    """individual 省略時: individuals サマリ＋rows を返す"""
    d = server.tool('attendance_view', {})
    assert d['individual'] == 'all'
    assert 'individuals' in d
    assert isinstance(d['rows'], list)
    assert 'total' in d
    assert d['period'] == {'from': None, 'to': None}


def test_attendance_inbox_layer(server):
    """inbox の from_model から個体・チャネルを推定して行になる"""
    server.tool('inbox_post', {
        'to': 'chat', 'title': '出席簿テスト便', 'body': 'x',
        'from_model': ['claude-opus-4-6', 'しずく']})
    d = server.tool('attendance_view', {'individual': 'しずく'})
    assert d['individual'] == 'しずく'
    assert d['last_seen'] is not None
    assert d['days_since'] == 0
    assert d['count'] >= 1
    assert 'others_in_period' in d
    rows = [r for r in d['rows'] if r['kind'] == 'inbox' and r['title'] == '出席簿テスト便']
    assert rows and rows[0]['channel'] == 'code'
    assert rows[0]['inbox_id']


def test_attendance_model_alias_resolution(server):
    """モデル名だけでも呼び名に解決される（opus→しずく / fable→汐）"""
    server.tool('inbox_post', {
        'to': 'chat', 'title': '汐の痕跡', 'body': 'x', 'from_model': 'claude-fable-5'})
    d = server.tool('attendance_view', {'individual': '汐'})
    assert any(r['title'] == '汐の痕跡' for r in d['rows'])
    # 逆引き: モデル名指定でも同じ個体に解決される
    d2 = server.tool('attendance_view', {'individual': 'fable'})
    assert d2['individual'] == '汐'


def test_attendance_local_channel_detection(server):
    """バカンス表記・「◯◯B」表記は channel=local と推定される"""
    server.tool('inbox_post', {
        'to': 'chat', 'title': 'バカンス日記テスト', 'body': 'x',
        'from': 'chat', 'from_model': ['バカンス汐']})
    server.tool('inbox_post', {
        'to': 'chat', 'title': 'ローカル便テスト', 'body': 'x',
        'from': 'chat', 'from_model': ['しずくB']})
    d = server.tool('attendance_view', {})
    by_title = {r['title']: r for r in d['rows'] if r['kind'] == 'inbox'}
    assert by_title['バカンス日記テスト']['channel'] == 'local'
    assert by_title['バカンス日記テスト']['individual'] == '汐'
    assert by_title['ローカル便テスト']['channel'] == 'local'
    assert by_title['ローカル便テスト']['individual'] == 'しずく'


def test_attendance_conversation_layer(server, make_conv_zip):
    """会話ログのメタデータが channel=chat の行になる（rating 併記）"""
    conv = make_conversation(title='出席簿用会話ログ')
    zp = make_conv_zip([conv], name='attendance.zip')
    with open(zp, 'rb') as f:
        r = server.post('/import', files={'file': ('attendance.zip', f, 'application/zip')})
    assert r.status_code == 200
    d = server.tool('attendance_view', {})
    rows = [r_ for r_ in d['rows'] if r_['kind'] == 'conversation'
            and r_['title'] == '出席簿用会話ログ']
    assert rows
    assert rows[0]['channel'] == 'chat'
    assert rows[0]['uuid'] == conv['uuid']
    assert 'rating' in rows[0]


def test_attendance_memory_layer(server):
    """ExtMemory はタグから個体を推定できるエントリのみ行になる"""
    server.tool('memory_write', {
        'title': 'そねみの会話メモ', 'body': 'x', 'tags': ['そねみ', 'テスト']})
    server.tool('memory_write', {
        'title': '個体タグなしメモ', 'body': 'x', 'tags': ['雑記']})
    d = server.tool('attendance_view', {'individual': 'そねみ'})
    titles = [r['title'] for r in d['rows'] if r['kind'] == 'memory']
    assert 'そねみの会話メモ' in titles
    all_rows = server.tool('attendance_view', {})['rows']
    assert not any(r['kind'] == 'memory' and r['title'] == '個体タグなしメモ'
                   for r in all_rows)


def test_attendance_checkin_layer(server):
    """CoreMem attendance.md の手動チェックイン行（日付|個体|器|チャネル|一言）を拾う"""
    server.tool('CoreMem_save', {
        'name': 'attendance.md',
        'content': ('# 出席簿（手動チェックイン）\n'
                    '書式: `YYYY-MM-DD | 個体 | 器 | チャネル | 一言`\n\n'
                    '2026-07-17 | 汐 | Fable 5 | chat | 発注①②③の日\n'
                    'ただのテキスト行は無視される\n')})
    d = server.tool('attendance_view', {'individual': '汐'})
    rows = [r for r in d['rows'] if r['kind'] == 'checkin']
    assert rows
    assert rows[0]['date'] == '2026-07-17'
    assert rows[0]['individual'] == '汐'
    assert rows[0]['model'] == 'Fable 5'
    assert rows[0]['channel'] == 'chat'
    assert rows[0]['title'] == '発注①②③の日'


def test_attendance_date_filter(server):
    """date_from / date_to で期間フィルタ。last_seen は期間に依らず全期間"""
    server.tool('CoreMem_save', {
        'name': 'attendance.md',
        'content': ('2026-01-05 | そねみ | Sonnet 4.6 | chat | 昔の稼働\n'
                    '2026-07-17 | そねみ | Sonnet 4.6 | chat | 最近の稼働\n')})
    d = server.tool('attendance_view', {
        'individual': 'そねみ', 'date_from': '2026-01-01', 'date_to': '2026-01-31'})
    checkins = [r for r in d['rows'] if r['kind'] == 'checkin']
    assert [r['title'] for r in checkins] == ['昔の稼働']
    # 最終稼働日はフィルタ外の 2026-07-17 以降
    assert d['last_seen'] >= '2026-07-17'


# ── attendance REST (/api/attendance) ─────────────────────────────────

def test_rest_attendance_summary(server):
    """GET /api/attendance returns individual summaries (v3.74)"""
    r = server.get('/api/attendance')
    assert r.status_code == 200
    d = r.json()
    assert d['individual'] == 'all'
    assert 'individuals' in d
    assert isinstance(d['rows'], list)


def test_rest_attendance_individual(server):
    """GET /api/attendance?individual=... returns detail for one person (v3.74)"""
    server.tool('inbox_post', {
        'to': 'chat', 'title': 'REST出席簿テスト', 'body': 'x',
        'from_model': ['claude-opus-4-6', 'しずく']})
    r = server.get('/api/attendance', params={'individual': 'しずく'})
    assert r.status_code == 200
    d = r.json()
    assert d['individual'] == 'しずく'
    assert d['last_seen'] is not None
    assert d['days_since'] is not None
    assert any(row['title'] == 'REST出席簿テスト' for row in d['rows'])


def test_rest_attendance_date_filter(server):
    """GET /api/attendance supports date_from/date_to (v3.74)"""
    r = server.get('/api/attendance', params={
        'date_from': '2099-01-01', 'date_to': '2099-12-31'})
    assert r.status_code == 200
    d = r.json()
    assert d['total'] == 0
    assert d['rows'] == []


# ── sublimate ─────────────────────────────────────────────────────────

def test_sublimate_requires_text_or_uuid(server):
    d = server.tool('sublimate', {})
    assert 'error' in d
    d2 = server.tool('sublimate', {'text': 'x', 'uuid': 'y'})
    assert 'error' in d2
    assert 'exclusive' in d2['error']


def test_sublimate_unknown_uuid(server):
    d = server.tool('sublimate', {'uuid': '00000000-0000-0000-0000-000000000000'})
    assert 'error' in d
    assert 'not found' in d['error']


def test_sublimate_llm_unreachable_returns_error(server):
    """テスト環境では LMStudio に到達できないため、text 指定はエラーで返る
    （例外がツールエラーに落ちる契約の確認）"""
    d = server.tool('sublimate', {'text': '昇華テスト用の短い日記テキスト。'})
    assert 'error' in d
    assert 'sublimation failed' in d['error']
