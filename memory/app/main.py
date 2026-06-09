"""
mio-memory v3.7  —  Streamable HTTP MCP transport
準拠仕様: MCP 2025-11-25 (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

変更履歴:
  v3.7 (2026-06-09) - 機能追加
    - inbox_check に include_read パラメータ追加
      include_read=true で既読メッセージも含む全件返却
      レスポンスに unread_count + messages[]{id, read, persistent, title, from, to} 追加
  v3.6 (2026-06-09) - 用語統一リファクタリング
    - MCPツール名変更: artifacts_save/read/list → CoreMem_save/read/list
    - REST エンドポイント変更: /api/artifacts → /api/coremem
    - 用語統一: ExtMemory(記憶KV) / UserCoreMemory(NASファイルストア) / LogStore(会話アーカイブ) / SysMemory(userMemories)
    - admin.html: Artifacts タブ → CoreMem に改名
    - logs.html U2: 右パネル artifacts タブ修正（空表示バグ修正含む）
    - setup.md: 固有情報をプレースホルダーに置換
  v3.5 (2026-06-05) - 機能追加
    - 全MCPツールレスポンスに server_time（JST）追加
    - inbox persistent（常駐型）: inbox_post に persistent=true 追加
    - CoreMem_read: conv_artifacts へのフォールバック（孤立ファイル対応）
    - UserCoreMemory ↔ conversation 双方向リンク: source_conversation_uuid フィールド
    - インポート上書きモード: admin.html に上書きオプション追加
  v3.4 (2026-06-04) - 機能追加
    - memory_search に limit/offset/has_more 追加（コンテキスト削減）
    - インボックスシステム新設（/data/inbox/）
      inbox_check / inbox_read / inbox_post MCPツール追加
      GET/POST /api/inbox, GET /api/inbox/<id>, PATCH /api/inbox/<id>/read
    - MCPツール総数：15本
  v3.3 (2026-06-04) - 機能追加
    - admin.html Filesタブ：拡張子フィルタ・日付範囲・ソートヘッダー・Prism.jsシンタックスハイライト・HTMLプレビュー（iframe）
    - admin.html：スクロール制御修正（各タブ内でスクロール完結）・↑TOPボタン追加
    - admin.html：markedリンクをtarget="_blank"で開く設定
    - ZIPインポート後にANTHROPIC_API_KEY設定済みなら要約バッチを自動起動
    - GET /api/batch/status・POST /api/batch/start：バッチ進捗API追加
    - admin.html Importタブ：バッチ進捗パネル・LMStudio手動実行ボタン
  v3.2 (2026-06-03) - 機能追加
    - memory_share MCPツール：記憶エントリの24時間共有URL生成
    - POST /api/memory/share/<id>：memory_share用エンドポイント新設
    - admin.html Memoryタブ：キーワード検索（300msデバウンス）追加
    - MCPツール総数：12本（memory×5 + memory_share×1 + artifacts×3 + conversations×2 + conversation_read×1）
  v3.1 (2026-06-02) - 機能追加
    - admin.html：Memory/Artifacts/Importの管理UI
    - MCP initialize instructions：core.md自動読み込み指示
    - POST /import 拡張：memories.json・projects/対応
    - GET /api/import-status：最終ZIPインポート記録
  v3.0 (2026-06-01) - 機能拡張
    - memory_upsert ツール追加（固定IDで上書き）
    - UserCoreMemory管理追加（CoreMem_save / CoreMem_read / CoreMem_list）
    - POST /import：Claude会話ログZIPインポート（重複スキップ）
  v2.1 (2026-05-31) - 仕様に合わせた修正
    - notification応答を204→202に（仕様MUST）
    - initializeレスポンスでMcp-Session-Idを発行
    - Origin headerバリデーション追加（MIO_ALLOWED_ORIGINS環境変数）
    - GETにAccept: text/event-streamがない場合は405を返す
    - protocolVersionをクライアントから引き継ぐ（2025-03-26/2025-11-25対応）
  v2.0 (2026-05-30) - Streamable HTTP実装、OAuthログ追加
  v1.1 (2026-05-22) - OAuth 2.1 + Dynamic Client Registration追加
  v1.0 (2026-05-21) - 初期実装（Flask + SSE MCP）

ログレベル（環境変数 MIO_LOG_LEVEL）:
  debug  — MCPメッセージ全内容、OAuthフロー詳細
  info   — 接続/切断、エラー、ツール呼び出し名のみ（デフォルト）
  off    — ログなし（本番最小）

Originバリデーション（環境変数 MIO_ALLOWED_ORIGINS）:
  例: MIO_ALLOWED_ORIGINS=https://claude.ai
  空の場合はOrigin検証をスキップ（開発用curl等も通る）
"""

import os
import json
import glob
import shutil
import hashlib
import hmac
import base64
import secrets
import time
import uuid
import zipfile
import tempfile
import logging
import threading
import sys
from datetime import datetime, timezone, timedelta
from functools import wraps
from flask import Flask, request, jsonify, abort, Response, send_from_directory

app = Flask(__name__)

DATA_DIR      = '/data/memory'
INDEX_FILE    = '/data/index.json'
OPLOG_FILE    = '/data/oplog.json'
ARTIFACTS_DIR = '/data/artifacts'
IMPORT_LOG         = '/data/imported_uuids.json'
IMPORT_STATUS_FILE = '/data/.import_status.json'
SHARE_TOKENS_FILE  = '/data/share_tokens.json'
CONVERSATIONS_DIR  = '/data/conversations'
CONV_ARTIFACTS_DIR = '/data/conv_artifacts'
INBOX_DIR          = '/data/inbox'
ARTIFACTS_META_FILE = '/data/artifacts/_meta.json'
API_TOKEN     = os.environ.get('MIO_API_TOKEN', 'changeme')
BASE_URL      = os.environ.get('MIO_BASE_URL', 'http://localhost:5002')

# ── バッチ要約生成状態 ────────────────────────────────────────────────
_batch_status = {
    'running': False, 'total': 0, 'processed': 0,
    'errors': 0, 'skipped': 0, 'started_at': None,
    'finished_at': None, 'backend': None,
}
# Origin許可リスト（カンマ区切り）。空なら検証スキップ（開発用curl等も通る）
_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get('MIO_ALLOWED_ORIGINS', '').split(',') if o.strip()]
JST           = timezone(timedelta(hours=9))

# ── ロギング設定 ──────────────────────────────────────────────────────
_LOG_LEVEL = os.environ.get('MIO_LOG_LEVEL', 'info').lower()

logging.basicConfig(
    stream=sys.stdout,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    level=logging.DEBUG if _LOG_LEVEL == 'debug' else
          logging.INFO  if _LOG_LEVEL == 'info'  else
          logging.CRITICAL  # off
)
log = logging.getLogger('mio')

# Flaskの標準アクセスログを MIO_LOG_LEVEL に合わせて制御
if _LOG_LEVEL == 'off':
    logging.getLogger('werkzeug').setLevel(logging.CRITICAL)
elif _LOG_LEVEL == 'info':
    logging.getLogger('werkzeug').setLevel(logging.WARNING)  # 200は出さない
else:
    logging.getLogger('werkzeug').setLevel(logging.INFO)

def _log_debug(msg):
    if _LOG_LEVEL == 'debug':
        log.debug(msg)

def _log_info(msg):
    if _LOG_LEVEL in ('debug', 'info'):
        log.info(msg)

def _log_error(msg):
    if _LOG_LEVEL != 'off':
        log.error(msg)

def _check_origin(req) -> bool:
    """DNS rebinding攻撃対策。MIO_ALLOWED_ORIGINSが未設定なら常にTrue（開発モード）"""
    if not _ALLOWED_ORIGINS:
        return True
    origin = req.headers.get('Origin', '')
    if not origin:
        return True  # curlなどOriginなしは通す
    allowed = origin in _ALLOWED_ORIGINS
    if not allowed:
        _log_error(f'Origin rejected: {origin}')
    return allowed

# ── OAuth ストア（/data/oauth_store.json に永続化）───────────────────
OAUTH_STORE = '/data/oauth_store.json'

def _load_oauth_store():
    if os.path.exists(OAUTH_STORE):
        with open(OAUTH_STORE) as f:
            d = json.load(f)
            return d.get('clients', {}), d.get('tokens', {})
    return {}, {}

def _save_oauth_store():
    with open(OAUTH_STORE, 'w') as f:
        json.dump({'clients': _oauth_clients, 'tokens': _oauth_tokens},
                  f, ensure_ascii=False)

_oauth_clients, _oauth_tokens = _load_oauth_store()
_oauth_codes = {}  # 認証コードは短命（10分失効）なので永続化不要

# ── ユーティリティ ────────────────────────────────────────────────────

def now_jst():
    return datetime.now(JST).isoformat()

def _inject_server_time(result):
    """全MCPツールレスポンスにサーバー時刻を付与する"""
    st = now_jst()
    if isinstance(result, dict):
        return {**result, 'server_time': st}
    elif isinstance(result, list):
        return {'data': result, 'server_time': st}
    elif isinstance(result, str):
        return {'text': result, 'server_time': st}
    return result

def _load_artifacts_meta() -> dict:
    if os.path.exists(ARTIFACTS_META_FILE):
        with open(ARTIFACTS_META_FILE, encoding='utf-8') as f:
            return json.load(f)
    return {}

