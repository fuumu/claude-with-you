/**
 * TS-1 トランスポート前倒し: MCP Streamable HTTP トランスポート層。
 *
 * トランスポートレベルの関心事（Origin検証・認証・セッション・SSE・
 * initialize/ping/notifications）を TS が所有し、ツールディスパッチ
 * （tools/list・tools/call）は JSON-RPC のまま Python へ転送する。
 *
 * デュアル時代（dual-era）サーバー実装:
 *   - レガシー（2025-11-25 以前）: initialize ハンドシェイク＋Mcp-Session-Id。
 *     従来どおりのセッション付き応答（後方互換・挙動不変）。
 *   - モダン（2026-07-28）: ステートレスコア。リクエストごとに _meta
 *     （io.modelcontextprotocol/protocolVersion 等）で版・クライアント情報を運ぶ。
 *     server/discover（MUST）・subscriptions/listen をネイティブ実装し、
 *     必須ヘッダ（MCP-Protocol-Version / Mcp-Method / Mcp-Name）をボディと
 *     突き合わせ検証する（不一致→400 + -32020 HeaderMismatch）。
 *     未対応版→400 + -32022 UnsupportedProtocolVersion、未知メソッド→404 + -32601。
 *   仕様: modelcontextprotocol.io/specification/draft（2026-07-28 RC）
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

// ── MCP 2026-07-28（モダン時代）────────────────────────────────────
const MODERN_VERSIONS = ['2026-07-28'];
/** server/discover の supportedVersions（モダン優先で列挙） */
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-03-26'];
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const TOOLS_LIST_TTL_MS = 3600000;

function metaOf(msg: JsonRpcMessage): Record<string, unknown> {
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const meta = params['_meta'];
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return {};
}

/** Mcp-Name 等の Base64 センチネル形式（=?base64?...?=）をデコード */
function decodeSentinel(value: string): string {
  if (value.startsWith('=?base64?') && value.endsWith('?=')) {
    try {
      return Buffer.from(value.slice(9, -2), 'base64').toString('utf-8');
    } catch {
      return value;
    }
  }
  return value;
}

function headerStr(req: http.IncomingMessage, name: string): string {
  const v = req.headers[name];
  return typeof v === 'string' ? v : '';
}

/**
 * モダン時代のリクエストか（デュアル時代サーバーの時代判別）。
 * _meta かヘッダで 2026-07-28 以降を宣言している、server/discover を呼んでいる、
 * または未知の版を宣言している（→ -32022 で supported を返すため modern 側で処理）。
 */
function isModernMessage(req: http.IncomingMessage, msg: JsonRpcMessage): boolean {
  if ((msg.method ?? '') === 'server/discover') return true;
  const metaVer = metaOf(msg)[META_PROTOCOL_VERSION];
  if (typeof metaVer === 'string' && metaVer !== '') {
    return MODERN_VERSIONS.includes(metaVer) || !SUPPORTED_VERSIONS.includes(metaVer);
  }
  const headerVer = headerStr(req, 'mcp-protocol-version');
  if (headerVer === '') return false;
  return MODERN_VERSIONS.includes(headerVer) || !SUPPORTED_VERSIONS.includes(headerVer);
}

/** モダン時代の応答（セッションIDヘッダは発行しない） */
function modernJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function modernError(
  res: http.ServerResponse,
  status: number,
  id: number | string | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  const error: Record<string, unknown> = { code, message };
  if (data) error.data = data;
  modernJson(res, status, { jsonrpc: '2.0', id, error });
}

