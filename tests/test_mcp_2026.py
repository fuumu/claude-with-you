# -*- coding: utf-8 -*-
"""MCP 2026-07-28 仕様（ステートレスコア＋OAuth強化）の特性テスト。

新仕様サポートは TS 層（ts/src/mcp.ts・oauth.ts）にのみ実装される
（main.py は 2025-11-25 準拠のまま — 判断記録 ExtMemory 20260714_005646_決定事項）。
そのため本ファイルは MIO_TS1=1 のときだけ実行し、Python 単体モードでは skip する。

契約（2026-07-28 RC・modelcontextprotocol.io/specification/draft）:
  - initialize/セッションなしで各リクエストが独立に処理される（ステートレス）
  - server/discover は MUST 実装（supportedVersions/capabilities/serverInfo/instructions）
  - 必須ヘッダ MCP-Protocol-Version / Mcp-Method /（tools/call では）Mcp-Name を
    ボディと突き合わせ、失敗は 400 + -32020 HeaderMismatch
  - 未対応版は 400 + -32022 UnsupportedProtocolVersion（data.supported 付き）
  - 未知メソッド（ping・initialize を含む）は 404 + -32601
  - 全結果に resultType、tools/list に ttlMs / cacheScope
  - OAuth: 認可応答に iss（RFC 9207）・DCR application_type・refresh_token グラント
"""
import base64
import hashlib
import os
import secrets

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get('MIO_TS1') != '1',
    reason='MCP 2026-07-28 support lives in the TS layer (run with MIO_TS1=1)')

PROTO = '2026-07-28'
META = 'io.modelcontextprotocol/protocolVersion'


def _meta(extra=None):
    m = {META: PROTO,
         'io.modelcontextprotocol/clientInfo': {'name': 'ts0-test', 'version': '1.0'},
         'io.modelcontextprotocol/clientCapabilities': {}}
    if extra:
        m.update(extra)
    return m


def _headers(server, method=None, name=None, proto=PROTO):
    h = {'Authorization': f'Bearer {server.token}',
         'Accept': 'application/json, text/event-stream'}
    if proto is not None:
        h['MCP-Protocol-Version'] = proto
    if method is not None:
        h['Mcp-Method'] = method
    if name is not None:
        h['Mcp-Name'] = name
    return h


def _post(server, payload, headers):
    return server.anon().post(server.base_url + '/mcp', json=payload,
                              headers=headers, timeout=30)


# ── ステートレスコア ──────────────────────────────────────────────

def test_server_discover(server):
    """server/discover は MUST。supportedVersions に新旧両版・セッションIDは発行しない"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 'd1', 'method': 'server/discover',
               'params': {'_meta': _meta()}},
              _headers(server, method='server/discover'))
    assert r.status_code == 200
    assert 'Mcp-Session-Id' not in r.headers
    result = r.json()['result']
    assert result['resultType'] == 'complete'
    assert PROTO in result['supportedVersions']
    assert '2025-11-25' in result['supportedVersions']  # デュアル時代サーバー
    assert result['serverInfo']['name'] == 'mio-memory'
    assert result['instructions']
    assert 'tools' in result['capabilities']
    assert result['ttlMs'] > 0
    assert result['cacheScope'] in ('public', 'private')


def test_server_discover_probe_without_headers(server):
    """版宣言なしの server/discover（後方互換プローブ）にも応答する"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 1, 'method': 'server/discover', 'params': {}},
              {'Authorization': f'Bearer {server.token}', 'Accept': 'application/json'})
    assert r.status_code == 200
    assert PROTO in r.json()['result']['supportedVersions']


def test_modern_tools_list_stateless(server):
    """initialize なしで tools/list が通る。resultType / ttlMs / cacheScope 必須"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list',
               'params': {'_meta': _meta()}},
              _headers(server, method='tools/list'))
    assert r.status_code == 200
    assert 'Mcp-Session-Id' not in r.headers
    result = r.json()['result']
    assert len(result['tools']) == 31
    assert result['resultType'] == 'complete'
    assert result['ttlMs'] > 0
    assert result['cacheScope'] in ('public', 'private')


def test_modern_tools_call(server):
    """Mcp-Name ヘッダ付き tools/call。結果に resultType が入る"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
               'params': {'name': 'inbox_check', 'arguments': {},
                          '_meta': _meta()}},
              _headers(server, method='tools/call', name='inbox_check'))
    assert r.status_code == 200
    result = r.json()['result']
    assert result['resultType'] == 'complete'
    assert result.get('content')


def test_unsupported_protocol_version(server):
    """未知の版 → 400 + -32022 UnsupportedProtocolVersion（supported 列挙付き）"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/list',
               'params': {'_meta': {META: '1900-01-01'}}},
              _headers(server, method='tools/list', proto='1900-01-01'))
    assert r.status_code == 400
    err = r.json()['error']
    assert err['code'] == -32022
    assert PROTO in err['data']['supported']
    assert err['data']['requested'] == '1900-01-01'


def test_header_body_version_mismatch(server):
    """MCP-Protocol-Version ヘッダとボディ _meta の版不一致 → 400 + -32020"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 5, 'method': 'tools/list',
               'params': {'_meta': _meta()}},
              _headers(server, method='tools/list', proto='2025-11-25'))
    assert r.status_code == 400
    assert r.json()['error']['code'] == -32020


