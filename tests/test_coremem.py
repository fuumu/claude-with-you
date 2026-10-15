# -*- coding: utf-8 -*-
"""UserCoreMemory 4ツール（save / read / list / delete）＋manifestマージの契約"""


def test_seeded_skeleton_present(server):
    """新規環境には CoreMem スケルトンが冪等シードされる（v3.43〜）"""
    d = server.tool('CoreMem_list', {})
    names = {f['name'] for f in d['data']}
    assert 'core.md' in names or 'core_manifest.md' in names, names
    assert 'protocol_guide.md' in names
    # 各要素は name / version / updated_at を持つ
    for key in ('name', 'version', 'updated_at'):
        assert key in d['data'][0], key


def test_save_read_roundtrip_and_versioning(server):
    v1 = server.tool('CoreMem_save', {'name': 'ts0_note.md', 'content': '# v1'})
    assert v1['version'] == 1 and v1['version_str'] == '001'
    v2 = server.tool('CoreMem_save', {'name': 'ts0_note.md', 'content': '# v2'})
    assert v2['version'] == 2

    latest = server.tool('CoreMem_read', {'name': 'ts0_note.md'})
    assert latest['content'] == '# v2'
    old = server.tool('CoreMem_read', {'name': 'ts0_note.md', 'version': 1})
    assert old['content'] == '# v1'


def test_save_append_mode_inserts_separator(server):
    server.tool('CoreMem_save', {'name': 'ts0_append.md', 'content': 'base'})
    server.tool('CoreMem_save', {'name': 'ts0_append.md', 'content': 'added', 'mode': 'append'})
    d = server.tool('CoreMem_read', {'name': 'ts0_append.md'})
    assert d['content'].startswith('base')
    assert '<!-- APPEND ' in d['content']
    assert d['content'].endswith('added')


def test_manifest_merge(server):
    """{stem}_manifest.md の order: リストで分割ファイルが BEGIN/END 区切りマージされる"""
    server.tool('CoreMem_save', {'name': 'ts0m_a.md', 'content': 'AAA'})
    server.tool('CoreMem_save', {'name': 'ts0m_b.md', 'content': '## 見出しB\nBBB'})
    server.tool('CoreMem_save', {'name': 'ts0m_manifest.md',
                                 'content': 'order:\n- ts0m_a.md\n- ts0m_b.md\n'})
    d = server.tool('CoreMem_read', {'name': 'ts0m.md'})
    assert d.get('merged') is True
    assert '<!-- BEGIN: ts0m_a.md -->' in d['content']
    assert 'AAA' in d['content'] and 'BBB' in d['content']
    assert 'manifest' in d
    assert '見出しB' in ' '.join(d['manifest'].get('ts0m_b.md', []))


def test_list_excludes_del_prefix(server):
    """__del__ プレフィックスのファイルは CoreMem_list から除外される（v3.57）"""
    server.tool('CoreMem_save', {'name': 'ts0_todelete.md', 'content': 'x'})
    server.tool('CoreMem_delete', {'src': 'ts0_todelete.md', 'dst': '__del__ts0_todelete.md'})
    names = {f['name'] for f in server.tool('CoreMem_list', {})['data']}
    assert 'ts0_todelete.md' not in names
    assert '__del__ts0_todelete.md' not in names
    # 実体は残っている（リネームなので読める）
    d = server.tool('CoreMem_read', {'name': '__del__ts0_todelete.md'})
    assert d['content'] == 'x'


def test_delete_removes_all_versions(server):
    server.tool('CoreMem_save', {'name': 'ts0_gone.md', 'content': '1'})
    server.tool('CoreMem_save', {'name': 'ts0_gone.md', 'content': '2'})
    d = server.tool('CoreMem_delete', {'name': 'ts0_gone.md'})
    assert d.get('deleted') == 'ts0_gone.md'
    r = server.tool('CoreMem_read', {'name': 'ts0_gone.md'})
    assert 'error' in r


def test_rest_coremem_read_merges_too(server):
    """REST GET /api/coremem/<name> も manifest マージする。?raw=true で素通し"""
    r = server.get('/api/coremem/ts0m.md')
    assert r.status_code == 200
    assert '<!-- BEGIN: ts0m_a.md -->' in r.json()['content']
    r2 = server.get('/api/coremem/ts0m_a.md?raw=true')
    assert r2.status_code == 200
    assert r2.json()['content'] == 'AAA'


# ── v3.80 / v3.85 / v3.90 / v3.96 の挙動（MCP 経由・TS ネイティブ化の回帰用）──────

def test_save_str_replace_unique_and_errors(server):
    server.tool('CoreMem_save', {'name': 'ts0_sr.md', 'content': 'alpha beta alpha gamma'})
    d = server.tool('CoreMem_save', {'name': 'ts0_sr.md', 'mode': 'str_replace',
                                     'old_str': 'alpha', 'new_str': 'X'})
    assert 'matches 2 times' in d['error']
    d = server.tool('CoreMem_save', {'name': 'ts0_sr.md', 'mode': 'str_replace',
                                     'old_str': 'zzz', 'new_str': 'X'})
    assert 'not found' in d['error']
    d = server.tool('CoreMem_save', {'name': 'ts0_sr.md', 'mode': 'str_replace', 'old_str': ''})
    assert 'old_str is required' in d['error']
    # 一意なら置換されて新しい版になる（new_str に $& を含めても文字通り扱う）
    d = server.tool('CoreMem_save', {'name': 'ts0_sr.md', 'mode': 'str_replace',
                                     'old_str': 'beta', 'new_str': 'B$&B'})
    assert d['version'] == 2
    assert server.tool('CoreMem_read', {'name': 'ts0_sr.md'})['content'] == 'alpha B$&B alpha gamma'
    # new_str 省略は削除
    server.tool('CoreMem_save', {'name': 'ts0_sr.md', 'mode': 'str_replace', 'old_str': ' gamma'})
    assert server.tool('CoreMem_read', {'name': 'ts0_sr.md'})['content'] == 'alpha B$&B alpha'
    d = server.tool('CoreMem_save', {'name': 'ts0_nofile.md', 'mode': 'str_replace',
                                     'old_str': 'a', 'new_str': 'b'})
    assert 'file not found' in d['error']


