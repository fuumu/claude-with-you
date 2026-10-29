# -*- coding: utf-8 -*-
"""リクエストボディの UTF-8 デコードの契約。

本文が TCP の複数回の書き込みに分かれて届き、境目がマルチバイト文字の途中に来ても
文字化けしない（TS は以前チャンクごとにデコードしていて U+FFFD に化けていた）。
"""
import json
import socket
import time
from urllib.parse import urlsplit

TEXT = '日本語の本文' * 200


def _post_split(server, path, payload):
    """payload を JSON にして、最初のマルチバイト文字の途中で2回に分けて送る"""
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    cut = body.index('日本語'.encode('utf-8')) + 1
    u = urlsplit(server.base_url)
    head = (f'POST {path} HTTP/1.1\r\nHost: {u.hostname}\r\n'
            f'Authorization: Bearer {server.token}\r\n'
            f'Content-Type: application/json\r\nAccept: application/json\r\n'
            f'Content-Length: {len(body)}\r\nConnection: close\r\n\r\n').encode()
    s = socket.create_connection((u.hostname, u.port), timeout=15)
    try:
        s.sendall(head + body[:cut])
        time.sleep(0.2)
        s.sendall(body[cut:])
        resp = b''
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            resp += chunk
    finally:
        s.close()
    status = int(resp.split(b' ', 2)[1])
    return status, resp.split(b'\r\n\r\n', 1)[1]


def test_mcp_body_split_inside_multibyte_char(server):
    status, _ = _post_split(server, '/mcp', {
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': 'memory_write',
                   'arguments': {'title': '分割送信MCP', 'body': TEXT, 'tags': ['ts0split']}}})
    assert status == 200
    hit = server.tool('memory_search', {'q': '分割送信MCP'})['results'][0]
    assert server.tool('memory_read', {'id': hit['id']})['body'] == TEXT


def test_rest_body_split_inside_multibyte_char(server):
    status, _ = _post_split(server, '/api/memory', {'title': '分割送信REST', 'body': TEXT})
    assert status == 201
    hit = server.tool('memory_search', {'q': '分割送信REST'})['results'][0]
    assert server.tool('memory_read', {'id': hit['id']})['body'] == TEXT

    status, _ = _post_split(server, '/api/coremem/ts0_split.md', {'content': TEXT})
    assert status == 201
    assert server.tool('CoreMem_read', {'name': 'ts0_split.md'})['content'] == TEXT

    status, raw = _post_split(server, '/api/inbox', {'to': 'chat', 'title': '分割送信inbox', 'body': TEXT})
    assert status in (200, 201)
    mid = json.loads(raw[raw.index(b'{'):raw.rindex(b'}') + 1])['id']
    assert server.tool('inbox_read', {'id': mid, 'peek': True})['body'] == TEXT
