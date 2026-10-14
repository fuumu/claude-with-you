# -*- coding: utf-8 -*-
"""main.py の _MCP_TOOLS（通常セッションの MCP ツール定義）を ts/src/tool-defs.ts に書き出す。

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


def load_tools():
    with io.open(MAIN_PY, encoding='utf-8') as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                getattr(t, 'id', None) == '_MCP_TOOLS' for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit('_MCP_TOOLS not found in main.py')


def render(tools):
    return HEADER + json.dumps(tools, ensure_ascii=False, indent=2) + ';\n'


def main():
    text = render(load_tools())
    if '--check' in sys.argv:
        cur = ''
        if os.path.exists(OUT_TS):
            with io.open(OUT_TS, encoding='utf-8', newline='') as f:
                cur = f.read().replace('\r\n', '\n')
        if cur != text:
            print('ts/src/tool-defs.ts is out of date; run scripts/gen_ts_tool_defs.py')
            return 1
        print('ts/src/tool-defs.ts is up to date')
        return 0
    with io.open(OUT_TS, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print(f'wrote {OUT_TS} ({len(json.loads(text.split("= ", 1)[1].rstrip(";\n")))} tools)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