def test_save_guarded_when_manifest_exists(server):
    """manifest がある名前への直接書き込みは拒否される（v3.96）"""
    server.tool('CoreMem_save', {'name': 'ts0g_part.md', 'content': 'P'})
    server.tool('CoreMem_save', {'name': 'ts0g_manifest.md', 'content': 'order:\n- ts0g_part.md\n'})
    d = server.tool('CoreMem_save', {'name': 'ts0g.md', 'content': 'direct'})
    assert 'ts0g_manifest.md' in d['error']
    # 分割ファイル自体は書ける
    assert server.tool('CoreMem_save', {'name': 'ts0g_part.md', 'content': 'P2'})['version'] == 2


def test_save_records_source_conversation_uuid(server):
    d = server.tool('CoreMem_save', {'name': 'ts0_src.md', 'content': 'x',
                                     'source_conversation_uuid': 'conv-uuid-1'})
    assert d['source_conversation_uuid'] == 'conv-uuid-1'
    r = server.tool('CoreMem_read', {'name': 'ts0_src.md'})
    assert r['source_conversation_uuid'] == 'conv-uuid-1'
    listed = {f['name']: f for f in server.tool('CoreMem_list', {})['data']}
    assert listed['ts0_src.md']['source_conversation_uuid'] == 'conv-uuid-1'


def test_invalid_names_and_targets_rejected(server):
    for bad in ('../escape.md', '/abs.md', 'a/../../b.md'):
        assert server.tool('CoreMem_save', {'name': bad, 'content': 'x'})['error'] == 'invalid name'
        assert server.tool('CoreMem_read', {'name': bad})['error'] == 'invalid name'
    assert server.tool('CoreMem_save', {'content': 'x'})['error'] == 'name is required'
    for bad in ('../x', 'a/b', '_template'):
        d = server.tool('CoreMem_save', {'name': 'n.md', 'content': 'x', 'target': bad})
        assert d['error'].startswith('invalid target'), (bad, d)
    d = server.tool('CoreMem_read', {'name': 'n.md', 'target': 'no_such_project'})
    assert d['error'] == 'project not found: no_such_project'
    d = server.tool('CoreMem_list', {'target': 'no_such_project'})
    assert d['error'] == 'project not found: no_such_project'


def test_rename_and_delete_error_cases(server):
    server.tool('CoreMem_save', {'name': 'ts0_rn_a.md', 'content': 'a'})
    server.tool('CoreMem_save', {'name': 'ts0_rn_b.md', 'content': 'b'})
    assert 'src と dst は両方必須' in server.tool('CoreMem_delete', {'src': 'ts0_rn_a.md'})['error']
    assert server.tool('CoreMem_delete', {'src': 'ts0_rn_none.md', 'dst': 'x.md'})['error'] \
        == 'not found: ts0_rn_none.md'
    assert server.tool('CoreMem_delete', {'src': 'ts0_rn_a.md', 'dst': 'ts0_rn_b.md'})['error'] \
        == 'already exists: ts0_rn_b.md'
    assert server.tool('CoreMem_delete', {'name': 'ts0_rn_none.md'})['error'] \
        == 'not found: ts0_rn_none.md'
    assert 'name は必須' in server.tool('CoreMem_delete', {})['error']
    # 拡張子を変えるリネームでも全版が追従する
    server.tool('CoreMem_save', {'name': 'ts0_rn_c.md', 'content': 'c1'})
    server.tool('CoreMem_save', {'name': 'ts0_rn_c.md', 'content': 'c2'})
    d = server.tool('CoreMem_delete', {'src': 'ts0_rn_c.md', 'dst': 'ts0_rn_c.txt'})
    assert d['renamed'] is True
    assert server.tool('CoreMem_read', {'name': 'ts0_rn_c.txt'})['content'] == 'c2'
    assert server.tool('CoreMem_read', {'name': 'ts0_rn_c.txt', 'version': 1})['content'] == 'c1'


def test_read_session_checkin_and_refer_only(server):
    """CoreMem_read は出席簿に登録を残す。refer_only=true は残さない（v3.85）"""
    import json
    import os
    path = os.path.join(server.data_root, 'session_checkins.json')

    def entries():
        if not os.path.exists(path):
            return []
        with open(path, encoding='utf-8') as f:
            return json.load(f)

    server.tool('CoreMem_save', {'name': 'ts0_ci.md', 'content': 'x'})
    before = len(entries())
    server.tool('CoreMem_read', {'name': 'ts0_ci.md', 'refer_only': True})
    assert len(entries()) == before
    server.tool('CoreMem_read', {'name': 'ts0_ci.md', 'current_model': 'claude-opus-4-6'})
    after = entries()
    assert len(after) == before + 1
    last = after[-1]
    assert last['model'] == 'claude-opus-4-6' and last['individual'] == 'しずく'
    assert last['ttl_minutes'] is None
    # 30 分以内の同一モデルは重複登録されない
    server.tool('CoreMem_read', {'name': 'ts0_ci.md', 'current_model': 'claude-opus-4-6'})
    assert len(entries()) == len(after)
