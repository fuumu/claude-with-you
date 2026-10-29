/**
 * mio-memory TS サーバー（TS-1 ストラングラー → TS-FULL 移行中）。
 *
 * /health・/mcp・OAuth・移植済み REST は TS がネイティブ応答する。未移植の REST だけを
 * Python 実装（main.py）へ透過転送する（SSE / チャンク転送は pipe でそのまま通す）。
 * MIO_UPSTREAM=off で Python なしの単体起動（未移植ルートは 404 not found）。
 *
 * 環境変数:
 *   MIO_PORT          このサーバーのリッスンポート（デフォルト 5003）
 *   MIO_UPSTREAM      off にすると Python へ転送しない（TS 単体モード）
 *   MIO_UPSTREAM_HOST Python 側ホスト（デフォルト 127.0.0.1）
 *   MIO_UPSTREAM_PORT Python 側ポート（デフォルト 5002）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { API_TOKEN, extractBearer, verifyToken } from './auth.js';
import { handleConversations } from './conversations.js';
import { ARTIFACTS_DIR, handleCoremem } from './coremem.js';
import { DATA_DIR, DATA_ROOT, loadAllEntries, loadEntry, loadIndexList } from './data.js';
import { BufferedRequest, handleInbox } from './inbox.js';
import { handleMcp } from './mcp.js';
import { handleLlmRest } from './rest-llm.js';
import { handleOAuth } from './oauth.js';
import { hierarchicalSearch, randomIndexSample } from './search.js';
import { listTools } from './tools.js';
import { VERSION } from './version.js';
import { createEntry, deleteEntry, nowJst, reindexAll, updateEntry } from './write.js';

const PORT = parseInt(process.env.MIO_PORT ?? '5003', 10);
const UPSTREAM_HOST = process.env.MIO_UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.MIO_UPSTREAM_PORT ?? '5002', 10);

const UPSTREAM_ENABLED = (process.env.MIO_UPSTREAM ?? '').toLowerCase() !== 'off';

/** 廃止したレガシー SSE トランスポート（TS-FULL ステップ1）。Python へも転送しない */
const LEGACY_SSE_PATHS = new Set(['/mcp/sse', '/mcp/messages']);