def test_mcp_method_header_mismatch(server):
    """Mcp-Method ヘッダとボディ method の不一致 → 400 + -32020"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 6, 'method': 'tools/list',
               'params': {'_meta': _meta()}},
              _headers(server, method='tools/call'))
    assert r.status_code == 400
    assert r.json()['error']['code'] == -32020


def test_tools_call_requires_mcp_name_header(server):
    """モダン tools/call で Mcp-Name ヘッダ欠落 → 400 + -32020"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call',
               'params': {'name': 'inbox_check', 'arguments': {}, '_meta': _meta()}},
              _headers(server, method='tools/call'))
    assert r.status_code == 400
    assert r.json()['error']['code'] == -32020


def test_modern_unknown_method_404(server):
    """ping は 2026-07-28 で廃止 → 404 + -32601 Method not found"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 8, 'method': 'ping',
               'params': {'_meta': _meta()}},
              _headers(server, method='ping'))
    assert r.status_code == 404
    assert r.json()['error']['code'] == -32601


def test_legacy_initialize_still_works_alongside(server):
    """デュアル時代: レガシー initialize は従来どおりセッションIDを発行する"""
    r = _post(server,
              {'jsonrpc': '2.0', 'id': 9, 'method': 'initialize',
               'params': {'protocolVersion': '2025-11-25', 'capabilities': {},
                          'clientInfo': {'name': 't', 'version': '0'}}},
              {'Authorization': f'Bearer {server.token}', 'Accept': 'application/json'})
    assert r.status_code == 200
    assert r.headers.get('Mcp-Session-Id')
    assert r.json()['result']['protocolVersion'] == '2025-11-25'


def test_subscriptions_listen_stream(server):
    """subscriptions/listen は SSE ストリームで acknowledged を返す"""
    r = server.anon().post(
        server.base_url + '/mcp',
        json={'jsonrpc': '2.0', 'id': 10, 'method': 'subscriptions/listen',
              'params': {'_meta': _meta()}},
        headers=_headers(server, method='subscriptions/listen'),
        stream=True, timeout=10)
    try:
        assert r.status_code == 200
        assert 'text/event-stream' in r.headers.get('Content-Type', '')
        first = next(line for line in r.iter_lines(decode_unicode=True) if line)
        assert 'message' in first or 'acknowledged' in first
    finally:
        r.close()


# ── OAuth 強化（MCP 2026-07-28）──────────────────────────────────────

def _pkce_pair():
    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return verifier, challenge


def _register(server, redirect_uri, **extra):
    r = server.anon().post(
        server.base_url + '/oauth/register',
        json={'client_name': 'mcp2026-test', 'redirect_uris': [redirect_uri], **extra},
        timeout=10)
    assert r.status_code == 201
    return r.json()


def _get_code(server, client_id, redirect_uri, challenge):
    r = server.anon().post(
        server.base_url + '/oauth/authorize',
        data={'password': server.token, 'client_id': client_id,
              'redirect_uri': redirect_uri, 'state': 'st-2026',
              'code_challenge': challenge, 'code_challenge_method': 'S256',
              'scope': 'mcp'},
        allow_redirects=False, timeout=10)
    assert r.status_code == 302
    return r.headers['Location']


def test_oauth_authorize_response_carries_iss(server):
    """RFC 9207: 認可応答リダイレクトに iss パラメータが付く"""
    redirect_uri = 'https://example.com/cb'
    client = _register(server, redirect_uri)
    _, challenge = _pkce_pair()
    loc = _get_code(server, client['client_id'], redirect_uri, challenge)
    assert 'iss=' in loc


def test_oauth_dcr_application_type(server):
    """DCR で application_type を受理・応答に反映（未指定は web）"""
    client = _register(server, 'https://example.com/cb', application_type='native')
    assert client['application_type'] == 'native'
    client2 = _register(server, 'https://example.com/cb')
    assert client2['application_type'] == 'web'


def test_oauth_refresh_token_flow(server):
    """auth_code → refresh_token 発行 → refresh で新トークン取得（ローテーション）"""
    redirect_uri = 'https://example.com/cb'
    client = _register(server, redirect_uri)
    verifier, challenge = _pkce_pair()
    loc = _get_code(server, client['client_id'], redirect_uri, challenge)
    code = loc.split('code=')[1].split('&')[0]

    r = server.anon().post(
        server.base_url + '/oauth/token',
        json={'grant_type': 'authorization_code', 'code': code,
              'code_verifier': verifier, 'redirect_uri': redirect_uri},
        timeout=10)
    assert r.status_code == 200
    tok = r.json()
    assert tok['refresh_token']

    # refresh → 新しいアクセストークン＋新しいリフレッシュトークン
    r = server.anon().post(
        server.base_url + '/oauth/token',
        json={'grant_type': 'refresh_token', 'refresh_token': tok['refresh_token']},
        timeout=10)
    assert r.status_code == 200
    tok2 = r.json()
    assert tok2['access_token'] != tok['access_token']
    assert tok2['refresh_token'] != tok['refresh_token']

    # 新アクセストークンで REST が通る
    r = server.anon().get(
        server.base_url + '/api/memory/index',
        headers={'Authorization': f"Bearer {tok2['access_token']}"}, timeout=10)
    assert r.status_code == 200

    # ローテーション済み: 使用済みリフレッシュトークンの再利用は拒否
    r = server.anon().post(
        server.base_url + '/oauth/token',
        json={'grant_type': 'refresh_token', 'refresh_token': tok['refresh_token']},
        timeout=10)
    assert r.status_code == 400
    assert r.json()['error'] == 'invalid_grant'


def test_oauth_as_metadata_path_suffix(server):
    """RFC 8414 パスサフィックス形式のディスカバリにも応答・refresh_token 対応を広告"""
    r = server.anon().get(
        server.base_url + '/.well-known/oauth-authorization-server/mcp', timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert d['issuer']
    assert 'refresh_token' in d['grant_types_supported']