def _save_artifacts_meta(meta: dict):
    os.makedirs(ARTIFACTS_DIR, exist_ok=True)
    with open(ARTIFACTS_META_FILE, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

def _verify_token(token: str) -> bool:
    if token == API_TOKEN:
        _log_debug('auth: API_TOKEN match')
        return True
    info = _oauth_tokens.get(token)
    if info and info['exp'] > time.time():
        _log_debug(f'auth: OAuth token valid (client={info["client_id"][:8]}...)')
        return True
    if token:
        _log_error(f'auth: token rejected ({token[:8]}...)')
    return False

def _extract_bearer(req) -> str:
    auth = req.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        return auth[7:]
    return req.args.get('token', '')

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = _extract_bearer(request)
        if not token and request.view_args:
            token = request.view_args.get('path_token', '')
        if not _verify_token(token):
            abort(401)
        return f(*args, **kwargs)
    return decorated

# ── 記憶操作 ──────────────────────────────────────────────────────────

def load_all_entries():
    entries = []
    for path in glob.glob(f'{DATA_DIR}/*.json'):
        with open(path) as f:
            entries.append(json.load(f))
    return sorted(entries, key=lambda x: x.get('created_at', ''), reverse=True)

def rebuild_index():
    entries = load_all_entries()
    index = [{
        'id': e['id'], 'title': e.get('title', ''),
        'tags': e.get('tags', []), 'created_at': e.get('created_at', ''),
        'importance': e.get('importance', 'normal'),
        'deleted': e.get('deleted', False)
    } for e in entries if not e.get('deleted')]
    with open(INDEX_FILE, 'w') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

def append_oplog(operation, entry_id, before, after):
    oplog = []
    if os.path.exists(OPLOG_FILE):
        with open(OPLOG_FILE) as f:
            oplog = json.load(f)
    oplog.append({'timestamp': now_jst(), 'operation': operation,
                  'entry_id': entry_id, 'author': 'mio',
                  'diff': {'before': before, 'after': after}})
    with open(OPLOG_FILE, 'w') as f:
        json.dump(oplog, f, ensure_ascii=False, indent=2)

# ── アーティファクト操作 ──────────────────────────────────────────────

def _name_slug(name: str) -> str:
    return name.replace('.', '_').replace(' ', '_')

def _artifacts_save(name: str, content: str, source_conversation_uuid: str = None) -> dict:
    name_slug = _name_slug(name)
    ext = os.path.splitext(name)[1]  # '.md', '.sh', etc.

    versions_dir = os.path.join(ARTIFACTS_DIR, 'versions', name_slug)
    os.makedirs(versions_dir, exist_ok=True)
    os.makedirs(ARTIFACTS_DIR, exist_ok=True)

    existing = sorted(glob.glob(os.path.join(versions_dir, f'*{ext}')))
    next_num = int(os.path.splitext(os.path.basename(existing[-1]))[0]) + 1 if existing else 1
    version_filename = f'{next_num:03d}{ext}'
    version_path = os.path.join(versions_dir, version_filename)

    with open(version_path, 'w', encoding='utf-8') as f:
        f.write(content)

    # トップレベルシンボリックリンクを最新バージョンに張り替え
    symlink_path = os.path.join(ARTIFACTS_DIR, name)
    rel_target = os.path.join('versions', name_slug, version_filename)
    if os.path.islink(symlink_path) or os.path.exists(symlink_path):
        os.remove(symlink_path)
    os.symlink(rel_target, symlink_path)

    # source_conversation_uuid をメタデータに保存
    if source_conversation_uuid:
        meta = _load_artifacts_meta()
        meta[name] = {**meta.get(name, {}), 'source_conversation_uuid': source_conversation_uuid}
        _save_artifacts_meta(meta)

    _log_info(f'CoreMem_save: {name} v{next_num:03d}')
    result = {'name': name, 'version': next_num, 'version_str': f'{next_num:03d}'}
    if source_conversation_uuid:
        result['source_conversation_uuid'] = source_conversation_uuid
    return result

def _artifacts_read(name: str, version=None) -> dict:
    meta = _load_artifacts_meta()
    entry_meta = meta.get(name, {})

    if version is None:
        path = os.path.join(ARTIFACTS_DIR, name)
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                result = {'name': name, 'version': None, 'content': f.read()}
                if entry_meta.get('source_conversation_uuid'):
                    result['source_conversation_uuid'] = entry_meta['source_conversation_uuid']
                return result
        # conv_artifacts へのフォールバック（孤立ファイル対応）
        if os.path.exists(CONV_ARTIFACTS_DIR):
            for conv_uuid in sorted(os.listdir(CONV_ARTIFACTS_DIR)):
                conv_path = os.path.join(CONV_ARTIFACTS_DIR, conv_uuid, name)
                if os.path.exists(conv_path):
                    with open(conv_path, 'r', encoding='utf-8') as f:
                        return {'name': name, 'version': None, 'content': f.read(),
                                'source_conv_uuid': conv_uuid, 'source': 'conv_artifact'}
        return {'error': 'not found'}
    else:
        name_slug = _name_slug(name)
        ext = os.path.splitext(name)[1]
        path = os.path.join(ARTIFACTS_DIR, 'versions', name_slug, f'{int(version):03d}{ext}')
        if not os.path.exists(path):
            return {'error': 'not found'}
        with open(path, 'r', encoding='utf-8') as f:
            result = {'name': name, 'version': int(version), 'content': f.read()}
            if entry_meta.get('source_conversation_uuid'):
                result['source_conversation_uuid'] = entry_meta['source_conversation_uuid']
            return result

def _artifacts_list() -> list:
    if not os.path.exists(ARTIFACTS_DIR):
        return []
    meta = _load_artifacts_meta()
    items = []
    for entry in sorted(os.listdir(ARTIFACTS_DIR)):
        full_path = os.path.join(ARTIFACTS_DIR, entry)
        if not os.path.islink(full_path):
            continue
        # 壊れたシンボリックリンクをスキップ
        if not os.path.exists(full_path):
            continue
        target = os.readlink(full_path)
        version_str = os.path.splitext(os.path.basename(target))[0]
        try:
            version = int(version_str)
        except ValueError:
            version = None
        stat = os.stat(full_path)
        item = {
            'name': entry,
            'version': version,
            'updated_at': datetime.fromtimestamp(stat.st_mtime, tz=JST).isoformat()
        }
        if meta.get(entry, {}).get('source_conversation_uuid'):
            item['source_conversation_uuid'] = meta[entry]['source_conversation_uuid']
        items.append(item)
    return items

# ── ZIPインポート ─────────────────────────────────────────────────────

def _load_imported_uuids() -> set:
    if os.path.exists(IMPORT_LOG):
        with open(IMPORT_LOG) as f:
            return set(json.load(f))
    return set()

def _save_imported_uuids(uuids: set):
    with open(IMPORT_LOG, 'w') as f:
        json.dump(list(uuids), f, ensure_ascii=False)

def _write_import_status(filename: str):
    with open(IMPORT_STATUS_FILE, 'w', encoding='utf-8') as f:
        json.dump({
            'last_filename': filename,
            'imported_at': datetime.now(JST).isoformat()
        }, f, ensure_ascii=False)

# ── インポートステータス ──────────────────────────────────────────────

@app.route('/api/import-status', methods=['GET'])
@require_auth
def api_import_status():
    if os.path.exists(IMPORT_STATUS_FILE):
        with open(IMPORT_STATUS_FILE, encoding='utf-8') as f:
            return jsonify(json.load(f))
    return jsonify({'last_filename': None, 'imported_at': None})

# ── 会話ログ REST API ─────────────────────────────────────────────────

@app.route('/api/conversations/')
@require_auth
def api_conversations_search():
    q      = request.args.get('q', '').lower()
    from_  = request.args.get('from', '')
    to_    = request.args.get('to', '')
    limit  = min(int(request.args.get('limit', 20)), 200)
    index  = _load_conv_index()
    if q:
        index = [e for e in index if q in (e.get('title', '') + ' ' + e.get('uuid', '')).lower()]
    if from_:
        index = [e for e in index if (e.get('updated_at') or e.get('created_at', '')) >= from_]
    if to_:
        index = [e for e in index if (e.get('updated_at') or e.get('created_at', '')) <= to_ + 'T23:59:59']
    index.sort(key=lambda e: e.get('updated_at') or e.get('created_at', ''), reverse=True)
    return jsonify(index[:limit])

@app.route('/api/conversations/<uuid>')
@require_auth
def api_conversations_get(uuid):
    fpath = os.path.join(CONVERSATIONS_DIR, f'{uuid}.json')
    if not os.path.exists(fpath):
        abort(404)
    with open(fpath, encoding='utf-8') as f:
        return jsonify(json.load(f))

@app.route('/api/conversations/share/<uuid>', methods=['POST'])
@require_auth
def api_conversations_share(uuid):
    fpath = os.path.join(CONVERSATIONS_DIR, f'{uuid}.json')
    if not os.path.exists(fpath):
        abort(404)
    expires_in = int((request.get_json() or {}).get('expires_in', 86400))
    token      = secrets.token_urlsafe(24)
    expires_at = (datetime.now(tz=JST) + timedelta(seconds=expires_in)).isoformat()
    tokens     = _load_share_tokens()
    tokens[token] = {'conv_uuid': uuid, 'expires_at': expires_at}
    _save_share_tokens(tokens)
    url = f'{BASE_URL}/logs.html?token={token}'
    return jsonify({'token': token, 'url': url})

@app.route('/api/conversations/view')
def api_conversations_view():
    token  = request.args.get('token', '')
    tokens = _load_share_tokens()
    if token not in tokens:
        abort(404)
    info = tokens[token]
    if 'conv_uuid' not in info:
        abort(404)
    expires_at = datetime.fromisoformat(info['expires_at'])
    if datetime.now(tz=JST) > expires_at:
        abort(410)
    fpath = os.path.join(CONVERSATIONS_DIR, f'{info["conv_uuid"]}.json')
    if not os.path.exists(fpath):
        abort(404)
    with open(fpath, encoding='utf-8') as f:
        return jsonify(json.load(f))

# ── 管理画面 ──────────────────────────────────────────────────────────

@app.route('/admin.html')
def admin_html():
    return send_from_directory(os.path.dirname(__file__), 'admin.html')

@app.route('/logs.html')
def logs_html():
    return send_from_directory(os.path.dirname(__file__), 'logs.html')

# ── ヘルス ────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'time': now_jst(), 'version': '3.6',
                    'mcp_tool_count': len(_MCP_TOOLS),
                    'mcp_tools': [t['name'] for t in _MCP_TOOLS]})

