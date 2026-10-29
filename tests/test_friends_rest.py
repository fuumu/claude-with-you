# -*- coding: utf-8 -*-
"""友達 REST（登録・承認・メール・取り消し・削除）と、公開 HTML ページの契約。

友達の MCP セッション自体（initialize の instructions・6 ツール）は test_llm_native.py。
SendGrid はテストでは未設定なので、メール送信は「未設定で 500」の契約だけを固定する。
"""
import uuid


def _email():
    return f'ts0-{uuid.uuid4().hex[:8]}@example.com'


def _seq_of(server, email):
    items = server.get('/api/friends').json()['items']
    return next(f['seq_no'] for f in items if f['email'] == email)


def test_register_validates_and_rejects_duplicates(server):
    anon = server.anon()
    email = _email()
    r = anon.post(server.base_url + '/api/friends/register', json={'nickname': ' さくら ', 'email': email}, timeout=10)
    assert r.status_code == 201 and '受け付けました' in r.json()['message']
    r = anon.post(server.base_url + '/api/friends/register', json={'nickname': 'x', 'email': email}, timeout=10)
    assert r.status_code == 409
    r = anon.post(server.base_url + '/api/friends/register', json={'nickname': 'x'}, timeout=10)
    assert r.status_code == 400
    hit = [f for f in server.get('/api/friends').json()['items'] if f['email'] == email]
    assert hit[0]['nickname'] == 'さくら' and hit[0]['status'] == 'pending'


def test_list_requires_auth_and_reports_sendgrid(server):
    assert server.anon().get(server.base_url + '/api/friends', timeout=10).status_code == 401
    d = server.get('/api/friends').json()
    assert d['sendgrid_configured'] is False
    seqs = [f['seq_no'] for f in d['items']]
    assert seqs == sorted(seqs)


def test_approve_activate_revoke_and_delete(server):
    email = _email()
    server.anon().post(server.base_url + '/api/friends/register', json={'nickname': 'もも', 'email': email}, timeout=10)
    seq = _seq_of(server, email)
    assert server.post(f'/api/friends/{seq}/send_email').status_code == 400  # pending はメール不可
    r = server.post(f'/api/friends/{seq}/approve')
    assert r.status_code == 200
    friend = r.json()['friend']
    token = friend['token']
    assert friend['status'] == 'active' and friend['activation_url'].endswith(f'/activate?token={token}')
    assert server.post(f'/api/friends/{seq}/approve').status_code == 400  # 二重承認
    assert server.post(f'/api/friends/{seq}/send_email').status_code == 500  # SendGrid 未設定

    item = [f for f in server.get('/api/friends').json()['items'] if f['seq_no'] == seq][0]
    assert item['memory_count'] == 0 and 'activation_url' in item

    act = server.anon().post(server.base_url + '/api/friends/activate', json={'token': f' {token} '}, timeout=10)
    assert act.status_code == 200
    assert act.json()['nickname'] == 'もも' and act.json()['mcp_url'].endswith(f'/mcp?token={token}')
    assert server.anon().post(server.base_url + '/api/friends/activate', json={'token': 'nope'},
                              timeout=10).status_code == 400

    assert server.post(f'/api/friends/{seq}/revoke').json() == {'ok': True}
    assert server.anon().post(server.base_url + '/api/friends/activate', json={'token': token},
                              timeout=10).status_code == 400
    # 取り消し後は同じメールで登録し直せる
    r = server.anon().post(server.base_url + '/api/friends/register', json={'nickname': 'もも2', 'email': email}, timeout=10)
    assert r.status_code == 201

    assert server.delete(f'/api/friends/{seq}').json() == {'ok': True}
    assert server.delete(f'/api/friends/{seq}').status_code == 404
    assert server.post('/api/friends/99999/approve').status_code == 404


def test_direct_register_is_active(server):
    email = _email()
    r = server.post('/api/friends/direct_register', json={'nickname': '直接', 'email': email})
    assert r.status_code == 201
    d = r.json()
    assert d['ok'] is True and d['activation_url'].endswith(f'/activate?token={d["token"]}')
    assert server.post('/api/friends/direct_register', json={'nickname': '直接', 'email': email}).status_code == 409
    assert server.anon().post(server.base_url + '/api/friends/direct_register',
                              json={'nickname': 'x', 'email': _email()}, timeout=10).status_code == 401


def test_invitation_is_public(server):
    server.tool('CoreMem_save', {'name': 'friend_invitation.md', 'content': 'ようこそ、澪の家へ'})
    r = server.anon().get(server.base_url + '/api/friends/invitation', timeout=10)
    assert r.status_code == 200 and r.json()['content'] == 'ようこそ、澪の家へ'


def test_public_pages_are_served(server):
    anon = server.anon()
    for page in ('/admin.html', '/logs.html', '/share.html', '/register', '/register.html', '/activate', '/activate.html'):
        r = anon.get(server.base_url + page, timeout=10)
        assert r.status_code == 200, page
        assert r.headers['Content-Type'].startswith('text/html'), page
        assert b'<html' in r.content.lower(), page
