/**
 * TS-1 トランスポート前倒し: MCP Streamable HTTP トランスポート層。
 *
 * トランスポートレベルの関心事（Origin検証・認証・セッション・SSE・
 * initialize/ping/notifications）とツールディスパッチ（tools/list・tools/call →
 * tools.ts）をすべて TS が所有する。TS-FULL ステップ1 以降、/mcp は Python へ
 * 一切転送しない（未知メソッドも main.py _process_mcp_message と同じ応答を TS が返す）。
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
 * 友達セッション（friends registry の active トークン）は Ring 5 で TS ネイティブ化した
 * （friend.ts。ツール 6 本・initialize の instructions に記憶を注入・last_seen 記録）。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { extractBearer, verifyToken } from './auth.js';
import {
  activeFriendByToken,
  Friend,
  friendInstructions,
  handleFriendToolCall,
} from './friend.js';
import { FRIEND_TOOL_DEFS } from './friend-defs.js';
import { readBodyText as readBody } from './http-body.js';
import { callToolNative, listTools } from './tools.js';
import { VERSION } from './version.js';

const ALLOWED_ORIGINS = (process.env.MIO_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
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

  // clientCapabilities 必須チェック（server/discover のヘッダなしプローブは免除）
  const isProbe = method === 'server/discover' && !requested;
  if (!isProbe && !meta[META_CLIENT_CAPABILITIES]) {
    modernError(res, 400, msgId, -32602,
      'Invalid params: _meta[io.modelcontextprotocol/clientCapabilities] is required');
    return;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: 'mio-memory', version: `${VERSION}.0` };
    modernJson(res, 200, {
      jsonrpc: '2.0',
      id: msgId,
      result: {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
        ttlMs: TOOLS_LIST_TTL_MS,
        cacheScope: 'private',
        _meta: { [META_SERVER_INFO]: serverInfo },
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
      const { status, body } = await dispatchTool(msg);
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
          const rmeta = (r._meta ?? {}) as Record<string, unknown>;
          rmeta[META_SERVER_INFO] = { name: 'mio-memory', version: `${VERSION}.0` };
          r._meta = rmeta;
          out = JSON.stringify(parsed);
        }
      } catch {
        /* 変換不能ならそのまま返す */
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(out);
    } catch {
      modernError(res, 500, msgId, -32603, 'Internal error');
    }
    return;
  }

  // ping・initialize を含む未知メソッド → 404 + Method not found（仕様どおり）
  modernError(res, 404, msgId, -32601, 'Method not found');
}

function checkOrigin(req: http.IncomingMessage): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = (req.headers['origin'] as string) ?? '';
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function isToolMethod(msg: JsonRpcMessage): boolean {
  const m = msg.method ?? '';
  return m === 'tools/list' || m === 'tools/call';
}

/**
 * tools/list・tools/call の1メッセージを処理し、JSON-RPC レスポンス（生JSON文字列）を返す。
 * 未知のツール名は main.py と同じく result 内の {"error": "unknown tool"}（server_time 付き）。
 */