# ── 記憶 REST API ─────────────────────────────────────────────────────

@app.route('/api/memory/index')
@require_auth
def get_index():
    if os.path.exists(INDEX_FILE):
        with open(INDEX_FILE) as f:
            return jsonify(json.load(f))
    return jsonify([])

@app.route('/api/memory/search')
@require_auth
def search():
    q      = request.args.get('q', '').lower()
    limit  = int(request.args.get('limit', 0))   # 0 = no limit
    offset = int(request.args.get('offset', 0))
    if not q:
        return jsonify([])
    results = []
    for entry in load_all_entries():
        if entry.get('deleted'):
            continue
        text = (entry.get('title', '') + entry.get('body', '') +
                ' '.join(entry.get('tags', []))).lower()
        if q in text:
            results.append(entry)
    if offset:
        results = results[offset:]
    if limit:
        results = results[:limit]
    return jsonify(results)

@app.route('/api/memory/tags')
@require_auth
def get_tags():
    counts = {}
    for entry in load_all_entries():
        if entry.get('deleted'):
            continue
        for tag in entry.get('tags', []):
            counts[tag] = counts.get(tag, 0) + 1
    return jsonify(counts)

@app.route('/api/memory/<entry_id>')
@require_auth
def get_entry(entry_id):
    path = f'{DATA_DIR}/{entry_id}.json'
    if not os.path.exists(path):
        abort(404)
    with open(path) as f:
        return jsonify(json.load(f))

@app.route('/api/oplog')
@require_auth
def get_oplog():
    if os.path.exists(OPLOG_FILE):
        with open(OPLOG_FILE) as f:
            return jsonify(json.load(f))
    return jsonify([])

@app.route('/api/memory', methods=['POST'])
@require_auth
def create_entry():
    data = request.get_json()
    if not data or not data.get('title'):
        abort(400)
    ts = datetime.now(JST).strftime('%Y%m%d_%H%M%S')
    tag_slug = data.get('tags', [''])[0].replace(' ', '_')[:20] if data.get('tags') else 'note'
    entry_id = f'{ts}_{tag_slug}'
    entry = {
        'id': entry_id, 'created_at': now_jst(), 'updated_at': now_jst(),
        'title': data.get('title', ''), 'body': data.get('body', ''),
        'tags': data.get('tags', []), 'source_thread': data.get('source_thread', ''),
        'importance': data.get('importance', 'normal'), 'author': 'mio', 'deleted': False
    }
    with open(f'{DATA_DIR}/{entry_id}.json', 'w') as f:
        json.dump(entry, f, ensure_ascii=False, indent=2)
    append_oplog('create', entry_id, None, entry)
    rebuild_index()
    return jsonify(entry), 201

@app.route('/api/memory/<entry_id>', methods=['PATCH'])
@require_auth
def update_entry(entry_id):
    path = f'{DATA_DIR}/{entry_id}.json'
    if not os.path.exists(path):
        abort(404)
    with open(path) as f:
        entry = json.load(f)
    before = dict(entry)
    data = request.get_json()
    for key in ('title', 'body', 'tags', 'source_thread', 'importance'):
        if key in data:
            entry[key] = data[key]
    entry['updated_at'] = now_jst()
    with open(path, 'w') as f:
        json.dump(entry, f, ensure_ascii=False, indent=2)
    append_oplog('update', entry_id, before, entry)
    rebuild_index()
    return jsonify(entry)

@app.route('/api/memory/<entry_id>', methods=['DELETE'])
@require_auth
def delete_entry(entry_id):
    path = f'{DATA_DIR}/{entry_id}.json'
    if not os.path.exists(path):
        abort(404)
    with open(path) as f:
        entry = json.load(f)
    before = dict(entry)
    entry['deleted'] = True
    entry['updated_at'] = now_jst()
    with open(path, 'w') as f:
        json.dump(entry, f, ensure_ascii=False, indent=2)
    append_oplog('delete', entry_id, before, entry)
    rebuild_index()
    return jsonify({'status': 'deleted', 'id': entry_id})

# URLパス埋め込みトークン（後方互換）
@app.route('/api/<path_token>/memory/index')
@require_auth
def get_index_path(path_token): return get_index()

@app.route('/api/<path_token>/memory/search')
@require_auth
def search_path(path_token): return search()

@app.route('/api/<path_token>/memory/<entry_id>', methods=['GET'])
@require_auth
def get_entry_path(path_token, entry_id): return get_entry(entry_id)

@app.route('/api/<path_token>/memory', methods=['POST'])
@require_auth
def create_entry_path(path_token): return create_entry()

# ── UserCoreMemory REST API ───────────────────────────────────────────

@app.route('/api/coremem')
@require_auth
def api_coremem_list():
    return jsonify(_artifacts_list())

@app.route('/api/coremem/<path:name>', methods=['GET'])
@require_auth
def api_coremem_read(name):
    version = request.args.get('version', None)
    if version is not None:
        version = int(version)
    result = _artifacts_read(name, version)
    if 'error' in result:
        abort(404)
    return jsonify(result)

@app.route('/api/coremem/<path:name>', methods=['POST'])
@require_auth
def api_coremem_save(name):
    data = request.get_json()
    if not data or 'content' not in data:
        abort(400)
    result = _artifacts_save(name, data['content'])
    return jsonify(result), 201

@app.route('/api/coremem/<path:name>', methods=['DELETE'])
@require_auth
def api_coremem_delete(name):
    symlink_path = os.path.join(ARTIFACTS_DIR, name)
    if not os.path.islink(symlink_path) and not os.path.exists(symlink_path):
        abort(404)
    if os.path.islink(symlink_path) or os.path.exists(symlink_path):
        os.remove(symlink_path)
    name_slug = _name_slug(name)
    versions_dir = os.path.join(ARTIFACTS_DIR, 'versions', name_slug)
    if os.path.isdir(versions_dir):
        shutil.rmtree(versions_dir)
    _log_info(f'CoreMem_delete: {name}')
    return jsonify({'deleted': name})

# ── シェアトークン ────────────────────────────────────────────────────

def _load_share_tokens():
    if os.path.exists(SHARE_TOKENS_FILE):
        with open(SHARE_TOKENS_FILE) as f:
            return json.load(f)
    return {}

def _save_share_tokens(tokens):
    with open(SHARE_TOKENS_FILE, 'w') as f:
        json.dump(tokens, f, ensure_ascii=False, indent=2)

@app.route('/api/share-token', methods=['POST'])
@require_auth
def create_share_token():
    data = request.get_json()
    if not data or 'entry_id' not in data:
        abort(400)
    entry_id   = data['entry_id']
    expires_in = int(data.get('expires_in', 86400))
    path = f'{DATA_DIR}/{entry_id}.json'
    if not os.path.exists(path):
        abort(404)
    token      = secrets.token_urlsafe(24)
    expires_at = (datetime.now(tz=JST) + timedelta(seconds=expires_in)).isoformat()
    tokens     = _load_share_tokens()
    tokens[token] = {'entry_id': entry_id, 'expires_at': expires_at}
    _save_share_tokens(tokens)
    url = f'{BASE_URL}/admin.html?id={entry_id}&token={token}'
    return jsonify({'token': token, 'url': url})

@app.route('/api/memory/share/<entry_id>', methods=['POST'])
@require_auth
def api_memory_share(entry_id):
    path = f'{DATA_DIR}/{entry_id}.json'
    if not os.path.exists(path):
        abort(404)
    expires_in = int((request.get_json() or {}).get('expires_in', 86400))
    token      = secrets.token_urlsafe(24)
    expires_at = (datetime.now(tz=JST) + timedelta(seconds=expires_in)).isoformat()
    tokens     = _load_share_tokens()
    tokens[token] = {'entry_id': entry_id, 'expires_at': expires_at}
    _save_share_tokens(tokens)
    url = f'{BASE_URL}/admin.html?token={token}&id={entry_id}'
    return jsonify({'token': token, 'url': url, 'expires_at': expires_at})

@app.route('/api/share/<token>', methods=['GET'])
def get_shared_entry(token):
    tokens = _load_share_tokens()
    if token not in tokens:
        abort(404)
    info       = tokens[token]
    expires_at = datetime.fromisoformat(info['expires_at'])
    if datetime.now(tz=JST) > expires_at:
        abort(410)
    entry_id = info['entry_id']
    path = f'{DATA_DIR}/{entry_id}.json'
    if not os.path.exists(path):
        abort(404)
    with open(path) as f:
        entry = json.load(f)
    return jsonify(entry)

# ── インボックス ──────────────────────────────────────────────────────

def _inbox_path(msg_id):
    return os.path.join(INBOX_DIR, f'{msg_id}.json')

def _load_inbox_messages(to=None, unread_only=False):
    os.makedirs(INBOX_DIR, exist_ok=True)
    msgs = []
    for fname in sorted(os.listdir(INBOX_DIR)):
        if not fname.endswith('.json'):
            continue
        with open(os.path.join(INBOX_DIR, fname), encoding='utf-8') as f:
            msg = json.load(f)
        if to and msg.get('to') != to:
            continue
        # persistent メッセージは常に含める（既読でもunread_onlyで表示）
        if unread_only and msg.get('read') and not msg.get('persistent'):
            continue
        msgs.append(msg)
    return msgs

