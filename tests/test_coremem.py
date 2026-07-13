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
