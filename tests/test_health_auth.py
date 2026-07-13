# -*- coding: utf-8 -*-
"""ヘルスチェック・認証・OAuthディスカバリの契約"""


def test_health(server):
    r = server.anon().get(server.base_url + '/health', timeout=10)
    assert r.status_code == 200
    d = r.json()
    assert d['status'] == 'ok'
    assert 'version' in d
    assert isinstance(d['mcp_tool_count'], int)


def test_rest_requires_auth(server):
    r = server.anon().get(server.base_url + '/api/memory/index', timeout=10)
    assert r.status_code == 401


def test_rest_rejects_bad_token(server):
    r = server.anon().get(
        server.base_url + '/api/memory/index',
        headers={'Authorization': 'Bearer wrong-token'}, timeout=10)
    assert r.status_code == 401


def test_token_via_query_param(server):
    """?token= クエリでも認証できる（album/uploads の <img>/<a> 用フォールバック）"""
    r = server.anon().get(
        server.base_url + f'/api/memory/index?token={server.token}', timeout=10)
    assert r.status_code == 200


def test_oauth_discovery(server):
    r = server.anon().get(
        server.base_url + '/.well-known/oauth-authorization-server', timeout=10)
    assert r.status_code == 200
    d = r.json()
    for key in ('issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint'):
        assert key in d, key
    assert 'S256' in d.get('code_challenge_methods_supported', [])