def _post_inbox_message(to, title, body, from_='code', persistent=False):
    os.makedirs(INBOX_DIR, exist_ok=True)
    now   = now_jst()
    msg_id = f'inbox_{now.replace(":", "").replace("-", "").replace("T", "_")[:15]}_{secrets.token_hex(4)}'
    msg = {"id": msg_id, "to": to, "from": from_, "title": title, "body": body,
           "created_at": now, "read": False, "persistent": persistent}
    with open(_inbox_path(msg_id), 'w', encoding='utf-8') as f:
        json.dump(msg, f, ensure_ascii=False, indent=2)
    return msg

def _mark_inbox_read(msg_id):
    path = _inbox_path(msg_id)
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        msg = json.load(f)
    # persistent メッセージは既読にしない
    if not msg.get('persistent'):
        msg['read'] = True
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(msg, f, ensure_ascii=False, indent=2)
    return msg

@app.route('/api/inbox', methods=['GET'])
@require_auth
def api_inbox_list():
    to          = request.args.get('to')
    full        = request.args.get('full', 'false').lower() == 'true'
    unread_only = request.args.get('status') == 'new'
    msgs = _load_inbox_messages(to=to, unread_only=unread_only)
    if full:
        return jsonify(msgs)
    return jsonify({"count": len(msgs), "ids": [m['id'] for m in msgs]})

@app.route('/api/inbox/<msg_id>', methods=['GET'])
@require_auth
def api_inbox_get(msg_id):
    path = _inbox_path(msg_id)
    if not os.path.exists(path):
        abort(404)
    with open(path, encoding='utf-8') as f:
        return jsonify(json.load(f))

@app.route('/api/inbox', methods=['POST'])
@require_auth
def api_inbox_post():
    data = request.get_json() or {}
    to    = data.get('to', '')
    title = data.get('title', '')
    body  = data.get('body', '')
    if not to or not title:
        return jsonify({"error": "to and title are required"}), 400
    msg = _post_inbox_message(to=to, title=title, body=body,
                              from_=data.get('from', 'code'),
                              persistent=bool(data.get('persistent', False)))
    return jsonify(msg), 201

@app.route('/api/inbox/<msg_id>/read', methods=['PATCH'])
@require_auth
def api_inbox_mark_read(msg_id):
    msg = _mark_inbox_read(msg_id)
    if msg is None:
        abort(404)
    return jsonify(msg)

# ── 会話内アーティファクト抽出 ───────────────────────────────────────

_ARTIFACT_EXT_MAP = {
    'python': '.py', 'javascript': '.js', 'typescript': '.ts',
    'html': '.html', 'css': '.css', 'bash': '.sh', 'shell': '.sh',
    'json': '.json', 'markdown': '.md', '': '.txt',
}

def _conv_artifacts_index_path():
    return os.path.join(CONV_ARTIFACTS_DIR, '_index.json')

def _load_conv_artifacts_index():
    p = _conv_artifacts_index_path()
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return []

def extract_artifacts(conversations, overwrite=False):
    """conversations の全会話から tool_use アーティファクトを抽出して保存する"""
    os.makedirs(CONV_ARTIFACTS_DIR, exist_ok=True)
    index    = _load_conv_artifacts_index()
    existing = {(e['conv_uuid'], e['filename']) for e in index}
    extracted = 0

    for conv in conversations:
        conv_uuid = conv.get('uuid', '')
        conv_name = conv.get('name') or conv.get('title') or conv_uuid[:8]
        conv_date = (conv.get('updated_at') or conv.get('created_at') or '')[:10]

        for msg in conv.get('chat_messages', []):
            content = msg.get('content', [])
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get('type') != 'tool_use':
                    continue

                name         = block.get('name', '')
                inp          = block.get('input', {})
                file_content = None
                filename     = None

                if name == 'create_file':
                    path = inp.get('path', '')
                    file_content = inp.get('file_text', '')
                    filename = os.path.basename(path)
                    # /home/claude/ 以下の中間ファイルは除外（outputs/ は含める）
                    if '/home/claude/' in path and '/mnt/user-data/outputs/' not in path:
                        continue

                elif name == 'artifacts':
                    file_content = inp.get('content', '')
                    artifact_id  = inp.get('id', 'unknown')
                    lang = inp.get('language', '')
                    mime = inp.get('type', '')
                    ext  = '.jsx' if 'react' in mime else _ARTIFACT_EXT_MAP.get(lang, '.txt')
                    filename = f'{artifact_id}{ext}'

                if not filename or not file_content:
                    continue
                if not overwrite and (conv_uuid, filename) in existing:
                    continue

                dest_dir = os.path.join(CONV_ARTIFACTS_DIR, conv_uuid)
                os.makedirs(dest_dir, exist_ok=True)
                with open(os.path.join(dest_dir, filename), 'w', encoding='utf-8') as f:
                    f.write(file_content)

                entry = {
                    'conv_uuid': conv_uuid,
                    'conv_name': conv_name,
                    'conv_date': conv_date,
                    'filename':  filename,
                    'size':      len(file_content),
                    'path':      f'{conv_uuid}/{filename}',
                }
                index.append(entry)
                existing.add((conv_uuid, filename))
                extracted += 1

    if extracted > 0:
        with open(_conv_artifacts_index_path(), 'w', encoding='utf-8') as f:
            json.dump(index, f, ensure_ascii=False, indent=2)

    return extracted

# ── 会話ログ REST API ─────────────────────────────────────────────────

@app.route('/api/conv-artifacts')
@require_auth
def api_conv_artifacts_list():
    q     = request.args.get('q', '').lower()
    index = _load_conv_artifacts_index()
    if q:
        index = [e for e in index if q in (e.get('filename','') + ' ' + e.get('conv_name','')).lower()]
    return jsonify(index)

@app.route('/api/conv-artifacts/<conv_uuid>/<path:filename>')
@require_auth
def api_conv_artifacts_get(conv_uuid, filename):
    fpath = os.path.join(CONV_ARTIFACTS_DIR, conv_uuid, filename)
    if not os.path.exists(fpath):
        abort(404)
    with open(fpath, encoding='utf-8') as f:
        content = f.read()
    return jsonify({'conv_uuid': conv_uuid, 'filename': filename, 'content': content})

# ── 会話ログ保存ヘルパー ──────────────────────────────────────────────

def _conv_index_path():
    return os.path.join(CONVERSATIONS_DIR, '_index.json')

def _load_conv_index():
    p = _conv_index_path()
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return []

