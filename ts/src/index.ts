/**
 * mio-memory サーバー（v4.0〜 TypeScript 単体。Python 版 main.py は legacy-python ブランチに退避）。
 *
 * /health・/mcp（MCP Streamable HTTP）・OAuth・REST・HTML ページをすべてこのプロセスが応答する。
 * 依存は node 標準ライブラリと sharp（album の画像縮小）だけ。
 *
 * 環境変数（主なもの。全体は CLAUDE.md の表）:
 *   MIO_PORT        リッスンポート（デフォルト 5002）
 *   MIO_BIND        バインド先（デフォルト 0.0.0.0。テストは 127.0.0.1）
 *   MIO_DATA_ROOT   データディレクトリ（デフォルト /data）
 *   MIO_API_TOKEN   Bearer 認証トークン
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { extractBearer, verifyToken } from './auth.js';
import { handleConvArtifacts, handleConversations } from './conversations.js';
import { ARTIFACTS_DIR, handleCoremem } from './coremem.js';
import { DATA_DIR, DATA_ROOT, loadAllEntries, loadEntry, loadIndexList } from './data.js';
import { readBodyText as readRequestBody } from './http-body.js';
import { handleInbox } from './inbox.js';
import { logInfo } from './llm.js';
import { handleMcp } from './mcp.js';
import { handleAdminRest } from './rest-admin.js';
import { handleFriendsRest } from './rest-friends.js';
import { handleImportRest } from './rest-import.js';
import { handleMediaRest } from './rest-media.js';
import { handleRedactRest } from './redact.js';
import { startNightlyScheduler } from './scheduler.js';
import { seedCoreMemIfEmpty } from './seed.js';
import { handleStatic } from './static.js';
import { handleLlmRest } from './rest-llm.js';
import { handleOAuth } from './oauth.js';
import { hierarchicalSearch, randomIndexSample } from './search.js';
import { migrateAllMeta } from './tools-file.js';
import { listTools } from './tools.js';
import { VERSION } from './version.js';
import { createEntry, deleteEntry, nowJst, reindexAll, updateEntry } from './write.js';

const PORT = parseInt(process.env.MIO_PORT ?? '5002', 10);
const BIND = process.env.MIO_BIND || '0.0.0.0';

/** 廃止したレガシー SSE トランスポート（TS-FULL ステップ1） */
const LEGACY_SSE_PATHS = new Set(['/mcp/sse', '/mcp/messages']);

/** /health（旧 main.py health() と同じ形状 + served_by） */
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
      author: url.searchParams.get('author') ?? '',
      searchLayer: url.searchParams.get('search_layer') ?? '',
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

  // TS-FULL ステップ6: HTML ページ（admin.html ほか 5 ページ）
  if (handleStatic(req, res, parsed)) {
    return;
  }

  // リング1: 読み取り系 REST を TS がネイティブ応答
  if (handleNative(req, res, parsed)) {
    return;
  }

  // 書き込み系 REST・inbox・coremem・LLM・会話・インポート・管理・album/uploads・友達・OAuth・MCP の順に試し、
  // どれにも当たらなければ 404
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
      // TS-FULL ステップ7: 伏せ字の生成・承認（conversations REST より先に判定）
      if (await handleRedactRest(req, res, parsed)) return;
      // リング3: conversations REST（認証はハンドラ内。digest は上の handleLlmRest が先に処理）
      if (parsed.pathname.startsWith('/api/conversations')) {
        if (await handleConversations(req, res, parsed)) return;
      }
      // TS-FULL ステップ3: インポート一式・会話内アーティファクト（認証はハンドラ内）
      if (await handleImportRest(req, res, parsed)) return;
      if (handleConvArtifacts(req, res, parsed)) return;
      // TS-FULL ステップ4: 管理 REST（oplog・共有・projects・attendance・export/backup・旧検索・掃除系）
      if (await handleAdminRest(req, res, parsed)) return;
      // TS-FULL ステップ5: アルバム・アップロードの REST
      if (await handleMediaRest(req, res, parsed)) return;
      // TS-FULL ステップ6: 友達 REST（登録・承認・メール。友達の MCP セッションは mcp.ts）
      if (await handleFriendsRest(req, res, parsed)) return;
      if (await handleOAuth(req, res, parsed)) return;
      if (await handleMcp(req, res, parsed)) return;
      sendJson(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal Server Error', code: 500 }));
    }
  })();
});

// 起動時: 基本ディレクトリ（memory / artifacts / inbox / album）を用意し、旧形式のアップロードメタを
// {id}.meta.json へ退避、新規環境なら CoreMem に種をまく
for (const dir of [DATA_DIR, ARTIFACTS_DIR, path.join(DATA_ROOT, 'inbox'), path.join(DATA_ROOT, 'album')]) {
  fs.mkdirSync(dir, { recursive: true });
}
const migrated = migrateAllMeta();
if (migrated > 0) logInfo(`uploads: migrated ${migrated} legacy meta file(s)`);
seedCoreMemIfEmpty();

server.listen(PORT, BIND, () => {
  console.log(`mio-memory v${VERSION}: listening on ${BIND}:${PORT}`);
  logInfo(`nightly batch scheduler: hour=${process.env.MIO_NIGHTLY_BATCH_HOUR ?? '3'} ` +
    `backend=${process.env.MIO_NIGHTLY_BATCH_BACKEND || 'lmstudio'}`);
});
startNightlyScheduler();
