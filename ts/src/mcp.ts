/**
 * TS-1 トランスポート前倒し: MCP Streamable HTTP トランスポート層。
 *
 * トランスポートレベルの関心事（Origin検証・認証・セッション・SSE・
 * initialize/ping/notifications）を TS が所有し、ツールディスパッチ
 * （tools/list・tools/call）は JSON-RPC のまま Python へ転送する。
 *
 * MCP 2026-07-28 仕様（ステートレスコア・initialize廃止・_meta方式）への
 * 追従は本モジュールの改修で行う — main.py には触れない。
 *
 * 友達セッション（friends registry のトークン）はツール構成が動的なため
 * 丸ごと Python へ透過転送する（このモジュールは false を返す）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { API_TOKEN, extractBearer, verifyToken } from './auth.js';
import { DATA_ROOT } from './data.js';

const UPSTREAM_HOST = process.env.MIO_UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.MIO_UPSTREAM_PORT ?? '5002', 10);
const ALLOWED_ORIGINS = (process.env.MIO_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FRIENDS_REGISTRY = path.join(DATA_ROOT, 'friends', 'registry.json');

const INSTRUCTIONS =
  'このサーバーは mio-memory — 菊池淳（きくち・あつし）専用の外部記憶MCP サーバーです。' +
  'セッション開始時に必ず CoreMem_read("core.md") を実行して記憶を読み込んでください。' +
  'core.md にはあなたの名前・パートナーとの関係・運用プロトコルが書かれています。' +
  '主な機能：記憶の保存・検索（ExtMemory）、コアメモリ（CoreMem — 永続的な設定・知識）、' +
  '過去の会話ログ参照（conversation_read/search）、セッション間の申し送り（inbox）、' +
  '画像記憶（album）、会話ダイジェスト生成（conversation_digest）。';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 友達トークンか（friends registry に active で存在するか） */
function isFriendToken(token: string): boolean {
  if (!token) return false;
  try {
    const reg = JSON.parse(fs.readFileSync(FRIENDS_REGISTRY, 'utf-8')) as Record<
      string,
      { status?: string }
    >;
    return token in reg;
  } catch {
    return false;
  }
}

function checkOrigin(req: http.IncomingMessage): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = (req.headers['origin'] as string) ?? '';
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

/** アップストリーム（Python /mcp）のバージョンを /health からキャッシュ取得 */
let versionCache: string | null = null;
function upstreamVersion(): Promise<string> {
  if (versionCache) return Promise.resolve(versionCache);
  return new Promise((resolve) => {
    const req = http.get(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: '/health', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            versionCache = (JSON.parse(body) as { version?: string }).version ?? '0';
          } catch {
            versionCache = '0';
          }
          resolve(versionCache);
        });
      },
    );
    req.on('error', () => resolve('0'));
    req.on('timeout', () => {
      req.destroy();
      resolve('0');
    });
  });
}

/** 単一 JSON-RPC メッセージを Python /mcp へ転送し、レスポンス（生JSON文字列）を返す */
function forwardToUpstream(payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Accept: 'application/json',
          Authorization: `Bearer ${API_TOKEN}`,
        },
        timeout: 120000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 502, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream mcp timeout')));
    req.end(data);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** トランスポートレベルで処理できるメソッドか */
function isTransportMethod(msg: JsonRpcMessage): boolean {
  const m = msg.method ?? '';
  if (m === 'initialize' || m === 'ping') return true;
  if ((msg.id ?? null) === null && m.startsWith('notifications/')) return true;
  return false;
}

/** initialize / ping / notification をネイティブ処理。notification は null（=202） */
async function processTransportMessage(
  msg: JsonRpcMessage,
): Promise<{ response: Record<string, unknown> | null; sessionId?: string }> {
  const method = msg.method ?? '';
  const msgId = msg.id ?? null;

  if (msgId === null && method.startsWith('notifications/')) {
    return { response: null };
  }

  if (method === 'initialize') {
    const params = (msg.params ?? {}) as { protocolVersion?: string };
    const proto = params.protocolVersion ?? 'unknown';
    const version = await upstreamVersion();
    const sessionId = randomUUID();
    return {
      sessionId,
      response: {
        jsonrpc: '2.0',
        id: msgId,
        result: {
          protocolVersion: proto === '2025-11-25' || proto === '2025-03-26' ? proto : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mio-memory', version: `${version}.0` },
          instructions: INSTRUCTIONS,
        },
      },
    };
  }

  // ping
  return { response: { jsonrpc: '2.0', id: msgId, result: {} } };
}

