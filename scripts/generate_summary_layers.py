#!/usr/bin/env python3
"""
generate_summary_layers.py — rawエントリから2層（要約）・3層（シンボリック圧縮）・4層（キーワード）を生成する

サーバー内バッチ（main.py の _run_summary_batch）と同一仕様：
  - source_thread がある場合は会話全文（先頭30メッセージ・計3000字まで）をLLMに渡す
  - 2層・3層は body に追記、4層キーワードは keywords フィールドに保存
  - 2層・3層が生成済みで keywords だけ欠けているエントリには軽量プロンプトでキーワードのみ生成

必要な環境変数:
  MIO_API_TOKEN      mio-memory Bearer認証トークン
  MIO_SERVER_URL     サーバーURL（省略時: http://localhost:5002）
  FORCE_REPROCESS    true にすると summarized 済みエントリも再処理（省略時: false）

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
import re
import sys
import json
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse

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
LAYER4_MARKER  = '## 4層:'
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


# ── レイヤーヘルパー（main.py と同一仕様）─────────────────────────────
def extract_summary(body: str) -> str:
    """body から2層要約セクションのテキストを取り出す"""
    if not body:
        return ''
    i = body.find(SUMMARY_MARKER)
    if i == -1:
        return body[:300]
    seg = body[i + len(SUMMARY_MARKER):]
    j = seg.find('\n## ')
    if j != -1:
        seg = seg[:j]
    return seg.strip()


def parse_keywords_line(line: str) -> list:
    parts = [p.strip().strip('、,。 　') for p in re.split(r'[,、]', line or '')]
    return [p for p in parts if p][:8]


def split_layers_and_keywords(llm_text: str):
    """LLM出力を (bodyに保存する2層+3層部分, keywordsリスト) に分割する"""
    text = (llm_text or '').strip()
    i = text.find(LAYER4_MARKER)
    if i == -1:
        return text, []
    body_part = text[:i].rstrip()
    kw_lines = [l.strip() for l in text[i:].splitlines()[1:] if l.strip()]
    keywords = parse_keywords_line(kw_lines[0]) if kw_lines else []
    return body_part, keywords


def fetch_conv_text(source_thread: str) -> str:
    """会話全文を REST 経由で取得し、サーバー版と同じ形式に整形する（先頭30メッセージ・各300字）"""
    if not source_thread:
        return ''
    try:
        conv = api_get('/api/conversations/' + urllib.parse.quote(source_thread, safe=''))
    except Exception:
        return ''
    lines = []
    for m in conv.get('chat_messages', []):
        role    = m.get('sender') or m.get('role') or '?'
        content = m.get('content') or m.get('text') or ''
        text    = ''
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'text':
                    text += c.get('text', '')
        else:
            text = str(content)
        if text.strip():
            lines.append(f'[{role}] {text[:300]}')
    return '\n\n'.join(lines[:30])


# ── Claude API ────────────────────────────────────────────────────────
def generate_layers(client: anthropic.Anthropic, model: str, title: str, conv_text: str) -> str:
    if conv_text:
        prompt = (
            f'以下はClaude.aiの会話ログです。内容を読んで要約と圧縮表現を生成してください。\n\n'
            f'会話タイトル: {title}\n\n{conv_text[:3000]}\n\n'
            f'以下の形式で出力してください（他の説明文は不要）:\n\n'
            f'## 2層: 要約\n（会話の目的・内容・結論を2〜3文で。）\n\n'
            f'## 3層: シンボリック圧縮\n（15文字以内の超短縮キーワード。検索時の手がかりになる表現）\n\n'
            f'## 4層: キーワード\n（検索用キーワードを3〜5個、半角カンマ区切りで1行）'
        )
    else:
        prompt = (
            f'以下はClaude.aiの会話タイトルです。タイトルだけから推測できる範囲で要約と圧縮表現を生成してください。\n\n'
            f'会話タイトル: {title}\n\n'
            f'以下の形式で出力してください（他の説明文は不要）:\n\n'
            f'## 2層: 要約\n（会話の目的・内容・結論を2〜3文で推測。"〜についての会話" という形式でよい）\n\n'
            f'## 3層: シンボリック圧縮\n（15文字以内の超短縮キーワード。検索時の手がかりになる表現）\n\n'
            f'## 4層: キーワード\n（検索用キーワードを3〜5個、半角カンマ区切りで1行）'
        )
    msg = client.messages.create(
        model=model,
        max_tokens=400,
        messages=[{'role': 'user', 'content': prompt}]
    )
    return msg.content[0].text.strip()


def generate_keywords_only(client: anthropic.Anthropic, model: str, title: str, summary: str) -> list:
    prompt = (
        f'以下は会話の要約と圧縮表現です。検索に使うキーワードを3〜5個生成してください。\n\n'
        f'会話タイトル: {title}\n\n{summary}\n\n'
        f'出力形式（1行、半角カンマ区切り、説明文は不要）:\nキーワード1, キーワード2, キーワード3'
    )
    msg = client.messages.create(
        model=model,
        max_tokens=100,
        messages=[{'role': 'user', 'content': prompt}]
    )
    text = msg.content[0].text.strip()
    line = next((l.strip() for l in text.splitlines() if l.strip()), '')
    return parse_keywords_line(line)


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

    if FORCE_REPROCESS:
        targets = [e for e in index if not e.get('deleted') and (
            'raw' in (e.get('tags') or []) or 'summarized' in (e.get('tags') or []))]
    else:
        # 対象: raw（未要約・要約生成）＋ keywords 未生成エントリ（4層バックフィル）
        #   keywords 未生成には summarized 済み・memory_write 由来ユーザーエントリ両方が含まれる
        targets = [e for e in index if not e.get('deleted') and (
            'raw' in (e.get('tags') or []) or not e.get('keywords'))]
    print(f"対象エントリ: {len(targets)} 件 / 全体: {len(index)} 件\n")

    processed = skipped = errors = 0

    for i, idx in enumerate(targets, 1):
        entry_id = idx['id']
        title    = idx.get('title', '（無題）')

        try:
            entry = api_get(f'/api/memory/{urllib.parse.quote(entry_id, safe="")}')
        except Exception as e:
            print(f"[{i:>3}/{len(targets)}] ERROR  {entry_id}: {e}")
            errors += 1
            continue

        body = entry.get('body', '')
        has_layers = SUMMARY_MARKER in body and LAYER3_MARKER in body
        is_raw     = 'raw' in (entry.get('tags') or [])

        if not FORCE_REPROCESS and entry.get('keywords') and has_layers:
            print(f"[{i:>3}/{len(targets)}] SKIP   {title[:55]}")
            skipped += 1
            continue

        # キーワードのみ生成すればよいケース:
        #   has_layers（2層3層生成済み）→ 2層要約からキーワード生成
        #   raw でない本文エントリ（memory_write 由来）→ 本文からキーワード生成（本文・タグは変更しない）
        if not FORCE_REPROCESS and (has_layers or not is_raw):
            print(f"[{i:>3}/{len(targets)}] KW生成 {title[:55]}")
            if dry_run:
                processed += 1
                continue
            try:
                kw_src = extract_summary(body) if has_layers else body[:2000]
                keywords = generate_keywords_only(client, model, title, kw_src)
                api_patch(f'/api/memory/{urllib.parse.quote(entry_id, safe="")}', {'keywords': keywords})
                processed += 1
                time.sleep(RATE_LIMIT_SLEEP)
            except Exception as e:
                print(f"           ERROR: {e}")
                errors += 1
            continue

        if SUMMARY_MARKER in body:
            body = body[:body.index(SUMMARY_MARKER)].rstrip()

        print(f"[{i:>3}/{len(targets)}] 生成中 {title[:55]}")

        if dry_run:
            processed += 1
            continue

        try:
            conv_text = fetch_conv_text(entry.get('source_thread', ''))
            llm_out   = generate_layers(client, model, title, conv_text)
            layers, keywords = split_layers_and_keywords(llm_out)

            new_body = (body.strip() + '\n\n' + layers).strip() if body.strip() else layers
            tags = [t for t in (entry.get('tags') or []) if t != 'raw']
            if 'summarized' not in tags:
                tags.append('summarized')

            api_patch(f'/api/memory/{urllib.parse.quote(entry_id, safe="")}',
                      {'body': new_body, 'tags': tags, 'keywords': keywords})
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
        description='rawエントリの2層・3層・4層（キーワード）を生成',
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
