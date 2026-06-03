#!/usr/bin/env python3
"""
generate_summary_layers.py — rawエントリから2層（要約）・3層（シンボリック圧縮）を生成する

必要な環境変数:
  MIO_API_TOKEN      mio-memory Bearer認証トークン
  MIO_SERVER_URL     サーバーURL（省略時: http://localhost:5002）
  FORCE_REPROCESS    true にすると 2層あり・3層なしのエントリを再処理（省略時: false）

  anthropicバックエンド使用時:
    ANTHROPIC_API_KEY  Anthropic APIキー

  lmstudioバックエンド使用時:
    LM_STUDIO_HOST     LMStudioのホスト（省略時: 192.168.10.32）
    LM_STUDIO_PORT     LMStudioのポート（省略時: 1234）

実行例:
  python scripts/generate_summary_layers.py
  python scripts/generate_summary_layers.py --dry-run
  python scripts/generate_summary_layers.py --backend lmstudio --model qwen/qwen3.6-35b-a3b
  python scripts/generate_summary_layers.py --backend lmstudio --model google/gemma-4-26b-a4b
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

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
MIO_SERVER_URL    = os.environ.get('MIO_SERVER_URL', 'http://localhost:5002').rstrip('/')
LM_STUDIO_HOST    = os.environ.get('LM_STUDIO_HOST', '192.168.10.32')
LM_STUDIO_PORT    = os.environ.get('LM_STUDIO_PORT', '1234')

DEFAULT_MODEL_ANTHROPIC  = 'claude-haiku-4-5-20251001'
DEFAULT_MODEL_LMSTUDIO   = 'qwen/qwen3.6-35b-a3b'
RATE_LIMIT_SLEEP = 0.5

SUMMARY_MARKER = '## 2層: 要約'
LAYER3_MARKER  = '## 3層:'
FORCE_REPROCESS = os.environ.get('FORCE_REPROCESS', 'false').lower() == 'true'

MODEL_CANDIDATES = {
    'anthropic': ['claude-haiku-4-5-20251001'],
    'lmstudio':  ['qwen/qwen3.6-35b-a3b', 'google/gemma-4-26b-a4b', 'liquid/lfm2-24b-a2b'],
}


def check_env(backend: str):
    if not MIO_API_TOKEN:
        print("Error: 環境変数 MIO_API_TOKEN を設定してください")
        sys.exit(1)
    if backend == 'anthropic' and not ANTHROPIC_API_KEY:
        print("Error: 環境変数 ANTHROPIC_API_KEY を設定してください")
        sys.exit(1)


def make_client(backend: str) -> anthropic.Anthropic:
    if backend == 'lmstudio':
        return anthropic.Anthropic(
            base_url=f'http://{LM_STUDIO_HOST}:{LM_STUDIO_PORT}',
            api_key='lmstudio',
            timeout=300.0,
        )
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


# ── REST API ヘルパー ─────────────────────────────────────────────────
def _auth_headers():
    return {'Authorization': f'Bearer {MIO_API_TOKEN}'}

def _json_headers():
    return {'Authorization': f'Bearer {MIO_API_TOKEN}', 'Content-Type': 'application/json'}

def api_get(path):
    req = urllib.request.Request(MIO_SERVER_URL + path, headers=_auth_headers())
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def api_patch(path, data):
    body = json.dumps(data, ensure_ascii=False).encode()
    req  = urllib.request.Request(MIO_SERVER_URL + path, data=body, headers=_json_headers(), method='PATCH')
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


# ── Claude API ────────────────────────────────────────────────────────
def generate_layers(client: anthropic.Anthropic, model: str, title: str) -> str:
    prompt = f"""以下はClaude.aiの会話タイトルです。タイトルだけから推測できる範囲で要約と圧縮表現を生成してください。

会話タイトル: {title}

以下の形式で出力してください（他の説明文は不要）:

## 2層: 要約
（会話の目的・内容・結論を2〜3文で推測。"〜についての会話" という形式でよい）

## 3層: シンボリック圧縮
（15文字以内の超短縮キーワード。検索時の手がかりになる表現）"""

    msg = client.messages.create(
        model=model,
        max_tokens=400,
        messages=[{'role': 'user', 'content': prompt}]
    )
    return msg.content[0].text.strip()


# ── メイン処理 ────────────────────────────────────────────────────────
def main(backend: str, model: str, dry_run: bool):
    print(f"バックエンド: {backend}")
    if backend == 'lmstudio':
        print(f"LMStudio   : http://{LM_STUDIO_HOST}:{LM_STUDIO_PORT}")
    print(f"モデル     : {model}")
    print(f"サーバー   : {MIO_SERVER_URL}")
    print(f"dry-run    : {dry_run}")
    print(f"強制再処理 : {FORCE_REPROCESS}")
    print()

    client = make_client(backend)

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

        try:
            entry = api_get(f'/api/memory/{entry_id}')
        except Exception as e:
            print(f"[{i:>3}/{len(raw_entries)}] ERROR  {entry_id}: {e}")
            errors += 1
            continue

        body = entry.get('body', '')

        if SUMMARY_MARKER in body:
            if not FORCE_REPROCESS or LAYER3_MARKER in body:
                print(f"[{i:>3}/{len(raw_entries)}] SKIP   {title[:55]}")
                skipped += 1
                continue
            # FORCE_REPROCESS=true かつ 3層が欠けている → 2層以降を削除して再生成
            body = body[:body.index(SUMMARY_MARKER)].rstrip()
            print(f"[{i:>3}/{len(raw_entries)}] 再処理 {title[:55]}")

        print(f"[{i:>3}/{len(raw_entries)}] 生成中 {title[:55]}")

        if dry_run:
            processed += 1
            continue

        try:
            layers = generate_layers(client, model, title)

            new_body = (body.strip() + '\n\n' + layers).strip() if body.strip() else layers
            tags = [t for t in (entry.get('tags') or []) if t != 'raw']
            if 'summarized' not in tags:
                tags.append('summarized')

            api_patch(f'/api/memory/{entry_id}', {'body': new_body, 'tags': tags})
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
    parser = argparse.ArgumentParser(
        description='rawエントリの2層・3層要約を生成',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
モデル候補:
  anthropic: {', '.join(MODEL_CANDIDATES['anthropic'])}
  lmstudio : {', '.join(MODEL_CANDIDATES['lmstudio'])}
        """
    )
    parser.add_argument('--backend', choices=['anthropic', 'lmstudio'], default='anthropic',
                        help='使用するバックエンド (default: anthropic)')
    parser.add_argument('--model', default=None,
                        help='使用するモデル名 (省略時はバックエンドのデフォルト)')
    parser.add_argument('--dry-run', action='store_true',
                        help='対象確認のみ（書き込みなし）')
    args = parser.parse_args()

    if args.model is None:
        args.model = DEFAULT_MODEL_LMSTUDIO if args.backend == 'lmstudio' else DEFAULT_MODEL_ANTHROPIC

    check_env(args.backend)
    main(backend=args.backend, model=args.model, dry_run=args.dry_run)
