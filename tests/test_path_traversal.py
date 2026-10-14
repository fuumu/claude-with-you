# -*- coding: utf-8 -*-
"""パストラバーサル回帰テスト（PR #1 レビュー H1 / M2）

H1: memory_write / POST /api/memory / album_save は tags[0] を ID（＝ファイル名）に埋め込む。
    '..' や区切り文字を無害化しないと、{DATA_DIR}/{stamp}_../../x.json が DATA_ROOT 直下の
    x.json（oauth_store.json 等）に正規化されて上書きされる。
M2: inbox の to='friend:{token}' は token 部分がディレクトリ名になる。区切り・'..' を含む値は拒否する。
"""
import json
import os
import re

import pytest

SENTINEL = {'sentinel': True}
SAFE_ID = re.compile(r'^\d{8}_\d{6}_[^/\\\x00]*$')


@pytest.fixture
def sentinel(server):
    """DATA_ROOT 直下に置く番兵ファイル（トラバーサルが成立するとこれが上書きされる）"""
    p = os.path.join(server.data_root, 's.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(SENTINEL, f)
    yield p
    for name in ('s.json', 's.png', 's.jpg'):
        try:
            os.remove(os.path.join(server.data_root, name))
        except OSError:
            pass


def _untouched(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f) == SENTINEL


EVIL_TAGS = [
    '../../s',
    '..\\..\\s',
    '../../../oauth_store',
    '/etc/passwd',
    'a/../../s',
    '....//s',
    'ok\x00../../s',
]


@pytest.mark.parametrize('tag', EVIL_TAGS)
def test_memory_write_tag_is_sanitized(server, sentinel, tag):
    d = server.tool('memory_write', {'title': 'トラバーサル', 'body': '本文', 'tags': [tag]})
    assert 'error' not in d, d
    assert SAFE_ID.match(d['id']) and '..' not in d['id'], d['id']
    assert _untouched(sentinel)
    # 正しい場所（DATA_DIR 直下）に保存され、読み戻せる
    assert os.path.exists(os.path.join(server.data_root, 'memory', f"{d['id']}.json"))
    assert server.tool('memory_read', {'id': d['id']})['title'] == 'トラバーサル'
    server.tool('memory_upsert', {'id': d['id'], 'title': 'x'})  # 後始末の代わりに存在確認だけ


def test_memory_write_normal_tag_unchanged(server):
    """通常のタグは従来どおり（空白→_・先頭20コードポイント）"""
    d = server.tool('memory_write', {'title': 't', 'body': 'b', 'tags': ['会話 メモ テスト']})
    assert d['id'].endswith('_会話_メモ_テスト')
    d2 = server.tool('memory_write', {'title': 't', 'body': 'b', 'tags': ['あ' * 30]})
    assert d2['id'].endswith('_' + 'あ' * 20)


def test_memory_post_rest_tag_is_sanitized(server, sentinel):
    r = server.post('/api/memory', json={'title': 'REST トラバーサル', 'body': 'b', 'tags': ['../../s']})
    assert r.status_code in (200, 201), r.text
    entry_id = r.json()['id']
    assert SAFE_ID.match(entry_id) and '..' not in entry_id, entry_id
    assert _untouched(sentinel)
    assert server.get(f'/api/memory/{entry_id}').json()['title'] == 'REST トラバーサル'


def _png(path):
    from PIL import Image
    Image.new('RGB', (40, 30), (10, 120, 200)).save(path, format='PNG')
    return str(path)


@pytest.mark.parametrize('tag', ['../../s', '..\\..\\s'])
def test_album_save_tag_is_sanitized(server, sentinel, tmp_path, tag):
    p = _png(tmp_path / 'img.png')
    d = server.tool('album_save', {'file_path': p, 'tags': [tag]})
    assert 'error' not in d, d
    assert SAFE_ID.match(d['id']) and '..' not in d['id'], d['id']
    assert _untouched(sentinel)
    assert not os.path.exists(os.path.join(server.data_root, 's.png'))  # 画像の逸脱書き込みも無い
    assert os.path.exists(os.path.join(server.data_root, 'album', f"{d['id']}.png"))
    server.tool('album_delete', {'id': d['id']})


# ── M2: inbox の to=friend:{token} ───────────────────────────────────────────

BAD_TO = ['friend:../..', 'friend:..', 'friend:a/b', 'friend:a\\b', 'friend:', 'friend:a\x00b']


@pytest.mark.parametrize('to', BAD_TO)
def test_inbox_post_rejects_bad_friend_target(server, to):
    d = server.tool('inbox_post', {'to': to, 'title': 't', 'body': 'b'})
    assert 'error' in d and 'id' not in d, d


@pytest.mark.parametrize('to', BAD_TO)
def test_inbox_check_rejects_bad_friend_target(server, to):
    d = server.tool('inbox_check', {'to': to})
    assert 'error' in d, d


def test_inbox_rest_rejects_bad_friend_target(server):
    r = server.post('/api/inbox', json={'to': 'friend:../..', 'title': 't', 'body': 'b'})
    assert r.status_code == 400, r.text
    r = server.get('/api/inbox', params={'to': 'friend:../..'})
    assert r.status_code == 400, r.text
    # 副作用でディレクトリが DATA_ROOT 周辺に作られていない
    assert not os.path.exists(os.path.join(server.data_root, 'inbox', 'friend', '..', '..', 'x'))


def test_inbox_good_friend_target_still_works(server):
    tok = 'abcDEF123_-tok'
    p = server.tool('inbox_post', {'to': f'friend:{tok}', 'title': '友達宛', 'body': 'b'})
    assert p['id'].startswith('inbox_'), p
    d = server.tool('inbox_check', {'to': f'friend:{tok}'})
    assert p['id'] in d['non_persistent_unread_ids']
    server.tool('inbox_delete', {'id': p['id']})