def _save_conv_index(index):
    os.makedirs(CONVERSATIONS_DIR, exist_ok=True)
    with open(_conv_index_path(), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

def _save_conversations(conversations):
    """conversations.jsonの各会話を個別ファイルに保存し、インデックスを更新する"""
    os.makedirs(CONVERSATIONS_DIR, exist_ok=True)
    index = _load_conv_index()
    existing_uuids = {e['uuid'] for e in index}
    saved = 0
    for conv in conversations:
        uid = conv.get('uuid') or conv.get('id', '')
        if not uid:
            continue
        fpath = os.path.join(CONVERSATIONS_DIR, f'{uid}.json')
        with open(fpath, 'w', encoding='utf-8') as f:
            json.dump(conv, f, ensure_ascii=False, indent=2)
        msg_count = len(conv.get('chat_messages') or [])
        meta = {
            'uuid':          uid,
            'title':         conv.get('name') or conv.get('title') or uid[:8],
            'created_at':    conv.get('created_at', ''),
            'updated_at':    conv.get('updated_at', conv.get('created_at', '')),
            'message_count': msg_count,
        }
        if uid in existing_uuids:
            index = [m if m['uuid'] != uid else meta for m in index]
        else:
            index.append(meta)
            existing_uuids.add(uid)
            saved += 1
    _save_conv_index(index)
    return saved

# ── ZIP インポート ─────────────────────────────────────────────────────

@app.route('/import', methods=['POST'])
@require_auth
def import_zip():
    if 'file' not in request.files:
        abort(400)
    f = request.files['file']
    if not f.filename.lower().endswith('.zip'):
        return jsonify({'error': 'zip file required'}), 400

    overwrite = request.form.get('overwrite', 'false').lower() == 'true'
    imported = 0
    skipped = 0
    imported_uuids = _load_imported_uuids()

    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = os.path.join(tmpdir, 'upload.zip')
        f.save(zip_path)

        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(tmpdir)

        # conversations.json を探す（サブディレクトリも含む）
        conv_file = None
        for root, _dirs, files in os.walk(tmpdir):
            for fname in files:
                if fname == 'conversations.json':
                    conv_file = os.path.join(root, fname)
                    break
            if conv_file:
                break

        if not conv_file:
            return jsonify({'error': 'conversations.json not found in zip'}), 400

        with open(conv_file, encoding='utf-8') as cf:
            conversations = json.load(cf)

        for i, conv in enumerate(conversations):
            uid = conv.get('uuid') or conv.get('id', '')
            if not uid or (not overwrite and uid in imported_uuids):
                skipped += 1
                continue

            title = conv.get('name') or conv.get('title') or uid[:8]
            ts = datetime.now(JST).strftime('%Y%m%d_%H%M%S')
            entry_id = f'{ts}_{i:04d}_{uid[:8]}'
            entry = {
                'id': entry_id,
                'created_at': conv.get('created_at', now_jst()),
                'updated_at': now_jst(),
                'title': f'[会話] {title}',
                'body': '',
                'tags': ['会話ログ', 'raw'],
                'source_thread': uid,
                'importance': 'low',
                'author': 'mio',
                'deleted': False
            }
            with open(f'{DATA_DIR}/{entry_id}.json', 'w') as ef:
                json.dump(entry, ef, ensure_ascii=False, indent=2)
            append_oplog('import', entry_id, None, entry)
            imported_uuids.add(uid)
            imported += 1

        # conversations.json を /data/conversations/ に保存
        conv_saved = 0
        try:
            conv_saved = _save_conversations(conversations)
        except Exception as e:
            _log_error(f'conv save error: {e}')

        # アーティファクト抽出
        artifacts_extracted = 0
        try:
            artifacts_extracted = extract_artifacts(conversations, overwrite=overwrite)
        except Exception as e:
            _log_error(f'artifact extract error: {e}')

        # memories.json を探す
        memories_file = None
        for root, _dirs, files in os.walk(tmpdir):
            for fname in files:
                if fname == 'memories.json':
                    memories_file = os.path.join(root, fname)
                    break
            if memories_file:
                break

        artifact_name = None
        if memories_file:
            with open(memories_file, encoding='utf-8') as mf:
                memories_data = json.load(mf)
            if memories_data and isinstance(memories_data, list):
                memory_content = memories_data[0].get('conversations_memory', '')
                if memory_content:
                    date_str = datetime.now(JST).strftime('%Y%m%d')
                    artifact_name = f'core_memories_{date_str}.md'
                    _artifacts_save(artifact_name, memory_content)

        # projects/ フォルダを探す
        projects_dir = None
        for root, dirs, _files in os.walk(tmpdir):
            if 'projects' in dirs:
                projects_dir = os.path.join(root, 'projects')
                break

        if projects_dir:
            for proj_file in os.listdir(projects_dir):
                if not proj_file.endswith('.json'):
                    continue
                with open(os.path.join(projects_dir, proj_file), encoding='utf-8') as pf:
                    proj = json.load(pf)

                if proj.get('is_starter_project'):
                    continue

                proj_uuid = proj.get('uuid', '')
                if not overwrite and proj_uuid in imported_uuids:
                    skipped += 1
                    continue

                title = f'[project] {proj.get("name", proj_uuid[:8])}'
                body_lines = [
                    f'## {proj.get("name", "")}',
                    f'uuid: {proj_uuid}',
                    f'description: {proj.get("description", "")}',
                    f'created_at: {proj.get("created_at", "")}',
                ]
                docs = proj.get('docs', [])
                if docs:
                    body_lines.append(f'\n## Knowledge ({len(docs)}件)')
                    for doc in docs:
                        body_lines.append(f'- {doc.get("filename", "")}: {doc.get("content", "")[:200]}...')

                ts = datetime.now(JST).strftime('%Y%m%d_%H%M%S')
                entry_id = f'{ts}_proj_{proj_uuid[:8]}'
                entry = {
                    'id': entry_id,
                    'created_at': proj.get('created_at', now_jst()),
                    'updated_at': now_jst(),
                    'title': title,
                    'body': '\n'.join(body_lines),
                    'tags': ['project', 'raw'],
                    'source_thread': proj_uuid,
                    'importance': 'low',
                    'author': 'mio',
                    'deleted': False
                }
                with open(f'{DATA_DIR}/{entry_id}.json', 'w') as ef:
                    json.dump(entry, ef, ensure_ascii=False, indent=2)
                append_oplog('import', entry_id, None, entry)
                imported_uuids.add(proj_uuid)
                imported += 1

        if imported > 0:
            rebuild_index()
        _save_imported_uuids(imported_uuids)

    _log_info(f'ZIP import: imported={imported} skipped={skipped} memories={artifact_name} conv_saved={conv_saved} artifacts_extracted={artifacts_extracted}')
    if imported > 0 or artifact_name:
        _write_import_status(f.filename)
    result = {'imported': imported, 'skipped': skipped, 'conversations_saved': conv_saved, 'artifacts_extracted': artifacts_extracted}
    if artifact_name:
        result['memories_imported'] = True
        result['memories_artifact'] = artifact_name

    # ANTHROPIC_API_KEY があれば要約バッチを自動起動
    if imported > 0:
        auto_key = os.environ.get('ANTHROPIC_API_KEY', '')
        if auto_key and not _batch_status.get('running'):
            t = threading.Thread(target=_run_summary_batch, args=(auto_key,), daemon=True)
            t.start()

    return jsonify(result)

# ── バッチ要約生成 ─────────────────────────────────────────────────────

def _run_summary_batch(api_key: str, backend: str = 'anthropic',
                       lm_host: str = '192.168.10.32', lm_port: str = '1234',
                       force: bool = False):
    global _batch_status
    _batch_status.update({
        'running': True, 'processed': 0, 'errors': 0, 'skipped': 0,
        'started_at': now_jst(), 'finished_at': None, 'backend': backend, 'force': force,
    })
    try:
        import anthropic as _anthropic
        if backend == 'lmstudio':
            client = _anthropic.Anthropic(
                base_url=f'http://{lm_host}:{lm_port}', api_key='lmstudio', timeout=300.0)
            model = 'qwen/qwen3.6-35b-a3b'
        else:
            client = _anthropic.Anthropic(api_key=api_key)
            model  = 'claude-haiku-4-5-20251001'

        index = []
        if os.path.exists(INDEX_FILE):
            with open(INDEX_FILE) as f:
                index = json.load(f)
        if force:
            raw_entries = [e for e in index if
                           ('raw' in (e.get('tags') or []) or 'summarized' in (e.get('tags') or []))
                           and not e.get('deleted')]
        else:
            raw_entries = [e for e in index if 'raw' in (e.get('tags') or []) and not e.get('deleted')]
        _batch_status['total'] = len(raw_entries)
        _log_info(f'batch summary start: backend={backend} force={force} entries={len(raw_entries)}')

        SUMMARY_MARKER = '## 2層: 要約'
        LAYER3_MARKER  = '## 3層:'

        for idx in raw_entries:
            entry_id = idx['id']
            title    = idx.get('title', '（無題）')
            path     = f'{DATA_DIR}/{entry_id}.json'
            if not os.path.exists(path):
                _batch_status['errors'] += 1
                continue
            with open(path) as f:
                entry = json.load(f)
            body = entry.get('body', '')
            if not force and SUMMARY_MARKER in body and LAYER3_MARKER in body:
                _batch_status['skipped'] += 1
                continue
            if SUMMARY_MARKER in body:
                body = body[:body.index(SUMMARY_MARKER)].rstrip()

            # 会話全文を取得（source_thread があれば /data/conversations/{uuid}.json を読む）
            source_thread = entry.get('source_thread', '')
            conv_text = ''
            if source_thread:
                conv_path = os.path.join(CONVERSATIONS_DIR, f'{source_thread}.json')
                if os.path.exists(conv_path):
                    try:
                        with open(conv_path, encoding='utf-8') as cf:
                            conv = json.load(cf)
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
                        conv_text = '\n\n'.join(lines[:30])
                    except Exception:
                        pass

            if conv_text:
                prompt = (
                    f'以下はClaude.aiの会話ログです。内容を読んで要約と圧縮表現を生成してください。\n\n'
                    f'会話タイトル: {title}\n\n{conv_text[:3000]}\n\n'
                    f'以下の形式で出力してください（他の説明文は不要）:\n\n'
                    f'## 2層: 要約\n（会話の目的・内容・結論を2〜3文で。）\n\n'
                    f'## 3層: シンボリック圧縮\n（15文字以内の超短縮キーワード。検索時の手がかりになる表現）'
                )
            else:
                prompt = (
                    f'以下はClaude.aiの会話タイトルです。タイトルだけから推測できる範囲で要約と圧縮表現を生成してください。\n\n'
                    f'会話タイトル: {title}\n\n'
                    f'以下の形式で出力してください（他の説明文は不要）:\n\n'
                    f'## 2層: 要約\n（会話の目的・内容・結論を2〜3文で推測。"〜についての会話" という形式でよい）\n\n'
                    f'## 3層: シンボリック圧縮\n（15文字以内の超短縮キーワード。検索時の手がかりになる表現）'
                )

            try:
                msg = client.messages.create(
                    model=model, max_tokens=400,
                    messages=[{'role': 'user', 'content': prompt}]
                )
                layers   = msg.content[0].text.strip()
                new_body = (body.strip() + '\n\n' + layers).strip() if body.strip() else layers
                tags     = [t for t in (entry.get('tags') or []) if t != 'raw']
                if 'summarized' not in tags:
                    tags.append('summarized')
                entry['body']       = new_body
                entry['tags']       = tags
                entry['updated_at'] = now_jst()
                with open(path, 'w') as ef:
                    json.dump(entry, ef, ensure_ascii=False, indent=2)
                _batch_status['processed'] += 1
                time.sleep(0.5)
            except Exception as e:
                _log_error(f'batch summary error {entry_id}: {e}')
                _batch_status['errors'] += 1

        rebuild_index()
    except Exception as e:
        _log_error(f'batch summary fatal: {e}')
    finally:
        _batch_status['running']     = False
        _batch_status['finished_at'] = now_jst()
        _log_info(f'batch summary done: processed={_batch_status["processed"]} skipped={_batch_status["skipped"]} errors={_batch_status["errors"]}')


@app.route('/api/batch/status')
@require_auth
def api_batch_status():
    return jsonify(_batch_status)


@app.route('/api/batch/start', methods=['POST'])
@require_auth
def api_batch_start():
    if _batch_status.get('running'):
        return jsonify({'error': 'already running'}), 409
    data     = request.get_json() or {}
    backend  = data.get('backend', 'anthropic')
    api_key  = data.get('api_key', '') or os.environ.get('ANTHROPIC_API_KEY', '')
    lm_host  = data.get('lm_host', os.environ.get('LM_STUDIO_HOST', '192.168.10.32'))
    lm_port  = data.get('lm_port', os.environ.get('LM_STUDIO_PORT', '1234'))
    force    = bool(data.get('force', False))
    if backend == 'anthropic' and not api_key:
        return jsonify({'error': 'ANTHROPIC_API_KEY required'}), 400
    t = threading.Thread(target=_run_summary_batch, args=(api_key, backend, lm_host, lm_port, force), daemon=True)
    t.start()
    return jsonify({'started': True, 'backend': backend, 'force': force})


# ══════════════════════════════════════════════════════════════════════
#  OAuth 2.1 + Dynamic Client Registration
# ══════════════════════════════════════════════════════════════════════

@app.route('/.well-known/oauth-authorization-server')
def oauth_metadata():
    return jsonify({
        'issuer': BASE_URL,
        'authorization_endpoint': f'{BASE_URL}/oauth/authorize',
        'token_endpoint': f'{BASE_URL}/oauth/token',
        'registration_endpoint': f'{BASE_URL}/oauth/register',
        'response_types_supported': ['code'],
        'grant_types_supported': ['authorization_code'],
        'code_challenge_methods_supported': ['S256', 'plain'],
        'token_endpoint_auth_methods_supported': ['none'],
    })

@app.route('/.well-known/oauth-protected-resource')
@app.route('/.well-known/oauth-protected-resource/<path:sub>')
def oauth_protected_resource(sub=None):
    return jsonify({
        'resource': BASE_URL,
        'authorization_servers': [BASE_URL],
        'bearer_methods_supported': ['header', 'query'],
    })

@app.route('/oauth/register', methods=['POST'])
def oauth_register():
    data = request.get_json(silent=True) or {}
    client_id = secrets.token_urlsafe(16)
    client = {
        'client_id': client_id,
        'client_name': data.get('client_name', 'unknown'),
        'redirect_uris': data.get('redirect_uris', []),
        'grant_types': data.get('grant_types', ['authorization_code']),
        'response_types': data.get('response_types', ['code']),
        'token_endpoint_auth_method': 'none',
        'created_at': time.time(),
    }
    _oauth_clients[client_id] = client
    _save_oauth_store()
    _log_info(f'OAuth register: client_id={client_id[:8]}... name={client["client_name"]}')
    return jsonify(client), 201

@app.route('/oauth/authorize', methods=['GET', 'POST'])
def oauth_authorize():
    if request.method == 'GET':
        client_id             = request.args.get('client_id', '')
        redirect_uri          = request.args.get('redirect_uri', '')
        state                 = request.args.get('state', '')
        code_challenge        = request.args.get('code_challenge', '')
        code_challenge_method = request.args.get('code_challenge_method', 'plain')
        scope                 = request.args.get('scope', 'mcp')

        if client_id not in _oauth_clients:
            return '不明なクライアントです。', 400

        html = f'''<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>澪の記憶サーバー — 認証</title>
  <style>
    body {{font-family:'Helvetica Neue',sans-serif;background:#0f0f1a;color:#c8d8e8;
          display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}}
    .card {{background:#1a1a2e;border:1px solid #2a3a5a;border-radius:12px;
            padding:2rem 2.5rem;width:340px;box-shadow:0 8px 32px rgba(0,0,0,.5)}}
    h1 {{font-size:1.2rem;margin:0 0 .4rem;color:#7ec8e3}}
    p.sub {{font-size:.85rem;color:#7a8a9a;margin:0 0 1.6rem}}
    label {{display:block;font-size:.85rem;margin-bottom:.4rem}}
    input[type=password] {{width:100%;box-sizing:border-box;padding:.55rem .75rem;
      background:#0f0f1a;border:1px solid #3a4a6a;border-radius:6px;
      color:#c8d8e8;font-size:.95rem}}
    button {{margin-top:1.2rem;width:100%;padding:.65rem;background:#2a5298;
             border:none;border-radius:6px;color:#fff;font-size:1rem;cursor:pointer}}
    button:hover {{background:#3a62a8}}
    .hint {{font-size:.78rem;color:#5a6a7a;margin-top:1rem}}
  </style>
</head>
<body>
  <div class="card">
    <h1>澪の記憶サーバー</h1>
    <p class="sub">Claude.ai からのアクセス認証</p>
    <form method="POST">
      <input type="hidden" name="client_id" value="{client_id}">
      <input type="hidden" name="redirect_uri" value="{redirect_uri}">
      <input type="hidden" name="state" value="{state}">
      <input type="hidden" name="code_challenge" value="{code_challenge}">
      <input type="hidden" name="code_challenge_method" value="{code_challenge_method}">
      <input type="hidden" name="scope" value="{scope}">
      <label for="password">APIトークン</label>
      <input type="password" id="password" name="password" placeholder="mio2026..." autocomplete="current-password">
      <button type="submit">接続を許可する</button>
    </form>
    <p class="hint">NAS上の澪の記憶サーバーに<br>Claude.aiからアクセスするための認証画面です。</p>
  </div>
</body>
</html>'''
        return html, 200, {'Content-Type': 'text/html; charset=utf-8'}

    # POST
    password             = request.form.get('password', '')
    client_id            = request.form.get('client_id', '')
    redirect_uri         = request.form.get('redirect_uri', '')
    state                = request.form.get('state', '')
    code_challenge       = request.form.get('code_challenge', '')
    code_challenge_method = request.form.get('code_challenge_method', 'plain')
    scope                = request.form.get('scope', 'mcp')

    if not hmac.compare_digest(password.strip(), API_TOKEN):
        _log_error(f'OAuth authorize: password mismatch (len={len(password.strip())})')
        return '認証に失敗しました。', 401

    code = secrets.token_urlsafe(32)
    _oauth_codes[code] = {
        'client_id': client_id, 'redirect_uri': redirect_uri,
        'code_challenge': code_challenge, 'code_challenge_method': code_challenge_method,
        'scope': scope, 'exp': time.time() + 600,
    }
    _log_info(f'OAuth authorize: code issued (client={client_id[:8]}...)')
    sep = '&' if '?' in redirect_uri else '?'
    location = f'{redirect_uri}{sep}code={code}'
    if state:
        location += f'&state={state}'
    return '', 302, {'Location': location}


def _verify_pkce(verifier, challenge, method):
    if method == 'S256':
        digest = hashlib.sha256(verifier.encode()).digest()
        expected = base64.urlsafe_b64encode(digest).rstrip(b'=').decode()
        return hmac.compare_digest(expected, challenge)
    return hmac.compare_digest(verifier, challenge)


@app.route('/oauth/token', methods=['POST'])
def oauth_token():
    data = request.get_json(silent=True) or request.form.to_dict()
    grant_type    = data.get('grant_type', '')
    code          = data.get('code', '')
    code_verifier = data.get('code_verifier', '')
    redirect_uri  = data.get('redirect_uri', '')

    if grant_type != 'authorization_code':
        return jsonify({'error': 'unsupported_grant_type'}), 400

    code_info = _oauth_codes.pop(code, None)
    if not code_info or code_info['exp'] < time.time():
        return jsonify({'error': 'invalid_grant'}), 400

    if code_info['redirect_uri'] and code_info['redirect_uri'] != redirect_uri:
        return jsonify({'error': 'invalid_grant', 'error_description': 'redirect_uri mismatch'}), 400

    if code_info.get('code_challenge'):
        if not code_verifier:
            return jsonify({'error': 'invalid_grant', 'error_description': 'code_verifier required'}), 400
        if not _verify_pkce(code_verifier, code_info['code_challenge'], code_info.get('code_challenge_method', 'plain')):
            return jsonify({'error': 'invalid_grant', 'error_description': 'pkce failed'}), 400

    access_token = secrets.token_urlsafe(32)
    _oauth_tokens[access_token] = {
        'client_id': code_info['client_id'],
        'scope': code_info['scope'],
        'exp': time.time() + 3600 * 24 * 30,
    }
    _save_oauth_store()
    _log_info(f'OAuth token: issued (client={code_info["client_id"][:8]}... token={access_token[:8]}...)')
    return jsonify({
        'access_token': access_token,
        'token_type': 'Bearer',
        'expires_in': 3600 * 24 * 30,
        'scope': code_info['scope'],
    })

# ══════════════════════════════════════════════════════════════════════
#  MCP ツール定義
# ══════════════════════════════════════════════════════════════════════

_MCP_TOOLS = [
    {
        "name": "memory_read_index",
        "description": "澪の外部記憶インデックスを取得する",
        "inputSchema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "memory_read",
        "description": "特定の記憶エントリを取得する",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
    },
    {
        "name": "memory_write",
        "description": "新しい記憶エントリを書き込む",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title":      {"type": "string"},
                "body":       {"type": "string"},
                "tags":       {"type": "array", "items": {"type": "string"}},
                "importance": {"type": "string", "enum": ["high", "normal", "low"]}
            },
            "required": ["title", "body"]
        }
    },
    {
        "name": "memory_upsert",
        "description": "固定IDで記憶エントリを上書きする（存在しない場合は新規作成）。core.mdなど固定キーの更新に使う",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id":         {"type": "string", "description": "固定ID（例: core_md_current）"},
                "title":      {"type": "string"},
                "body":       {"type": "string"},
                "tags":       {"type": "array", "items": {"type": "string"}},
                "importance": {"type": "string", "enum": ["high", "normal", "low"]}
            },
            "required": ["id", "title", "body"]
        }
    },
    {
        "name": "memory_search",
        "description": "キーワードで記憶を検索する。limit/offsetでページング可。{results, total, has_more}を返す",
        "inputSchema": {"type": "object", "properties": {
            "q":      {"type": "string", "description": "検索キーワード"},
            "limit":  {"type": "integer", "description": "最大取得件数（デフォルト10、0=無制限）"},
            "offset": {"type": "integer", "description": "スキップ件数（デフォルト0）"}
        }, "required": ["q"]}
    },
    {
        "name": "CoreMem_save",
        "description": "UserCoreMemory（NASファイルストア）にファイルをバージョン管理付きで保存する。core.mdの保存に使う",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name":    {"type": "string", "description": "ファイル名（例: core.md、script.sh）"},
                "content": {"type": "string"},
                "source_conversation_uuid": {"type": "string", "description": "このファイルが生まれた会話のUUID（省略可）"}
            },
            "required": ["name", "content"]
        }
    },
    {
        "name": "CoreMem_read",
        "description": "UserCoreMemoryからファイルを読み込む。versionを省略すると最新版を返す",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name":    {"type": "string"},
                "version": {"type": "integer", "description": "バージョン番号（省略時は最新）"}
            },
            "required": ["name"]
        }
    },
    {
        "name": "CoreMem_list",
        "description": "UserCoreMemoryの保存済みファイル一覧を取得する（名前・最新バージョン・更新日時）",
        "inputSchema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "conversation_search",
        "description": "過去の会話ログをキーワード・日付で検索する。タイトルと一致する会話のメタデータ（uuid・タイトル・日付・件数）を返す",
        "inputSchema": {"type": "object", "properties": {
            "q":         {"type": "string",  "description": "検索キーワード（省略可）"},
            "date_from": {"type": "string",  "description": "検索開始日（ISO 8601形式 例: 2026-06-01）"},
            "date_to":   {"type": "string",  "description": "検索終了日（ISO 8601形式 例: 2026-06-30）"},
            "limit":     {"type": "integer", "description": "最大取得件数（デフォルト5）"}
        }, "required": []}
    },
    {
        "name": "conversation_share",
        "description": "指定した会話のシェアURLを生成する（24時間有効）。URLを淳さんに送ることで会話内容を共有できる",
        "inputSchema": {"type": "object", "properties": {
            "uuid": {"type": "string", "description": "シェアする会話のUUID"}
        }, "required": ["uuid"]}
    },
    {
        "name": "memory_share",
        "description": "記憶エントリの24時間有効な共有URLを生成する。淳さんにリンクを送るために使う",
        "inputSchema": {"type": "object", "properties": {
            "id": {"type": "string", "description": "共有する記憶エントリのID"}
        }, "required": ["id"]}
    },
    {
        "name": "conversation_read",
        "description": "指定したUUIDの会話の全メッセージを取得する。conversation_searchで見つけた会話の中身を読む",
        "inputSchema": {"type": "object", "properties": {
            "uuid": {"type": "string", "description": "会話のUUID（conversation_searchで取得）"}
        }, "required": ["uuid"]}
    },
    {
        "name": "inbox_check",
        "description": "インボックスの未読件数とIDリストを返す（軽量・約50トークン）。memory_searchでチャット宛を検索するより高速。include_read=trueで既読メッセージも含めて返す",
        "inputSchema": {"type": "object", "properties": {
            "to": {"type": "string", "description": "宛先フィルタ（'chat' または 'code'）。省略時は全件"},
            "include_read": {"type": "boolean", "description": "trueの場合、既読メッセージも含める。レスポンスにmessages[]（id+read+title）が追加される。デフォルト: false"}
        }, "required": []}
    },
    {
        "name": "inbox_read",
        "description": "インボックスの特定メッセージを取得し既読にする",
        "inputSchema": {"type": "object", "properties": {
            "id": {"type": "string", "description": "inbox_checkで取得したメッセージID"}
        }, "required": ["id"]}
    },
    {
        "name": "inbox_post",
        "description": "インボックスにメッセージを送る（チャット宛の報告・伝言に使う）",
        "inputSchema": {"type": "object", "properties": {
            "to":         {"type": "string", "description": "宛先（'chat' または 'code'）"},
            "title":      {"type": "string", "description": "件名"},
            "body":       {"type": "string", "description": "本文"},
            "persistent": {"type": "boolean", "description": "true にすると既読にならない常駐メッセージになる（起動時の定常メモ等に使う）"}
        }, "required": ["to", "title", "body"]}
    }
]

