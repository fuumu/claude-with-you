/**
 * TS-1 ストラングラー・リング0: TypeScript リバースプロキシ
 *
 * 全リクエストを Python 実装（main.py）へ透過転送する。/health のみ TS 側で
 * ネイティブ実装（形状互換・served_by: "ts" を追加）。以降のリング（TS-1 本移行）では
 * エンドポイントを1つずつ NATIVE_ROUTES に移し、特性テスト（tests/）が全パスする
 * ことを合格判定として進める。
 *
 * 依存ゼロ（node:http のみ）。SSE / チャンク転送は pipe でそのまま通す。
 *
 * 環境変数:
 *   MIO_PORT          このプロキシのリッスンポート（デフォルト 5003）
 *   MIO_UPSTREAM_HOST Python 側ホスト（デフォルト 127.0.0.1）
 *   MIO_UPSTREAM_PORT Python 側ポート（デフォルト 5002）
 */
import http from 'node:http';
import { API_TOKEN, extractBearer, verifyToken } from './auth.js';
import { loadAllEntries, loadEntry, loadIndexList } from './data.js';
import { handleInbox } from './inbox.js';
import { handleMcp } from './mcp.js';
import { handleOAuth } from './oauth.js';
import { hierarchicalSearch, randomIndexSample } from './search.js';
import { createEntry, deleteEntry, reindexAll, updateEntry } from './write.js';

const PORT = parseInt(process.env.MIO_PORT ?? '5003', 10);
const UPSTREAM_HOST = process.env.MIO_UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.MIO_UPSTREAM_PORT ?? '5002', 10);

interface HealthShape {
  status: string;
  version: string;
  mcp_tool_count: number;
  [key: string]: unknown;
}

let healthCache: HealthShape | null = null;

/** アップストリームの /health を取得（バージョン等の形状互換のため） */
function fetchUpstreamHealth(): Promise<HealthShape> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: '/health', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as HealthShape);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream health timeout')));
  });
}

/** /health のネイティブ実装（リング0で唯一 TS が直接応えるエンドポイント） */
async function handleHealth(res: http.ServerResponse): Promise<void> {
  try {
    if (!healthCache) {
      healthCache = await fetchUpstreamHealth();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...healthCache, served_by: 'ts' }));
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'upstream unavailable' }));
  }
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
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/health' || url.startsWith('/health?')) {
    void handleHealth(res);
    return;
  }

  const parsed = new URL(url, `http://127.0.0.1:${PORT}`);

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
      if (await handleOAuth(req, res, parsed)) return;
      if (await handleMcp(req, res, parsed)) return;
      proxyToUpstream(req, res, url, parsed);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal Server Error', code: 500 }));
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mio-memory-ts ring0 proxy: 127.0.0.1:${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
  );
});