/** /health（main.py health() と同じ形状 + served_by。Python には問い合わせない） */
function handleHealth(res: http.ServerResponse): void {
  const tools = listTools();
  sendJson(res, 200, {
    status: 'ok',
    time: nowJst(),
    version: VERSION,
    mcp_tool_count: tools.length,
    mcp_tools: tools.map((t) => t.name),
    served_by: 'ts',
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** リング1: 読み取り系 REST のネイティブ実装。処理したら true を返す */
function handleNative(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (req.method !== 'GET') return false;
  const p = url.pathname;
  const isMemoryRoute =
    p === '/api/memory/index' || p === '/api/memory/tags' || p === '/api/memory/hsearch';
  // /api/memory/<entry_id>（1セグメント・予約語以外）
  const entryMatch = /^\/api\/memory\/([^/]+)$/.exec(p);
  const reserved = new Set(['index', 'tags', 'hsearch', 'search', 'reindex']);
  const isEntryRoute = !!entryMatch && !reserved.has(entryMatch[1]);
  if (!isMemoryRoute && !isEntryRoute) return false;

  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (p === '/api/memory/index') {
    const index = loadIndexList();
    const rnd = url.searchParams.get('random');
    if (rnd !== null && rnd !== '') {
      sendJson(res, 200, randomIndexSample(index, rnd, url.searchParams.get('filter') === 'summarized'));
    } else {
      sendJson(res, 200, index.filter((e) => !e.deleted));
    }
    return true;
  }

  if (p === '/api/memory/tags') {
    const counts: Record<string, number> = {};
    for (const entry of loadAllEntries()) {
      if (entry.deleted) continue;
      for (const tag of entry.tags ?? []) {
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
    }
    sendJson(res, 200, counts);
    return true;
  }

  if (p === '/api/memory/hsearch') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) {
      sendJson(res, 200, { results: [], total: 0, has_more: false });
      return true;
    }
    sendJson(res, 200, hierarchicalSearch(q, {
      limit: parseInt(url.searchParams.get('limit') ?? '30', 10),
      offset: parseInt(url.searchParams.get('offset') ?? '0', 10),
      fullBody: false,
      includeLocal: url.searchParams.get('include_local') === 'true',
      includeAdult: url.searchParams.get('include_adult') === 'true',
      includeConversations: url.searchParams.get('include_conversations') === 'true',
    }));
    return true;
  }

  // /api/memory/<entry_id>
  const entry = loadEntry(decodeURIComponent(entryMatch![1]));
  if (entry === null) {
    sendJson(res, 404, { error: 'not found' });
  } else {
    sendJson(res, 200, entry);
  }
  return true;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const ENTRY_RESERVED = new Set(['index', 'tags', 'hsearch', 'search', 'reindex']);

/** リング2: 書き込み系 REST のネイティブ実装。担当ルートなら true を返す */
async function handleWriteNative(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';
  const isCreate = p === '/api/memory' && method === 'POST';
  const isReindex = p === '/api/memory/reindex' && method === 'POST';
  const entryMatch = /^\/api\/memory\/([^/]+)$/.exec(p);
  const isEntryWrite =
    !!entryMatch &&
    !ENTRY_RESERVED.has(entryMatch[1]) &&
    (method === 'PATCH' || method === 'DELETE');
  if (!isCreate && !isReindex && !isEntryWrite) return false;

  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (isReindex) {
    sendJson(res, 200, { status: 'reindexed', count: reindexAll() });
    return true;
  }

  if (isCreate) {
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
    } catch {
      data = null;
    }
    const entry = data ? createEntry(data) : null;
    if (entry === null) {
      sendJson(res, 400, { error: 'Bad Request', code: 400 });
    } else {
      sendJson(res, 201, entry);
    }
    return true;
  }

  // PATCH / DELETE /api/memory/<id>
  const id = decodeURIComponent(entryMatch![1]);
  if (method === 'DELETE') {
    if (deleteEntry(id)) {
      sendJson(res, 200, { status: 'deleted', id });
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
    return true;
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
  } catch {
    data = {};
  }
  const updated = updateEntry(id, data);
  if (updated === null) {
    sendJson(res, 404, { error: 'not found' });
  } else {
    sendJson(res, 200, updated);
  }
  return true;
}

/** 透過プロキシ（ヘッダ・ボディ・ステータスをそのまま中継。SSE も pipe で流れる） */
function proxyToUpstream(req: http.IncomingMessage, res: http.ServerResponse, url: string, parsed: URL): void {
  const headers: http.IncomingHttpHeaders = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };

  // トランスポート層の認証は TS が所有する: TS が検証できたトークン（API_TOKEN or
  // TS 発行を含む OAuth トークン）は API_TOKEN に書き換えて転送する。
  // Python は起動時に oauth_store.json を読むため、TS がネイティブ発行した
  // トークンを知らない — この書き換えで proxied ルートでも TS 発行トークンが通る。
  // 友達トークン・無効トークンは verifyToken が false なので書き換えず素通し
  // （友達セッションの限定ツール・Python 側 401 の挙動を保つ）。
  const token = extractBearer(req, parsed);
  if (token && token !== API_TOKEN && verifyToken(token)) {
    headers['authorization'] = `Bearer ${API_TOKEN}`;
  }

  const proxyReq = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'upstream unavailable' }));
  });
  const buffered = (req as http.IncomingMessage & BufferedRequest).bufferedBody;
  if (buffered) proxyReq.end(buffered);
  else req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/health' || url.startsWith('/health?')) {
    handleHealth(res);
    return;
  }

  const parsed = new URL(url, `http://127.0.0.1:${PORT}`);

  if (LEGACY_SSE_PATHS.has(parsed.pathname)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  // リング1: 読み取り系 REST を TS がネイティブ応答
  if (handleNative(req, res, parsed)) {
    return;
  }

  // リング2/3（書き込み系REST・inbox）→ OAuth → MCP の順にネイティブ処理を試み、
  // どれも担当しなければ透過プロキシへ（友達セッションの /mcp を含む）
  void (async () => {
    try {
      if (await handleWriteNative(req, res, parsed)) return;
      if (parsed.pathname === '/api/inbox' || parsed.pathname.startsWith('/api/inbox/')) {
        if (!verifyToken(extractBearer(req, parsed))) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (await handleInbox(req, res, parsed)) return;
      }
      // リング3: coremem REST（全ルート認証必須）
      if (parsed.pathname === '/api/coremem' || parsed.pathname.startsWith('/api/coremem/')) {
        if (!verifyToken(extractBearer(req, parsed))) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (await handleCoremem(req, res, parsed)) return;
      }
      // リング5: LLM 依存 REST（digest / batch / rating-batch / llm-status）
      if (await handleLlmRest(req, res, parsed)) return;
      // リング3: conversations REST（認証はハンドラ内。digest は上の handleLlmRest が先に処理）
      if (parsed.pathname.startsWith('/api/conversations')) {
        if (await handleConversations(req, res, parsed)) return;
      }
      if (await handleOAuth(req, res, parsed)) return;
      if (await handleMcp(req, res, parsed)) return;
      if (!UPSTREAM_ENABLED) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      proxyToUpstream(req, res, url, parsed);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal Server Error', code: 500 }));
    }
  })();
});

// 起動時に基本ディレクトリを用意する（main.py の __main__ と同じ 4 つ）。
// TS 単体起動では Python が作ってくれないため、新規データでも書き込みが ENOENT にならないように
for (const dir of [DATA_DIR, ARTIFACTS_DIR, path.join(DATA_ROOT, 'inbox'), path.join(DATA_ROOT, 'album')]) {
  fs.mkdirSync(dir, { recursive: true });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    UPSTREAM_ENABLED
      ? `mio-memory-ts v${VERSION}: 127.0.0.1:${PORT} (unported REST -> ${UPSTREAM_HOST}:${UPSTREAM_PORT})`
      : `mio-memory-ts v${VERSION}: 127.0.0.1:${PORT} (standalone, no upstream)`,
  );
});