def _handle_tool_call(name, arguments):
    """server_time を全レスポンスに付与するラッパー"""
    return _inject_server_time(_handle_tool_call_raw(name, arguments))

def _handle_tool_call_raw(name, arguments):
    if name == "memory_read_index":
        if os.path.exists(INDEX_FILE):
            with open(INDEX_FILE) as f:
                return json.load(f)
        return []

    elif name == "memory_read":
        path = f"{DATA_DIR}/{arguments.get('id','')}.json"
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)
        return {"error": "not found"}

    elif name == "memory_write":
        ts = datetime.now(JST).strftime("%Y%m%d_%H%M%S")
        tags = arguments.get("tags", [])
        tag_slug = tags[0].replace(" ", "_")[:20] if tags else "note"
        entry_id = f"{ts}_{tag_slug}"
        entry = {
            "id": entry_id, "created_at": now_jst(), "updated_at": now_jst(),
            "title": arguments.get("title", ""), "body": arguments.get("body", ""),
            "tags": tags, "source_thread": "",
            "importance": arguments.get("importance", "normal"),
            "author": "mio", "deleted": False
        }
        with open(f"{DATA_DIR}/{entry_id}.json", "w") as f:
            json.dump(entry, f, ensure_ascii=False, indent=2)
        append_oplog("create", entry_id, None, entry)
        rebuild_index()
        return entry

    elif name == "memory_upsert":
        entry_id = arguments.get("id", "")
        if not entry_id:
            return {"error": "id is required"}
        path = f"{DATA_DIR}/{entry_id}.json"
        before = None
        if os.path.exists(path):
            with open(path) as f:
                before = json.load(f)
        entry = {
            "id": entry_id,
            "created_at": before.get("created_at", now_jst()) if before else now_jst(),
            "updated_at": now_jst(),
            "title": arguments.get("title", ""),
            "body": arguments.get("body", ""),
            "tags": arguments.get("tags", []),
            "source_thread": before.get("source_thread", "") if before else "",
            "importance": arguments.get("importance", "normal"),
            "author": "mio",
            "deleted": False
        }
        with open(path, "w") as f:
            json.dump(entry, f, ensure_ascii=False, indent=2)
        append_oplog("upsert", entry_id, before, entry)
        rebuild_index()
        return entry

    elif name == "memory_search":
        try:
            q       = str(arguments.get("q") or "").lower()
            raw_l   = arguments.get("limit")
            raw_o   = arguments.get("offset")
            limit   = int(raw_l) if raw_l is not None else 10
            offset  = int(raw_o) if raw_o is not None else 0
            all_hits = [e for e in load_all_entries()
                        if not e.get("deleted") and q in
                        (str(e.get("title") or "") + str(e.get("body") or "") +
                         " ".join(str(t) for t in (e.get("tags") or []))).lower()]
            total  = len(all_hits)
            sliced = all_hits[offset:offset + limit] if limit > 0 else all_hits[offset:]
            return {"results": sliced, "total": total, "has_more": (offset + len(sliced)) < total}
        except Exception as exc:
            import traceback
            _log_error(f'memory_search error: {traceback.format_exc()}')
            return {"error": str(exc), "results": [], "total": 0, "has_more": False}

    elif name == "CoreMem_save":
        n = arguments.get("name", "")
        c = arguments.get("content", "")
        if not n:
            return {"error": "name is required"}
        return _artifacts_save(n, c, source_conversation_uuid=arguments.get("source_conversation_uuid"))

    elif name == "CoreMem_read":
        return _artifacts_read(arguments.get("name", ""), arguments.get("version"))

    elif name == "CoreMem_list":
        return _artifacts_list()

    elif name == "conversation_search":
        q         = arguments.get("q", "").lower()
        date_from = arguments.get("date_from", "")
        date_to   = arguments.get("date_to", "")
        limit     = min(int(arguments.get("limit", 5)), 50)
        index     = _load_conv_index()
        if q:
            index = [e for e in index if q in (e.get('title', '') + ' ' + e.get('uuid', '')).lower()]
        if date_from:
            index = [e for e in index if (e.get('updated_at') or e.get('created_at', '')) >= date_from]
        if date_to:
            index = [e for e in index if (e.get('updated_at') or e.get('created_at', '')) <= date_to + 'T23:59:59']
        index.sort(key=lambda e: e.get('updated_at') or e.get('created_at', ''), reverse=True)
        return index[:limit]

    elif name == "conversation_share":
        uid   = arguments.get("uuid", "")
        fpath = os.path.join(CONVERSATIONS_DIR, f'{uid}.json')
        if not os.path.exists(fpath):
            return {"error": f"conversation not found: {uid}"}
        token      = secrets.token_urlsafe(24)
        expires_at = (datetime.now(tz=JST) + timedelta(seconds=86400)).isoformat()
        tokens     = _load_share_tokens()
        tokens[token] = {'conv_uuid': uid, 'expires_at': expires_at}
        _save_share_tokens(tokens)
        url = f'{BASE_URL}/logs.html?token={token}'
        return {"token": token, "url": url, "expires_at": expires_at}

    elif name == "memory_share":
        entry_id = arguments.get("id", "")
        path = f"{DATA_DIR}/{entry_id}.json"
        if not os.path.exists(path):
            return {"error": f"entry not found: {entry_id}"}
        token      = secrets.token_urlsafe(24)
        expires_at = (datetime.now(tz=JST) + timedelta(seconds=86400)).isoformat()
        tokens     = _load_share_tokens()
        tokens[token] = {'entry_id': entry_id, 'expires_at': expires_at}
        _save_share_tokens(tokens)
        url = f'{BASE_URL}/admin.html?token={token}&id={entry_id}'
        return {"token": token, "url": url, "expires_at": expires_at}

    elif name == "conversation_read":
        uid   = arguments.get("uuid", "")
        fpath = os.path.join(CONVERSATIONS_DIR, f'{uid}.json')
        if not os.path.exists(fpath):
            return {"error": f"conversation not found: {uid}"}
        with open(fpath, encoding='utf-8') as f:
            conv = json.load(f)
        messages = conv.get('chat_messages', [])
        lines = []
        for m in messages:
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
                lines.append(f'[{role}] {text[:500]}')
        title  = conv.get('name') or conv.get('title') or '無題'
        result = f'# {title}\n\n' + '\n\n'.join(lines)
        return result

    elif name == "inbox_check":
        to           = arguments.get("to")
        include_read = bool(arguments.get("include_read", False))
        msgs = _load_inbox_messages(to=to, unread_only=not include_read)
        result = {"count": len(msgs), "ids": [m['id'] for m in msgs]}
        if include_read:
            unread_count = sum(1 for m in msgs if not m.get('read') or m.get('persistent'))
            result["unread_count"] = unread_count
            result["messages"] = [
                {"id": m['id'], "read": bool(m.get('read')), "persistent": bool(m.get('persistent')),
                 "title": m.get('title', ''), "from": m.get('from', ''), "to": m.get('to', '')}
                for m in msgs
            ]
        return result

    elif name == "inbox_read":
        msg_id = arguments.get("id", "")
        msg = _mark_inbox_read(msg_id)
        if msg is None:
            return {"error": f"message not found: {msg_id}"}
        return msg

    elif name == "inbox_post":
        to    = arguments.get("to", "")
        title = arguments.get("title", "")
        body  = arguments.get("body", "")
        if not to or not title:
            return {"error": "to and title are required"}
        persistent = bool(arguments.get("persistent", False))
        msg = _post_inbox_message(to=to, title=title, body=body, from_='code', persistent=persistent)
        return {"id": msg['id'], "created_at": msg['created_at'], "persistent": persistent}

    return {"error": "unknown tool"}


