# -*- coding: utf-8 -*-
"""TS-1 リング5 完了条件: 通常セッション 38 ツールがすべて TS ネイティブで、
tools.ts に Python 転送（FORWARD / null 返却）が残っていないこと。

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


def test_no_forward_left_in_tool_handlers():
    """ハンドラーが FORWARD を返す経路が残っていない（定義と dispatcher の判定以外に出現しない）"""
    src_dir = os.path.join(TS_DIR, 'src')
    users = []
    for fn in sorted(os.listdir(src_dir)):
        if not fn.endswith('.ts'):
            continue
        with open(os.path.join(src_dir, fn), encoding='utf-8') as f:
            text = f.read()
        # コメントを除いたコード中の FORWARD 識別子
        code = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
        code = re.sub(r'//[^\n]*', '', code)
        if re.search(r'\bFORWARD\b', code):
            users.append(fn)
    assert users == ['tool-types.ts', 'tools.ts'], users
