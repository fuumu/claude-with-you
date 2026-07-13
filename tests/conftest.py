# -*- coding: utf-8 -*-
"""TS-0 特性テスト共通フィクスチャ。

サーバー（memory/app/main.py）を一時データディレクトリ＋ローカルポートで
サブプロセス起動し、HTTP 越しのブラックボックステストを行う。
main.py 内部は import しない（TS-1 移行後もテストがそのまま使えることが目的）。
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid as uuid_mod

import pytest
import requests

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PY = os.path.join(REPO_ROOT, 'memory', 'app', 'main.py')
TEST_TOKEN = 'ts0-test-token'


def _free_port() -> int:
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Server:
    """テスト対象サーバーのハンドル。base_url とヘルパーを提供する"""

    def __init__(self, base_url: str, token: str, data_root: str, proc):
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
            out = proc.stdout.read().decode('utf-8', 'replace') if proc.stdout else ''
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
    """TS-1 リング0 プロキシ（ts/）をビルドして dist/index.js のパスを返す"""
    ts_dir = os.path.join(REPO_ROOT, 'ts')
    dist = os.path.join(ts_dir, 'dist', 'index.js')
    src = os.path.join(ts_dir, 'src', 'index.ts')
    if not os.path.isdir(os.path.join(ts_dir, 'node_modules')):
        subprocess.run('npm install --no-audit --no-fund', shell=True, cwd=ts_dir, check=True)
    if not os.path.exists(dist) or os.path.getmtime(dist) < os.path.getmtime(src):
        subprocess.run('npx tsc', shell=True, cwd=ts_dir, check=True)
    return dist


@pytest.fixture(scope='session')
def server():
    """一時データディレクトリでサーバーを起動するセッションフィクスチャ。

    MIO_TS1=1 を指定すると、Python の前に TypeScript プロキシ（ts/・リング0）を
    立て、テストは TS サーバー経由で実行される（TS-1 の「同一サーバー」判定）。
    """
    tmpdir = tempfile.mkdtemp(prefix='mio-ts0-')
    py_port = _free_port()
    py_url = f'http://127.0.0.1:{py_port}'
    ts1 = os.environ.get('MIO_TS1') == '1'
    front_port = _free_port() if ts1 else py_port
    front_url = f'http://127.0.0.1:{front_port}'

    env = dict(os.environ)
    env.update({
        'MIO_DATA_ROOT': tmpdir,
        'MIO_API_TOKEN': TEST_TOKEN,
        'MIO_PORT': str(py_port),
        'MIO_BASE_URL': front_url,
        'MIO_LOG_LEVEL': 'off',
        'MIO_SEED_WELCOME': 'off',
        'MIO_NIGHTLY_BATCH_HOUR': 'off',
        'ANTHROPIC_API_KEY': '',
        # 要約バッチが実LMStudioに接続しないよう到達不能な宛先に向ける
        'LM_STUDIO_HOST': '127.0.0.1',
        'LM_STUDIO_PORT': '1',
        'PYTHONIOENCODING': 'utf-8',
        # main.py は encoding 指定なしの open() が多い。本番（Linux/docker）は utf-8 だが
        # Windows ローカルは cp932 になるため、本番と同じ utf-8 に固定する
        'PYTHONUTF8': '1',
    })
    proc = subprocess.Popen(
        [sys.executable, MAIN_PY], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd=REPO_ROOT)
    ts_proc = None
    try:
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
            })
            ts_proc = subprocess.Popen(
                ['node', dist], env=ts_env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                cwd=os.path.join(REPO_ROOT, 'ts'))
            _wait_health(front_url, ts_proc)
        yield Server(front_url, TEST_TOKEN, tmpdir, proc)
    finally:
        if ts_proc is not None:
            ts_proc.kill()
            ts_proc.wait(timeout=10)
        proc.kill()
        proc.wait(timeout=10)


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