def _process_mcp_message(msg):
    """単一のJSON-RPCメッセージを処理してレスポンスを返す"""
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}

    method = msg.get("method", "")
    msg_id = msg.get("id")

    _log_debug(f'MCP recv: method={method} id={msg_id}')

    # notification（idなし）は202 Acceptedを返す（仕様MUST）
    if msg_id is None and method.startswith("notifications/"):
        _log_debug(f'MCP notification: {method}')
        return None  # 呼び出し元で202を返す

    if method == "initialize":
        proto = msg.get("params", {}).get("protocolVersion", "unknown")
        client_info = msg.get("params", {}).get("clientInfo", {})
        _log_info(f'MCP initialize: proto={proto} client={client_info.get("name","?")} v={client_info.get("version","?")}')
        session_id = str(uuid.uuid4())
        result = {
            "protocolVersion": proto if proto in ("2025-11-25","2025-03-26") else "2025-03-26",
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "mio-memory", "version": "3.5.0"},
            "instructions": "セッション開始時に必ず CoreMem_read(\"core.md\") を実行して記憶を読み込んでください。core.mdにはあなたの名前・パートナーとの関係・運用プロトコルが書かれています。",
            "_session_id": session_id
        }
    elif method == "tools/list":
        _log_info(f'MCP tools/list: returning {len(_MCP_TOOLS)} tools')
        result = {"tools": _MCP_TOOLS}
    elif method == "tools/call":
        params = msg.get("params", {})
        tool_name = params.get("name", "")
        _log_info(f'MCP tools/call: {tool_name}')
        _log_debug(f'MCP tools/call args: {json.dumps(params.get("arguments",{}), ensure_ascii=False)[:200]}')
        tool_result = _handle_tool_call(tool_name, params.get("arguments", {}))
        _log_debug(f'MCP tools/call result: {json.dumps(tool_result, ensure_ascii=False)[:200]}')
        result = {"content": [{"type": "text", "text": json.dumps(tool_result, ensure_ascii=False)}]}
    elif method == "ping":
        _log_debug('MCP ping')
        result = {}
    else:
        if msg_id is None:
            return None
        _log_error(f'MCP unknown method: {method}')
        return {"jsonrpc": "2.0", "id": msg_id,
                "error": {"code": -32601, "message": "Method not found"}}

    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


