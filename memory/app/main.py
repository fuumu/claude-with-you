"""
mio-memory v3.0  —  Streamable HTTP MCP transport
準拠仕様: MCP 2025-11-25 (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

変更履歴:
  v3.0 (2026-06-01) - 機能拡張
    - memory_upsert ツール追加（固定IDで上書き）
    - artifacts管理追加（artifacts_save / artifacts_read / artifacts_list）
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
import hashlib
import hmac
import base64
import secrets
import time
import uuid
import zipfile
import tempfile
import logging
import sys
from datetime import datetime, timezone, timedelta
from functools import wraps
from flask import Flask, request, jsonify, abort, Response

app = Flask(__name__)

DATA_DIR      = '/data/memory'
INDEX_FILE    = '/data/index.json'
OPLOG_FILE    = '/data/oplog.json'
ARTIFACTS_DIR = '/data/artifacts'
IMPORT_LOG    = '/data/imported_uuids.json'
API_TOKEN     = os.environ.get('MIO_API_TOKEN', 'changeme')
BASE_URL      = 'https://memory.mio.runabook.synology.me'
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

def _artifacts_save(name: str, content: str) -> dict:
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

    _log_info(f'artifacts_save: {name} v{next_num:03d}')
    return {'name': name, 'version': next_num, 'version_str': f'{next_num:03d}'}

def _artifacts_read(name: str, version=None) -> dict:
    if version is None:
        path = os.path.join(ARTIFACTS_DIR, name)
        if not os.path.exists(path):
            return {'error': 'not found'}
        with open(path, 'r', encoding='utf-8') as f:
            return {'name': name, 'version': None, 'content': f.read()}
    else:
        name_slug = _name_slug(name)
        ext = os.path.splitext(name)[1]
        path = os.path.join(ARTIFACTS_DIR, 'versions', name_slug, f'{int(version):03d}{ext}')
        if not os.path.exists(path):
            return {'error': 'not found'}
        with open(path, 'r', encoding='utf-8') as f:
            return {'name': name, 'version': int(version), 'content': f.read()}

def _artifacts_list() -> list:
    if not os.path.exists(ARTIFACTS_DIR):
        return []
    items = []
    for entry in sorted(os.listdir(ARTIFACTS_DIR)):
        full_path = os.path.join(ARTIFACTS_DIR, entry)
        if not os.path.islink(full_path):
            continue
        target = os.readlink(full_path)
        version_str = os.path.splitext(os.path.basename(target))[0]
        try:
            version = int(version_str)
        except ValueError:
            version = None
        stat = os.stat(full_path)
        items.append({
            'name': entry,
            'version': version,
            'updated_at': datetime.fromtimestamp(stat.st_mtime, tz=JST).isoformat()
        })
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

# ── ヘルス ────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'time': now_jst(), 'version': '3.0'})

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
    q = request.args.get('q', '').lower()
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

# ── アーティファクト REST API ─────────────────────────────────────────

@app.route('/api/artifacts')
@require_auth
def api_artifacts_list():
    return jsonify(_artifacts_list())

@app.route('/api/artifacts/<path:name>', methods=['GET'])
@require_auth
def api_artifacts_read(name):
    version = request.args.get('version', None)
    if version is not None:
        version = int(version)
    result = _artifacts_read(name, version)
    if 'error' in result:
        abort(404)
    return jsonify(result)

@app.route('/api/artifacts/<path:name>', methods=['POST'])
@require_auth
def api_artifacts_save(name):
    data = request.get_json()
    if not data or 'content' not in data:
        abort(400)
    result = _artifacts_save(name, data['content'])
    return jsonify(result), 201

# ── ZIP インポート ─────────────────────────────────────────────────────

@app.route('/import', methods=['POST'])
@require_auth
def import_zip():
    if 'file' not in request.files:
        abort(400)
    f = request.files['file']
    if not f.filename.lower().endswith('.zip'):
        return jsonify({'error': 'zip file required'}), 400

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
            if not uid or uid in imported_uuids:
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

        if imported > 0:
            rebuild_index()
        _save_imported_uuids(imported_uuids)

    _log_info(f'ZIP import: imported={imported} skipped={skipped}')
    return jsonify({'imported': imported, 'skipped': skipped})

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
        "description": "キーワードで記憶を検索する",
        "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}
    },
    {
        "name": "artifacts_save",
        "description": "アーティファクト（ファイル）をバージョン管理付きで保存する。core.mdの保存に使う",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name":    {"type": "string", "description": "ファイル名（例: core.md、script.sh）"},
                "content": {"type": "string"}
            },
            "required": ["name", "content"]
        }
    },
    {
        "name": "artifacts_read",
        "description": "アーティファクトを読み込む。versionを省略すると最新版を返す",
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
        "name": "artifacts_list",
        "description": "保存済みアーティファクト一覧を取得する（名前・最新バージョン・更新日時）",
        "inputSchema": {"type": "object", "properties": {}, "required": []}
    }
]

def _handle_tool_call(name, arguments):
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
        q = arguments.get("q", "").lower()
        return [e for e in load_all_entries()
                if not e.get("deleted") and q in
                (e.get("title","") + e.get("body","") + " ".join(e.get("tags",[]))).lower()]

    elif name == "artifacts_save":
        n = arguments.get("name", "")
        c = arguments.get("content", "")
        if not n:
            return {"error": "name is required"}
        return _artifacts_save(n, c)

    elif name == "artifacts_read":
        return _artifacts_read(arguments.get("name", ""), arguments.get("version"))

    elif name == "artifacts_list":
        return _artifacts_list()

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
            "serverInfo": {"name": "mio-memory", "version": "3.0.0"},
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
#  コネクターURL: https://memory.mio.runabook.synology.me/mcp
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
    _log_info(f'mio-memory v3.0 starting (log_level={_LOG_LEVEL})')
    _log_info(f'base_url={BASE_URL}')
    app.run(host='0.0.0.0', port=5002, debug=False)
