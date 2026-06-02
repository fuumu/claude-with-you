#!/usr/bin/env python3
"""
generate_summary_layers.py — rawエントリから2層（要約）・3層（シンボリック圧縮）を生成する

必要な環境変数:
  ANTHROPIC_API_KEY  Anthropic APIキー
  MIO_API_TOKEN      mio-memory Bearer認証トークン
  MIO_SERVER_URL     サーバーURL（省略時: https://memory.mio.runabook.synology.me）

実行:
  python scripts/generate_summary_layers.py
  python scripts/generate_summary_layers.py --dry-run   # API呼び出しなしで対象確認のみ
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error

# ── 依存チェック ──────────────────────────────────────────────────────
try:
    import anthropic
except ImportError:
    print("Error: anthropic パッケージが必要です")
    print("  pip install anthropic")
    sys.exit(1)

# ── 設定 ─────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
MIO_API_TOKEN     = os.environ.get('MIO_API_TOKEN', '')
MIO_SERVER_URL    = os.environ.get('MIO_SERVER_URL', 'https://memory.mio.runabook.synology.me').rstrip('/')

MODEL = 'claude-haiku-4-5-20251001'
RATE_LIMIT_SLEEP = 0.5  # 秒

SUMMARY_MARKER  = '## 2層: 要約'
SYMBOLIC_MARKER = '## 3層: シンボリック圧縮'


def check_env():
    if not ANTHROPIC_API_KEY:
        print("Error: 環境変数 ANTHROPIC_API_KEY を設定してください")
        sys.exit(1)
    if not MIO_API_TOKEN:
        print("Error: 環境変数 MIO_API_TOKEN を設定してください")
        sys.exit(1)


# ── REST API ヘルパー ─────────────────────────────────────────────────
def _headers(extra=None):
    h = {'Authorization': f'Bearer {MIO_API_TOKEN}', 'Content-Type': 'application/json'}
    if extra:
        h.update(extra)
    return h


def api_get(path):
    url = MIO_SERVER_URL + path
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {MIO_API_TOKEN}'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def api_patch(path, data):
    url = MIO_SERVER_URL + path
    body = json.dumps(data, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=body, headers=_headers(), method='PATCH')
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


# ── Claude API ────────────────────────────────────────────────────────
def generate_layers(title: str) -> str:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    prompt = f"""以下はClaude.aiの会話タイトルです。タイトルだけから推測できる範囲で要約と圧縮表現を生成してください。

会話タイトル: {title}

以下の形式で出力してください（他の説明文は不要）:

## 2層: 要約
（会話の目的・内容・結論を2〜3文で推測。"〜についての会話" という形式でよい）

## 3層: シンボリック圧縮
（15文字以内の超短縮キーワード。検索時の手がかりになる表現）"""

    msg = client.messages.create(
        model=MODEL,
        max_tokens=200,
        messages=[{'role': 'user', 'content': prompt}]
    )
    return msg.content[0].text.strip()


# ── メイン処理 ────────────────────────────────────────────────────────
def main(dry_run: bool):
    print(f"サーバー: {MIO_SERVER_URL}")
    print(f"モデル  : {MODEL}")
    print(f"dry-run : {dry_run}")
    print()

    print("インデックスを取得中...")
    try:
        index = api_get('/api/memory/index')
    except Exception as e:
        print(f"Error: インデックス取得失敗 — {e}")
        sys.exit(1)

    raw_entries = [e for e in index if 'raw' in (e.get('tags') or []) and not e.get('deleted')]
    print(f"rawエントリ: {len(raw_entries)} 件 / 全体: {len(index)} 件\n")

    processed = skipped = errors = 0

    for i, idx in enumerate(raw_entries, 1):
        entry_id = idx['id']
        title    = idx.get('title', '（無題）')

        # フル取得（bodyを確認するため）
        try:
            entry = api_get(f'/api/memory/{entry_id}')
        except Exception as e:
            print(f"[{i:>3}/{len(raw_entries)}] ERROR  {entry_id}: {e}")
            errors += 1
            continue

        body = entry.get('body', '')

        # 処理済みチェック
        if SUMMARY_MARKER in body:
            print(f"[{i:>3}/{len(raw_entries)}] SKIP   {title[:55]}")
            skipped += 1
            continue

        print(f"[{i:>3}/{len(raw_entries)}] 生成中 {title[:55]}")

        if dry_run:
            processed += 1
            continue

        try:
            layers = generate_layers(title)

            new_body = (body.strip() + '\n\n' + layers).strip() if body.strip() else layers
            tags = [t for t in (entry.get('tags') or []) if t != 'raw']
            if 'summarized' not in tags:
                tags.append('summarized')

            api_patch(f'/api/memory/{entry_id}', {
                'body': new_body,
                'tags': tags,
            })
            processed += 1
            time.sleep(RATE_LIMIT_SLEEP)

        except Exception as e:
            print(f"           ERROR: {e}")
            errors += 1

    print()
    print(f"完了  処理={processed}件  スキップ={skipped}件  エラー={errors}件")
    if dry_run:
        print("（dry-run: APIへの書き込みは行っていません）")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='rawエントリの2層・3層要約を生成')
    parser.add_argument('--dry-run', action='store_true', help='対象確認のみ（書き込みなし）')
    args = parser.parse_args()

    check_env()
    main(dry_run=args.dry_run)
