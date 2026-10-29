# -*- coding: utf-8 -*-
"""TS-0 特性テスト共通フィクスチャ。

サーバー（memory/app/main.py）を一時データディレクトリ＋ローカルポートで
サブプロセス起動し、HTTP 越しのブラックボックステストを行う。
main.py 内部は import しない（TS-1 移行後もテストがそのまま使えることが目的）。

起動モード:
  （既定）        Python（main.py）単体
  MIO_TS1=1       TS サーバーを前段に置き、未移植 REST だけ Python へ転送
  MIO_TS_ONLY=1   TS サーバー単体（Python を起動しない・MIO_UPSTREAM=off）。
                  MIO_TS1=1 も立つので TS 専用テストも走る。未移植 REST に依存する
                  テストは @pytest.mark.requires_python で印を付け、このモードでは skip する
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid as uuid_mod
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import requests

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(REPO_ROOT, 'memory', 'app', 'main.py')
TEST_TOKEN = 'ts0-test-token'

# TS 単体モード。テストモジュールの skipif（MIO_TS1 == '1'）が評価される前に立てる
TS_ONLY = os.environ.get('MIO_TS_ONLY') == '1'
if TS_ONLY:
    os.environ['MIO_TS1'] = '1'


def pytest_configure(config):
    config.addinivalue_line(
        'markers',
        'requires_python: 未移植（Python のみ）の REST に依存する。MIO_TS_ONLY=1 では skip')


def pytest_collection_modifyitems(config, items):
    if not TS_ONLY:
        return
    skip = pytest.mark.skip(reason='未移植 REST に依存（MIO_TS_ONLY=1 では Python がいない）')
    for item in items:
        if 'requires_python' in item.keywords:
            item.add_marker(skip)


def _free_port() -> int:
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class MockLLM:
    """テスト用のローカル LLM（Anthropic Messages 互換 `POST /v1/messages` + `/v1/models`）。

    実 LM Studio（LAN）に接続しないよう、Python / TS の両サーバーの LLM_ENDPOINTS をここへ向ける。
    プロンプトの特徴的な文言で応答を切り替える。tests から `server.llm` で操作する:
      llm.set(mode='fail')     … /v1/messages が 500 を返す（LLM 障害のシミュレーション）
      llm.set(rating='adult')  … レーティング判定の返答を変える（safe / mature / adult）
      llm.calls                … 受信した /v1/messages の prompt 一覧
      llm.serve('/x.png', bytes, 'image/png')  … 静的ファイル配信（album_save の url 用）
    """

    RATING_MARK = 'コンテンツレーティング判定'
    SUBLIMATE_MARK = '「昇華」変換'
    DIGEST_PART_MARK = '以下は会話ログの一部です'
    DIGEST_ALL_MARK = '各パートのダイジェスト'
    KEYWORDS_MARK = '検索に使うキーワードを3〜5個生成'
    LAYERS_MARK = '## 2層: 要約'

    def __init__(self):
        self.mode = 'ok'
        self.rating = 'safe'
        self.calls = []
        self.statics = {}
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # 静かに
                pass

            def _send(self, status, body, ctype='application/json'):
                data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                path = self.path.split('?')[0]
                if path == '/v1/models':
                    return self._send(200, {'data': [{'id': 'mock-model'}]})
                if path in outer.statics:
                    ctype, data = outer.statics[path]
                    return self._send(200, data, ctype)
                self._send(404, {'error': 'not found'})

            def do_POST(self):
                n = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(n) if n else b''
                if self.path == '/v1/messages':
                    try:
                        req = json.loads(raw.decode('utf-8'))
                    except ValueError:
                        return self._send(400, {'error': 'bad json'})
                    prompt = ''
                    for m in req.get('messages', []):
                        c = m.get('content')
                        prompt += c if isinstance(c, str) else ''.join(
                            b.get('text', '') for b in c if isinstance(b, dict))
                    with outer._lock:
                        outer.calls.append({'prompt': prompt, 'model': req.get('model'),
                                            'max_tokens': req.get('max_tokens'),
                                            'temperature': req.get('temperature')})
                        mode, rating = outer.mode, outer.rating
                    if mode == 'fail':
                        return self._send(500, {'type': 'error',
                                                'error': {'type': 'api_error', 'message': 'mock failure'}})
                    text = outer.reply_for(prompt, rating)
                    return self._send(200, {
                        'id': 'msg_mock', 'type': 'message', 'role': 'assistant',
                        'model': req.get('model', 'mock-model'),
                        'content': [{'type': 'text', 'text': text}],
                        'stop_reason': 'end_turn', 'stop_sequence': None,
                        'usage': {'input_tokens': 1, 'output_tokens': 1}})
                self._send(404, {'error': 'not found'})

        self._httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self._httpd.server_address[1]
        self.base = f'http://127.0.0.1:{self.port}'
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def reply_for(self, prompt, rating):
        if self.RATING_MARK in prompt:
            return json.dumps({'rating': rating, 'reason': 'モック判定'}, ensure_ascii=False)
        if self.SUBLIMATE_MARK in prompt:
            return '昇華済みのモックテキスト。波のように静かに満ちていく。'
        if self.DIGEST_ALL_MARK in prompt:
            return 'モック統合ダイジェスト'
        if self.DIGEST_PART_MARK in prompt:
            return 'モックチャンクダイジェスト'
        if self.KEYWORDS_MARK in prompt:
            return 'モックA, モックB, モックC'
        if self.LAYERS_MARK in prompt:
            return ('## 2層: 要約\nモックによる要約文です。会話の目的と結論を十分な長さで記述しています。\n\n'
                    '## 3層: シンボリック圧縮\nモック圧縮\n\n'
                    '## 4層: キーワード\nモック要約, テスト, 層')
        return 'mock'

    def set(self, mode=None, rating=None):
        with self._lock:
            if mode is not None:
                self.mode = mode
            if rating is not None:
                self.rating = rating

    def reset(self):
        with self._lock:
            self.mode, self.rating = 'ok', 'safe'
            self.calls = []

    def serve(self, path, data, content_type):
        self.statics[path] = (content_type, data)
        return self.base + path

    def close(self):
        self._httpd.shutdown()


class Server:
    """テスト対象サーバーのハンドル。base_url とヘルパーを提供する"""

    def __init__(self, base_url: str, token: str, data_root: str, proc, llm=None):
        self.llm = llm
        self.base_url = base_url
        self.token = token
        self.data_root = data_root
        self.proc = proc
        self._session = requests.Session()
        self._session.headers['Authorization'] = f'Bearer {token}'

    # ── REST ヘルパー ──────────────────────────────────────────────
    def get(self, path, **kw):
        return self._session.get(self.base_url + path, timeout=30, **kw)

    def post(self, path, **kw):
        return self._session.post(self.base_url + path, timeout=60, **kw)

    def patch(self, path, **kw):
        return self._session.patch(self.base_url + path, timeout=30, **kw)

    def delete(self, path, **kw):
        return self._session.delete(self.base_url + path, timeout=30, **kw)

    def anon(self):
        """認証ヘッダなしの素の requests セッション"""
        return requests.Session()

    # ── MCP ヘルパー ──────────────────────────────────────────────
    def mcp(self, method, params=None, id_=1):
        """MCP JSON-RPC リクエストを送り、レスポンス JSON を返す"""
        payload = {'jsonrpc': '2.0', 'id': id_, 'method': method}
        if params is not None:
            payload['params'] = params
        r = self._session.post(
            self.base_url + '/mcp', json=payload, timeout=60,
            headers={'Accept': 'application/json'})
        assert r.status_code == 200, f'MCP {method} -> HTTP {r.status_code}: {r.text[:300]}'
        return r.json()

    def tool(self, name, arguments=None):
        """tools/call を実行し、content[0].text の JSON を dict で返す。
        JSON-RPC レベルのエラーは assert で落とす（ツールレベルの error キーは呼び出し側で検証）"""
        res = self.mcp('tools/call', {'name': name, 'arguments': arguments or {}})
        assert 'error' not in res, f'tools/call {name} -> {res.get("error")}'
        result = res['result']
        for c in result.get('content', []):
            if c.get('type') == 'text':
                try:
                    return json.loads(c['text'])
                except ValueError:
                    return {'_text': c['text']}
        return result


def _wait_health(base_url, proc, timeout=30):
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        if proc.poll() is not None:
            out = ''
            log_path = getattr(proc, 'log_path', None)
            if log_path and os.path.exists(log_path):
                with open(log_path, 'rb') as f:
                    out = f.read().decode('utf-8', 'replace')
            raise RuntimeError(f'server exited early (code={proc.returncode}):\n{out[-3000:]}')
        try:
            r = requests.get(base_url + '/health', timeout=2)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException as e:
            last_err = e
        time.sleep(0.3)
    raise RuntimeError(f'server did not become healthy: {last_err}')


def _ensure_ts_built():
    """TS-1 プロキシ（ts/）をビルドして dist/index.js のパスを返す"""
    ts_dir = os.path.join(REPO_ROOT, 'ts')
    dist = os.path.join(ts_dir, 'dist', 'index.js')
    src_dir = os.path.join(ts_dir, 'src')
    src_mtime = max(
        os.path.getmtime(os.path.join(src_dir, f))
        for f in os.listdir(src_dir) if f.endswith('.ts'))
    if not os.path.isdir(os.path.join(ts_dir, 'node_modules')):
        subprocess.run('npm install --no-audit --no-fund', shell=True, cwd=ts_dir, check=True)
    if not os.path.exists(dist) or os.path.getmtime(dist) < src_mtime:
        subprocess.run('npx tsc', shell=True, cwd=ts_dir, check=True)
    return dist


@pytest.fixture(scope='session')
def server():
    """一時データディレクトリでサーバーを起動するセッションフィクスチャ。

    MIO_TS1=1 を指定すると、Python の前に TypeScript サーバー（ts/）を
    立て、テストは TS サーバー経由で実行される（TS-1 の「同一サーバー」判定）。
    MIO_TS_ONLY=1 では Python を起動せず TS サーバーだけで実行する。
    """
    tmpdir = tempfile.mkdtemp(prefix='mio-ts0-')
    py_port = _free_port()
    py_url = f'http://127.0.0.1:{py_port}'
    ts1 = os.environ.get('MIO_TS1') == '1'
    front_port = _free_port() if ts1 else py_port
    front_url = f'http://127.0.0.1:{front_port}'

    # 実 LAN の LM Studio に接続しないよう、LLM は常にテスト内のモックへ向ける。
    # Python / TS の両サーバーに同じ設定を渡す（TS は環境を継承するだけでは漏れる）
    llm = MockLLM()
    llm_env = {
        'LLM_ENDPOINTS': f'127.0.0.1:{llm.port}',
        'LLM_OK_MODELS': 'mock-model',
        'LM_STUDIO_HOST': '127.0.0.1',
        'LM_STUDIO_PORT': '1',
        'ANTHROPIC_API_KEY': '',
        'MIO_NIGHTLY_BATCH_HOUR': 'off',
        'MIO_IMPORT_AUTO_BATCH': 'off',
    }

    env = dict(os.environ)
    env.update({
        'MIO_DATA_ROOT': tmpdir,
        'MIO_API_TOKEN': TEST_TOKEN,
        'MIO_PORT': str(py_port),
        'MIO_BASE_URL': front_url,
        'MIO_LOG_LEVEL': 'off',
        'MIO_SEED_WELCOME': 'off',
        'PYTHONIOENCODING': 'utf-8',
        # main.py は encoding 指定なしの open() が多い。本番（Linux/docker）は utf-8 だが
        # Windows ローカルは cp932 になるため、本番と同じ utf-8 に固定する
        'PYTHONUTF8': '1',
    })
    env.update(llm_env)
    # サーバー出力は PIPE にせずファイルへ流す。PIPE だと誰も読まないためバッファが満杯に
    # なりサーバーが書き込みでブロックし、一括実行の中盤でハングする（MIO_TS1=1 で顕在化）
    logdir = tempfile.mkdtemp(prefix='mio-ts0-log-')
    py_log = open(os.path.join(logdir, 'python.log'), 'wb')
    proc = None
    if not TS_ONLY:
        proc = subprocess.Popen(
            [sys.executable, MAIN_PY], env=env,
            stdout=py_log, stderr=subprocess.STDOUT,
            cwd=REPO_ROOT)
        proc.log_path = py_log.name
    ts_proc = None
    ts_log = None
    try:
        if proc is not None:
            _wait_health(py_url, proc)
        if ts1:
            dist = _ensure_ts_built()
            ts_env = dict(os.environ)
            ts_env.update({
                'MIO_PORT': str(front_port),
                'MIO_UPSTREAM_HOST': '127.0.0.1',
                'MIO_UPSTREAM_PORT': str(py_port),
                # リング1〜: TS ネイティブ実装がデータ層・認証を直接扱う
                'MIO_DATA_ROOT': tmpdir,
                'MIO_API_TOKEN': TEST_TOKEN,
                # トランスポート前倒し: OAuth メタデータの issuer 等に使用
                'MIO_BASE_URL': front_url,
                'MIO_LOG_LEVEL': 'off',
            })
            if TS_ONLY:
                ts_env['MIO_UPSTREAM'] = 'off'
            ts_env.update(llm_env)
            ts_log = open(os.path.join(logdir, 'node.log'), 'wb')
            ts_proc = subprocess.Popen(
                ['node', dist], env=ts_env,
                stdout=ts_log, stderr=subprocess.STDOUT,
                cwd=os.path.join(REPO_ROOT, 'ts'))
            ts_proc.log_path = ts_log.name
            _wait_health(front_url, ts_proc)
        yield Server(front_url, TEST_TOKEN, tmpdir, proc or ts_proc, llm)
    finally:
        if ts_proc is not None:
            ts_proc.kill()
            ts_proc.wait(timeout=10)
        if proc is not None:
            proc.kill()
            proc.wait(timeout=10)
        py_log.close()
        llm.close()
        if ts_log is not None:
            ts_log.close()
        # 一時データ・ログは使い捨て（従来は残骸が %TEMP% に溜まり続けていた）
        shutil.rmtree(tmpdir, ignore_errors=True)
        shutil.rmtree(logdir, ignore_errors=True)


@pytest.fixture()
def make_conv_zip(tmp_path):
    """claude.ai エクスポート形式の conversations.json を含む ZIP を作るファクトリ"""
    import zipfile

    def _make(conversations, name='export.zip'):
        p = tmp_path / name
        with zipfile.ZipFile(p, 'w') as z:
            z.writestr('conversations.json', json.dumps(conversations, ensure_ascii=False))
        return p

    return _make


def new_uuid():
    return str(uuid_mod.uuid4())


def make_conversation(uuid=None, title='テスト会話', texts=None,
                      created_at='2026-07-01T10:00:00.000000Z',
                      updated_at='2026-07-01T12:00:00.000000Z'):
    """claude.ai エクスポート形式の会話 dict を生成"""
    msgs = []
    for i, t in enumerate(texts or ['こんにちは', 'やあ、元気？']):
        msgs.append({
            'uuid': new_uuid(),
            'sender': 'human' if i % 2 == 0 else 'assistant',
            'text': t,
            'content': [{'type': 'text', 'text': t}],
            'created_at': created_at,
        })
    return {
        'uuid': uuid or new_uuid(),
        'name': title,
        'created_at': created_at,
        'updated_at': updated_at,
        'chat_messages': msgs,
    }
