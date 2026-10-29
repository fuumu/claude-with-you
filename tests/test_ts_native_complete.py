# -*- coding: utf-8 -*-
"""TS-1 リング5 完了条件: 通常セッション 38 ツールがすべて TS ネイティブで、
tools.ts に Python 転送（FORWARD / null 返却）が残っていないこと。
TS-FULL ステップ1: /mcp と /health が Python に一切問い合わせないこと。

MIO_TS1=1 のときだけ意味があるためそれ以外はスキップ（Python 単体モードは main.py が全部処理する）。
"""
import json
import os
import re
import subprocess

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_DIR = os.path.join(REPO_ROOT, 'ts')

pytestmark = pytest.mark.skipif(os.environ.get('MIO_TS1') != '1', reason='TS1 専用')


def test_all_tools_are_native(server):
    """tools/list の全ツールにネイティブハンドラーがある（dist は server フィクスチャがビルド済み）"""
    script = (
        "import('./dist/tools.js').then(m => {"
        "const names = m.listTools().map(t => t.name);"
        "const missing = names.filter(n => !m.isNativeTool(n));"
        "console.log(JSON.stringify({count: names.length, missing}));"
        "});"
    )
    out = subprocess.run(['node', '-e', script], cwd=TS_DIR, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res['count'] == 38
    assert res['missing'] == []


def _code_without_comments(fn):
    with open(os.path.join(TS_DIR, 'src', fn), encoding='utf-8') as f:
        text = f.read()
    code = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'//[^\n]*', '', code)


def test_no_forward_left_in_tool_handlers():
    """ハンドラーが Python 転送を指定する FORWARD の仕組みが残っていない（TS-FULL ステップ1 で撤去）"""
    src_dir = os.path.join(TS_DIR, 'src')
    users = [fn for fn in sorted(os.listdir(src_dir))
             if fn.endswith('.ts') and re.search(r'\bFORWARD\b', _code_without_comments(fn))]
    assert users == [], users


def test_mcp_transport_has_no_upstream():
    """mcp.ts は Python（upstream）を参照しない（未知メソッド・バージョンも TS が自前で返す）"""
    code = _code_without_comments('mcp.ts')
    assert not re.search(r'UPSTREAM|forwardToUpstream|upstreamVersion', code)
