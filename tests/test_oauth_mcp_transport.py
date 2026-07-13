# -*- coding: utf-8 -*-
"""OAuth 2.1 (DCR + PKCE) フルフローと MCP Streamable HTTP トランスポートの契約。

TS-1 トランスポート前倒し（/mcp・OAuth の TS 切り出し）に先立つ特性テスト追補。
MCP 2026-07-28 仕様対応時に挙動を固定するための現行（2025-11-25 準拠）契約。
"""
import base64
import hashlib
import secrets

import requests


# ── OAuth 2.1 + Dynamic Client Registration ─────────────────────────

def _register_client(server, redirect_uri):
    r = server.anon().post(
        server.base_url + '/oauth/register',
        json={'client_name': 'ts-transport-test', 'redirect_uris': [redirect_uri]},
        timeout=10)
    assert r.status_code == 201
    d = r.json()
    assert d['client_id']
    assert d['token_endpoint_auth_method'] == 'none'
    return d['client_id']


def _authorize(server, client_id, redirect_uri, challenge, method='S256',
               password=None, state='st-123'):
    """POST /oauth/authorize → 302 の Location から code を取り出す"""
    r = server.anon().post(
        server.base_url + '/oauth/authorize',
        data={
            'password': password if password is not None else server.token,
            'client_id': client_id,
            'redirect_uri': redirect_uri,
            'state': state,
            'code_challenge': challenge,
            'code_challenge_method': method,
            'scope': 'mcp',
        },
        allow_redirects=False, timeout=10)
    return r


def test_oauth_full_flow_pkce_s256(server):
    """register → authorize(HTML) → authorize POST(302+code) → token → 発行トークンで REST/MCP"""
    redirect_uri = 'https://claude.ai/api/mcp/auth_callback'
    client_id = _register_client(server, redirect_uri)

    # GET: 認証フォーム（HTML）
    r = server.anon().get(
        server.base_url + '/oauth/authorize',
        params={'client_id': client_id, 'redirect_uri': redirect_uri,
                'state': 'st-123', 'code_challenge': 'x', 'code_challenge_method': 'S256'},
        timeout=10)
    assert r.status_code == 200
    assert 'text/html' in r.headers.get('Content-Type', '')
    assert 'password' in r.text

    # POST: PKCE S256 で code 発行
    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    r = _authorize(server, client_id, redirect_uri, challenge)
    assert r.status_code == 302
    loc = r.headers['Location']
    assert loc.startswith(redirect_uri)
    assert 'state=st-123' in loc
    code = loc.split('code=')[1].split('&')[0]

    # token 交換
    r = server.anon().post(
        server.base_url + '/oauth/token',
        json={'grant_type': 'authorization_code', 'code': code,
              'code_verifier': verifier, 'redirect_uri': redirect_uri},
        timeout=10)
    assert r.status_code == 200
    tok = r.json()
    assert tok['token_type'] == 'Bearer'
    access_token = tok['access_token']

    # 発行されたトークンで REST（GET・ネイティブ経路）
    r = server.anon().get(
        server.base_url + '/api/memory/index',
        headers={'Authorization': f'Bearer {access_token}'}, timeout=10)
    assert r.status_code == 200

    # 発行されたトークンで REST（POST・書き込み系＝TS1ではプロキシ経路）
    r = server.anon().post(
        server.base_url + '/api/memory',
        json={'title': 'oauthトークン書き込み確認', 'body': 'transport test',
              'tags': ['テスト']},
        headers={'Authorization': f'Bearer {access_token}'}, timeout=30)
    assert r.status_code in (200, 201)

    # 発行されたトークンで MCP tools/list
    r = server.anon().post(
        server.base_url + '/mcp',
        json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
        headers={'Authorization': f'Bearer {access_token}',
                 'Accept': 'application/json'}, timeout=30)
    assert r.status_code == 200
    assert len(r.json()['result']['tools']) == 31


def test_oauth_token_rejects_bad_pkce(server):
    redirect_uri = 'https://example.com/cb'
    client_id = _register_client(server, redirect_uri)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(b'correct-verifier').digest()).rstrip(b'=').decode()
    r = _authorize(server, client_id, redirect_uri, challenge)
    assert r.status_code == 302
    code = r.headers['Location'].split('code=')[1].split('&')[0]

    r = server.anon().post(
        server.base_url + '/oauth/token',
        json={'grant_type': 'authorization_code', 'code': code,
              'code_verifier': 'wrong-verifier', 'redirect_uri': redirect_uri},
        timeout=10)
    assert r.status_code == 400
    assert r.json()['error'] == 'invalid_grant'