async function dispatchTool(msg: JsonRpcMessage): Promise<{ status: number; body: string }> {
  const id = msg.id ?? null;
  if (msg.method === 'tools/list') {
    return {
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools: listTools() } }),
    };
  }

  const params = (msg.params ?? {}) as Record<string, unknown>;
  const name = typeof params.name === 'string' ? params.name : '';
  try {
    const result = await callToolNative(name, params.arguments ?? {}, { serverVersion: VERSION });
    console.log(`[MCP] tools/call native: ${name}`);
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
  } catch (e) {
    console.log(`[MCP] tools/call native error: ${name}: ${(e as Error).message}`);
    return {
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${(e as Error).message}` },
      }),
    };
  }
}

/**
 * トランスポート・ツール以外のメッセージ（不正形式・未知メソッド）。main.py _process_mcp_message と同一:
 * オブジェクトでない → -32600、id なし → null（=202）、それ以外 → -32601
 */
function otherMessageResponse(msg: unknown): Record<string, unknown> | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const m = msg as JsonRpcMessage;
  const msgId = m.id ?? null;
  if (msgId === null) return null;
  console.log(`[MCP] unknown method: ${m.method ?? '(none)'}`);
  return { jsonrpc: '2.0', id: msgId, error: { code: -32601, message: 'Method not found' } };
}

/** 通常セッションの1メッセージを処理する（バッチの各要素にも使う）。notification は null */
async function processLegacyMessage(
  msg: unknown,
): Promise<{ response: Record<string, unknown> | null; sessionId?: string }> {
  if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
    const m = msg as JsonRpcMessage;
    if (isTransportMethod(m)) return processTransportMessage(m);
    if (isToolMethod(m)) {
      const { body } = await dispatchTool(m);
      return { response: JSON.parse(body) as Record<string, unknown> };
    }
  }
  return { response: otherMessageResponse(msg) };
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
    const sessionId = randomUUID();
    return {
      sessionId,
      response: {
        jsonrpc: '2.0',
        id: msgId,
        result: {
          protocolVersion: proto === '2025-11-25' || proto === '2025-03-26' ? proto : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mio-memory', version: `${VERSION}.0` },
          instructions: INSTRUCTIONS,
        },
      },
    };
  }

  // ping
  return { response: { jsonrpc: '2.0', id: msgId, result: {} } };
}

/** 友達セッションの1メッセージ処理（main.py _process_mcp_message の friend 分岐と同一）。notification は null */
async function processFriendMessage(
  msg: unknown,
  friend: Friend,
): Promise<{ response: Record<string, unknown> | null; sessionId?: string }> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return {
      response: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const m = msg as JsonRpcMessage;
  const method = typeof m.method === 'string' ? m.method : '';
  const msgId = m.id ?? null;

  if (msgId === null && method.startsWith('notifications/')) return { response: null };

  if (method === 'initialize') {
    const params = (m.params ?? {}) as { protocolVersion?: string };
    const proto = params.protocolVersion ?? 'unknown';
    return {
      sessionId: randomUUID(),
      response: {
        jsonrpc: '2.0',
        id: msgId,
        result: {
          protocolVersion: proto === '2025-11-25' || proto === '2025-03-26' ? proto : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mio-memory', version: `${VERSION}.0` },
          instructions: friendInstructions(friend),
        },
      },
    };
  }
  if (method === 'tools/list') {
    return { response: { jsonrpc: '2.0', id: msgId, result: { tools: FRIEND_TOOL_DEFS } } };
  }
  if (method === 'tools/call') {
    const params = (m.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    console.log(`[MCP] tools/call (friend=${friend.nickname}): ${name}`);
    const result = handleFriendToolCall(name, args, friend);
    return {
      response: {
        jsonrpc: '2.0',
        id: msgId,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      },
    };
  }
  if (method === 'ping') return { response: { jsonrpc: '2.0', id: msgId, result: {} } };
  if (msgId === null) return { response: null };
  return {
    response: { jsonrpc: '2.0', id: msgId, error: { code: -32601, message: 'Method not found' } },
  };
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
 * /mcp をトランスポート層として処理する。/mcp なら友達セッションも含めて必ずここで応答して true、
 * それ以外のパスは false。
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

  // 認証: 友達トークン（active）を先に判定（main.py と同じ順序）→ 通常トークン
  const token = extractBearer(req, url);
  const friend = activeFriendByToken(token);
  if (!friend && !verifyToken(token)) {
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

  let msg: unknown = null;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    /* 読めなければ null のまま */
  }
  // JSON として読めないボディと null は Parse error（main.py も get_json が None を返して同じ扱い）
  if (msg === null) {
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

  // 友達セッション: 常にレガシー形式（セッションIDヘッダ付き）で処理する
  if (friend) {
    if (Array.isArray(msg)) {
      const results: Record<string, unknown>[] = [];
      for (const m of msg) {
        const { response } = await processFriendMessage(m, friend);
        if (response !== null) results.push(response);
      }
      if (results.length === 0) respond(res, 202, null, sessionId, false);
      else respond(res, 200, JSON.stringify(results), sessionId, wantsSse);
      return true;
    }
    const { response, sessionId: newSession } = await processFriendMessage(msg, friend);
    if (newSession) sessionId = newSession;
    if (response === null) respond(res, 202, null, sessionId, false);
    else respond(res, 200, JSON.stringify(response), sessionId, wantsSse);
    return true;
  }

  // モダン時代（2026-07-28）: 単一メッセージのみ（バッチは版 2025-06-18 で廃止済み）。
  // ステートレス処理 — セッションIDは発行も参照もしない
  if (!Array.isArray(msg) && isModernMessage(req, msg as JsonRpcMessage)) {
    const m = msg as JsonRpcMessage;
    console.log(`[MCP] protocol=modern method=${m.method ?? '(none)'}`);
    await processModernMessage(req, res, m);
    return true;
  }

  // バッチ: 各要素を個別に処理し、応答のあるものだけ返す（全部 notification なら 202）
  if (Array.isArray(msg)) {
    console.log(`[MCP] protocol=legacy method=(batch ${msg.length} msgs)`);
    const results: Record<string, unknown>[] = [];
    for (const m of msg) {
      const { response } = await processLegacyMessage(m);
      if (response !== null) results.push(response);
    }
    if (results.length === 0) {
      respond(res, 202, null, sessionId, false);
    } else {
      respond(res, 200, JSON.stringify(results), sessionId, wantsSse);
    }
    return true;
  }

  const single = msg as JsonRpcMessage;
  console.log(`[MCP] protocol=legacy method=${single.method ?? '(none)'}`);
  const { response, sessionId: newSession } = await processLegacyMessage(single);
  if (newSession) sessionId = newSession;
  if (response === null) {
    respond(res, 202, null, sessionId, false);
  } else {
    respond(res, 200, JSON.stringify(response), sessionId, wantsSse);
  }
  return true;
}
