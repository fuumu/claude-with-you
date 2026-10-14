# -*- coding: utf-8 -*-
"""main.py の _MCP_TOOLS（通常セッションの MCP ツール定義）を ts/src/tool-defs.ts に、
_FRIEND_MCP_TOOLS と _DEFAULT_FRIEND_CORE（友達セッション用）を ts/src/friend-defs.ts に書き出す。

TS-1 リング4: tools/list を TS ネイティブにするための定義スナップショット。
main.py は import せず、ast で `_MCP_TOOLS = [...]` のリテラルだけを取り出す
（main.py はサーバー起動などの副作用を持つため）。

使い方（リポジトリルートで）:
    .venv/Scripts/python scripts/gen_ts_tool_defs.py          # 書き出し
    .venv/Scripts/python scripts/gen_ts_tool_defs.py --check  # 差分があれば exit 1

tests/test_mcp_core.py::test_ts_tool_defs_snapshot_matches_python が同じ照合を CI 相当で行う。
"""
import ast
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(ROOT, 'memory', 'app', 'main.py')
OUT_TS = os.path.join(ROOT, 'ts', 'src', 'tool-defs.ts')
OUT_FRIEND_TS = os.path.join(ROOT, 'ts', 'src', 'friend-defs.ts')

HEADER = (
    '/**\n'
    ' * 自動生成ファイル — 手で編集しない。\n'
    ' * 生成元: memory/app/main.py の _MCP_TOOLS（通常セッションの MCP ツール定義）\n'
    ' * 再生成: .venv/Scripts/python scripts/gen_ts_tool_defs.py\n'
    ' * 照合: tests/test_mcp_core.py::test_ts_tool_defs_snapshot_matches_python\n'
    ' */\n'
    'export interface ToolDef {\n'
    '  name: string;\n'
    '  description: string;\n'
    '  inputSchema: Record<string, unknown>;\n'
    '  [key: string]: unknown;\n'
    '}\n\n'
    'export const TOOL_DEFS: ToolDef[] = '
)


def load_literal(name):
    with io.open(MAIN_PY, encoding='utf-8') as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                getattr(t, 'id', None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit(f'{name} not found in main.py')


def load_tools():
    return load_literal('_MCP_TOOLS')


def render(tools):
    return HEADER + json.dumps(tools, ensure_ascii=False, indent=2) + ';\n'


FRIEND_HEADER = (
    '/**\n'
    ' * 自動生成ファイル — 手で編集しない。\n'
    ' * 生成元: memory/app/main.py の _FRIEND_MCP_TOOLS / _DEFAULT_FRIEND_CORE（友達セッション用）\n'
    ' * 再生成: .venv/Scripts/python scripts/gen_ts_tool_defs.py\n'
    ' */\n'
    "import type { ToolDef } from './tool-defs.js';\n\n"
    'export const FRIEND_TOOL_DEFS: ToolDef[] = '
)


def render_friend(tools, core):
    return (FRIEND_HEADER + json.dumps(tools, ensure_ascii=False, indent=2) + ';\n\n'
            + 'export const DEFAULT_FRIEND_CORE: string = '
            + json.dumps(core, ensure_ascii=False) + ';\n')


def _read(path):
    if not os.path.exists(path):
        return ''
    with io.open(path, encoding='utf-8', newline='') as f:
        return f.read().replace('\r\n', '\n')


def main():
    outputs = [
        (OUT_TS, render(load_tools())),
        (OUT_FRIEND_TS, render_friend(load_literal('_FRIEND_MCP_TOOLS'),
                                      load_literal('_DEFAULT_FRIEND_CORE'))),
    ]
    if '--check' in sys.argv:
        bad = False
        for path, text in outputs:
            rel = os.path.relpath(path, ROOT).replace(os.sep, '/')
            if _read(path) != text:
                print(f'{rel} is out of date; run scripts/gen_ts_tool_defs.py')
                bad = True
            else:
                print(f'{rel} is up to date')
        return 1 if bad else 0
    for path, text in outputs:
        with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
        print(f'wrote {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