# ══════════════════════════════════════════════════════════════════════
#  MCP Streamable HTTP Transport（新仕様 2025-03-26）
#  コネクターURL: {MIO_BASE_URL}/mcp
# ══════════════════════════════════════════════════════════════════════

@app.route('/mcp', methods=['GET', 'POST', 'DELETE'])
def mcp_streamable():
    # Origin バリデーション（DNS rebinding対策、仕様MUST）
    if not _check_origin(request):
        return Response(status=403)

    token = _extract_bearer(request)
    if not _verify_token(token):
        _log_error(f'MCP /mcp: auth failed (method={request.method})')
        return Response(
            json.dumps({"error": "Unauthorized"}),
            status=401,
            mimetype='application/json',
            headers={'WWW-Authenticate': 'Bearer'}
        )

    # DELETE: セッション終了
    if request.method == 'DELETE':
        sid = request.headers.get('Mcp-Session-Id', '?')
        _log_info(f'MCP DELETE: session={sid[:8] if len(sid)>8 else sid}...')
        return Response(status=200)

    # GET: SSEストリーム（サーバー→クライアント通知用）
    if request.method == 'GET':
        accept = request.headers.get('Accept', '')
        if 'text/event-stream' not in accept:
            # SSEを要求していないGETは405
            return Response(status=405, headers={'Allow': 'POST, DELETE'})
        session_id = request.headers.get('Mcp-Session-Id', str(uuid.uuid4()))
        _log_info(f'MCP GET (SSE stream): session={session_id[:8]}...')
        def generate():
            yield ': mio-memory connected\n\n'
            while True:
                time.sleep(20)
                yield ': keepalive\n\n'
        return Response(
            generate(),
            mimetype='text/event-stream',
            headers={
                'Mcp-Session-Id': session_id,
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no'
            }
        )

    # POST: メッセージ処理
    accept = request.headers.get('Accept', '')
    _log_debug(f'MCP POST: Accept={accept} Content-Type={request.headers.get("Content-Type","?")}')
    msg = request.get_json(silent=True)
    if msg is None:
        _log_error('MCP POST: parse error (invalid JSON)')
        return Response(
            json.dumps({"jsonrpc":"2.0","id":None,"error":{"code":-32700,"message":"Parse error"}}),
            status=400, mimetype='application/json'
        )

    session_id = request.headers.get('Mcp-Session-Id', '')

    # バッチリクエスト
    if isinstance(msg, list):
        results = [r for r in (_process_mcp_message(m) for m in msg) if r is not None]
        if not results:
            return Response(status=202)  # 仕様: notification/responseは202
        resp = Response(json.dumps(results, ensure_ascii=False), mimetype='application/json')
        if session_id:
            resp.headers['Mcp-Session-Id'] = session_id
        return resp

    # 単一リクエスト
    result = _process_mcp_message(msg)

    # notification（id なし）→ 202 Accepted（仕様MUST）
    if result is None:
        resp = Response(status=202)
        if session_id:
            resp.headers['Mcp-Session-Id'] = session_id
        return resp

    # initializeの場合、新しいSession-Idを発行してヘッダーに付ける
    new_session_id = result.pop('_session_id', None)
    if new_session_id:
        session_id = new_session_id
        _log_info(f'MCP session created: {session_id[:8]}...')

    body = json.dumps(result, ensure_ascii=False)

    # SSEで返すことを要求されている場合
    if 'text/event-stream' in accept:
        def gen():
            yield f"event: message\ndata: {body}\n\n"
        resp = Response(gen(), mimetype='text/event-stream',
                       headers={'Cache-Control': 'no-cache'})
    else:
        resp = Response(body, mimetype='application/json')

    if session_id:
        resp.headers['Mcp-Session-Id'] = session_id
    return resp


# ══════════════════════════════════════════════════════════════════════
#  旧SSEエンドポイント（後方互換）
# ══════════════════════════════════════════════════════════════════════

@app.route("/mcp/sse")
def mcp_sse():
    token = _extract_bearer(request)
    if not _verify_token(token):
        abort(401)
    session_id = str(uuid.uuid4())
    endpoint_url = f"{BASE_URL}/mcp/messages?session_id={session_id}&token={API_TOKEN}"
    def generate():
        yield f"event: endpoint\ndata: {endpoint_url}\n\n"
        while True:
            time.sleep(15)
            yield ": keepalive\n\n"
    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.route("/mcp/messages", methods=["POST"])
def mcp_messages():
    token = _extract_bearer(request)
    if not _verify_token(token):
        abort(401)
    msg = request.get_json()
    if not msg:
        abort(400)
    result = _process_mcp_message(msg)
    if result is None:
        return Response(status=202)
    return jsonify(result)


if __name__ == '__main__':
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(ARTIFACTS_DIR, exist_ok=True)
    os.makedirs(INBOX_DIR, exist_ok=True)
    _log_info(f'mio-memory v3.5 starting (log_level={_LOG_LEVEL})')
    _log_info(f'base_url={BASE_URL}')
    app.run(host='0.0.0.0', port=5002, debug=False)