/** 2026-07-28 ステートレスコアのリクエストを処理する */
async function processModernMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  msg: JsonRpcMessage,
): Promise<void> {
  const method = msg.method ?? '';
  const msgId = msg.id ?? null;
  const meta = metaOf(msg);
  const metaVer = typeof meta[META_PROTOCOL_VERSION] === 'string'
    ? (meta[META_PROTOCOL_VERSION] as string)
    : '';
  const headerVer = headerStr(req, 'mcp-protocol-version');

  // ヘッダとボディの版宣言は一致必須（400 + HeaderMismatch -32020）
  if (metaVer && headerVer && metaVer !== headerVer) {
    modernError(res, 400, msgId, -32020,
      `Header mismatch: MCP-Protocol-Version header value '${headerVer}' does not match body value '${metaVer}'`);
    return;
  }

  const requested = metaVer || headerVer;
  if (requested && !SUPPORTED_VERSIONS.includes(requested)) {
    modernError(res, 400, msgId, -32022, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS,
      requested,
    });
    return;
  }

  // 2026-07-28 を宣言するリクエストは標準ヘッダの検証が必須。
  // 版宣言なしの server/discover（プローブ）はヘッダ検証を免除して応答する。
  if (MODERN_VERSIONS.includes(requested)) {
    if (!headerVer) {
      modernError(res, 400, msgId, -32020,
        'Header mismatch: required MCP-Protocol-Version header is missing');
      return;
    }
    const mcpMethod = headerStr(req, 'mcp-method');
    if (!mcpMethod) {
      modernError(res, 400, msgId, -32020,
        'Header mismatch: required Mcp-Method header is missing');
      return;
    }
    if (mcpMethod !== method) {
      modernError(res, 400, msgId, -32020,
        `Header mismatch: Mcp-Method header value '${mcpMethod}' does not match body value '${method}'`);
      return;
    }
    if (method === 'tools/call') {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const bodyName = typeof params.name === 'string' ? params.name : '';
      const rawName = headerStr(req, 'mcp-name');
      if (!rawName) {
        modernError(res, 400, msgId, -32020,
          'Header mismatch: required Mcp-Name header is missing');
        return;
      }
      if (decodeSentinel(rawName) !== bodyName) {
        modernError(res, 400, msgId, -32020,
          `Header mismatch: Mcp-Name header value '${rawName}' does not match body value '${bodyName}'`);
        return;
      }
    }
  }

  // 通知（モダンコアはHTTP上のクライアント通知を定義しないが、寛容に 202 で受ける）
  if (msgId === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    const version = await upstreamVersion();
    modernJson(res, 200, {
      jsonrpc: '2.0',
      id: msgId,
      result: {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mio-memory', version: `${version}.0` },
        instructions: INSTRUCTIONS,
        ttlMs: TOOLS_LIST_TTL_MS,
        cacheScope: 'private',
      },
    });
    return;
  }

  if (method === 'subscriptions/listen') {
    // 長寿命通知ストリーム。本サーバーは listChanged を発行しないため、
    // acknowledged 通知＋SSEコメント keep-alive のみの最小実装。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    const ack = {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: { 'io.modelcontextprotocol/subscriptionId': randomUUID() } },
    };
    res.write(`event: message\ndata: ${JSON.stringify(ack)}\n\n`);
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20000);
    req.on('close', () => clearInterval(keepalive));
    return;
  }

  if (method === 'tools/list' || method === 'tools/call') {
    try {
      const { status, body } = await forwardToUpstream(msg);
      let out = body;
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const result = parsed.result;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const r = result as Record<string, unknown>;
          if (!('resultType' in r)) r.resultType = 'complete';
          if (method === 'tools/list') {
            if (!('ttlMs' in r)) r.ttlMs = TOOLS_LIST_TTL_MS;
            if (!('cacheScope' in r)) r.cacheScope = 'private';
          }
          out = JSON.stringify(parsed);
        }
      } catch {
        /* 変換不能ならそのまま返す */
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(out);
    } catch {
      modernJson(res, 502, { error: 'upstream unavailable' });
    }
    return;
  }

  // ping・initialize を含む未知メソッド → 404 + Method not found（仕様どおり）
  modernError(res, 404, msgId, -32601, 'Method not found');
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

  // モダン時代（2026-07-28）: 単一メッセージのみ（バッチは版 2025-06-18 で廃止済み）。
  // ステートレス処理 — セッションIDは発行も参照もしない
  if (!Array.isArray(msg) && isModernMessage(req, msg as JsonRpcMessage)) {
    await processModernMessage(req, res, msg as JsonRpcMessage);
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