def test_oauth_authorize_rejects_wrong_password(server):
    redirect_uri = 'https://example.com/cb'
    client_id = _register_client(server, redirect_uri)
    r = _authorize(server, client_id, redirect_uri, 'x', method='plain',
                   password='wrong-password')
    assert r.status_code == 401


def test_oauth_token_rejects_unknown_grant_and_code(server):
    r = server.anon().post(
        server.base_url + '/oauth/token',
        json={'grant_type': 'client_credentials'}, timeout=10)
    assert r.status_code == 400
    assert r.json()['error'] == 'unsupported_grant_type'

    r = server.anon().post(
        server.base_url + '/oauth/token',
        json={'grant_type': 'authorization_code', 'code': 'no-such-code',
              'redirect_uri': 'https://example.com/cb'}, timeout=10)
    assert r.status_code == 400
    assert r.json()['error'] == 'invalid_grant'


def test_oauth_protected_resource_metadata(server):
    r = server.anon().get(
        server.base_url + '/.well-known/oauth-protected-resource', timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert 'authorization_servers' in d
    assert 'header' in d.get('bearer_methods_supported', [])


# ── MCP Streamable HTTP トランスポート ────────────────────────────────

def test_mcp_requires_auth(server):
    r = server.anon().post(
        server.base_url + '/mcp',
        json={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, timeout=10)
    assert r.status_code == 401
    assert 'WWW-Authenticate' in r.headers


def test_mcp_initialize_issues_session_id_header(server):
    r = server.anon().post(
        server.base_url + '/mcp',
        json={'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
              'params': {'protocolVersion': '2025-11-25', 'capabilities': {},
                         'clientInfo': {'name': 't', 'version': '0'}}},
        headers={'Authorization': f'Bearer {server.token}',
                 'Accept': 'application/json'}, timeout=10)
    assert r.status_code == 200
    assert r.headers.get('Mcp-Session-Id')
    result = r.json()['result']
    assert result['protocolVersion'] == '2025-11-25'
    assert result['serverInfo']['name'] == 'mio-memory'
    assert '_session_id' not in result  # 内部キーが漏れない


def test_mcp_post_can_respond_as_sse(server):
    """Accept に text/event-stream を含む POST は SSE 形式で応答する"""
    r = server.anon().post(
        server.base_url + '/mcp',
        json={'jsonrpc': '2.0', 'id': 7, 'method': 'ping'},
        headers={'Authorization': f'Bearer {server.token}',
                 'Accept': 'application/json, text/event-stream'}, timeout=10)
    assert r.status_code == 200
    assert 'text/event-stream' in r.headers.get('Content-Type', '')
    assert 'event: message' in r.text
    assert '"jsonrpc"' in r.text


def test_mcp_delete_closes_session(server):
    r = server.anon().delete(
        server.base_url + '/mcp',
        headers={'Authorization': f'Bearer {server.token}',
                 'Mcp-Session-Id': 'sess-test'}, timeout=10)
    assert r.status_code == 200


def test_mcp_get_without_sse_accept_is_405(server):
    r = server.anon().get(
        server.base_url + '/mcp',
        headers={'Authorization': f'Bearer {server.token}'}, timeout=10)
    assert r.status_code == 405


def test_mcp_post_invalid_json_is_parse_error(server):
    r = server.anon().post(
        server.base_url + '/mcp', data='{not-json',
        headers={'Authorization': f'Bearer {server.token}',
                 'Content-Type': 'application/json'}, timeout=10)
    assert r.status_code == 400
    assert r.json()['error']['code'] == -32700


def test_mcp_batch_request(server):
    """バッチ（配列）リクエストは配列で応答する"""
    r = server.anon().post(
        server.base_url + '/mcp',
        json=[{'jsonrpc': '2.0', 'id': 1, 'method': 'ping'},
              {'jsonrpc': '2.0', 'id': 2, 'method': 'ping'}],
        headers={'Authorization': f'Bearer {server.token}',
                 'Accept': 'application/json'}, timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert isinstance(d, list) and len(d) == 2
    assert {m['id'] for m in d} == {1, 2}