function respond(
  res: http.ServerResponse,
  status: number,
  body: string | null,
  sessionId: string,
  asSse: boolean,
): void {
  const headers: Record<string, string> = {};
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (asSse) {
    res.writeHead(status, {
      ...headers,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(`event: message\ndata: ${body}\n\n`);
  } else {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
    res.end(body);
  }
}

/**
 * /mcp をトランスポート層として処理する。処理したら true。
 * 友達トークンのセッションは false を返し、呼び出し側の透過プロキシに委ねる。
 */
export async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/mcp') return false;

  // Origin バリデーション（DNS rebinding 対策・仕様MUST）
  if (!checkOrigin(req)) {
    res.writeHead(403);
    res.end();
    return true;
  }

  // 認証: 通常トークンは TS が検証。友達トークンは Python へ透過
  const token = extractBearer(req, url);
  if (!verifyToken(token)) {
    if (isFriendToken(token)) return false; // 友達セッション → プロキシへ
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return true;
  }

  // DELETE: セッション終了
  if (req.method === 'DELETE') {
    res.writeHead(200);
    res.end();
    return true;
  }

  // GET: SSE キープアライブストリーム
  if (req.method === 'GET') {
    const accept = (req.headers['accept'] as string) ?? '';
    if (!accept.includes('text/event-stream')) {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return true;
    }
    const sessionId = (req.headers['mcp-session-id'] as string) ?? randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Mcp-Session-Id': sessionId,
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    res.write(': mio-memory connected\n\n');
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20000);
    req.on('close', () => clearInterval(keepalive));
    return true;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST, DELETE' });
    res.end();
    return true;
  }

  // POST: JSON-RPC メッセージ処理
  const accept = (req.headers['accept'] as string) ?? '';
  const wantsSse = accept.includes('text/event-stream');
  let sessionId = (req.headers['mcp-session-id'] as string) ?? '';

  let msg: unknown;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    respond(
      res,
      400,
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
      '',
      false,
    );
    return true;
  }

  // バッチ: 全要素がトランスポートメソッドならネイティブ、そうでなければ丸ごと転送
  if (Array.isArray(msg)) {
    const messages = msg as JsonRpcMessage[];
    if (messages.every((m) => isTransportMethod(m))) {
      const results: Record<string, unknown>[] = [];
      for (const m of messages) {
        const { response } = await processTransportMessage(m);
        if (response !== null) results.push(response);
      }
      if (results.length === 0) {
        respond(res, 202, null, sessionId, false);
      } else {
        respond(res, 200, JSON.stringify(results), sessionId, wantsSse);
      }
    } else {
      try {
        const { status, body } = await forwardToUpstream(messages);
        respond(res, status, status === 202 ? null : body, sessionId, wantsSse);
      } catch {
        respond(res, 502, JSON.stringify({ error: 'upstream unavailable' }), '', false);
      }
    }
    return true;
  }

  const single = msg as JsonRpcMessage;
  if (isTransportMethod(single)) {
    const { response, sessionId: newSession } = await processTransportMessage(single);
    if (newSession) sessionId = newSession;
    if (response === null) {
      respond(res, 202, null, sessionId, false);
    } else {
      respond(res, 200, JSON.stringify(response), sessionId, wantsSse);
    }
    return true;
  }

  // tools/list・tools/call・未知メソッド → Python へ転送（実装の単一情報源を維持）
  try {
    const { status, body } = await forwardToUpstream(single);
    respond(res, status, status === 202 ? null : body, sessionId, wantsSse);
  } catch {
    respond(res, 502, JSON.stringify({ error: 'upstream unavailable' }), '', false);
  }
  return true;
}
