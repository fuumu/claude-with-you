/**
 * TS-1 リング3: 会話ログ REST（/api/conversations*）。
 * main.py の api_conversations_search / index / index_rebuild / get /
 * annotations / share / view / rating と同一契約。
 *
 * digest（POST /api/conversations/<uuid>/digest）はローカルLLM連携が必要な
 * ためリング5まで Python 転送のまま（このモジュールは担当しない）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { extractBearer, verifyToken } from './auth.js';
import { ConvMeta, CONVERSATIONS_DIR, DATA_ROOT, loadConvIndex } from './data.js';
import { jstIsoFromMs } from './write.js';

const ANNOTATIONS_DIR = path.join(DATA_ROOT, 'annotations');
const SHARE_TOKENS_FILE = path.join(DATA_ROOT, 'share_tokens.json');
const BASE_URL = process.env.MIO_BASE_URL ?? 'http://localhost:5002';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** uuid セグメントの安全確認（Flask の <uuid> はスラッシュ不可。バックスラッシュ等も弾く） */
function safeUuid(uuid: string): boolean {
  return !!uuid && !uuid.includes('/') && !uuid.includes('\\') && !uuid.includes('..');
}

function convPath(uuid: string): string {
  return path.join(CONVERSATIONS_DIR, `${uuid}.json`);
}

function saveConvIndex(index: ConvMeta[]): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  writeJson(path.join(CONVERSATIONS_DIR, '_index.json'), index);
}

function loadShareTokens(): Record<string, { conv_uuid?: string; expires_at?: string; [key: string]: unknown }> {
  try {
    return JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** ソートキー: updated_at（空なら created_at）。main.py と同じ Python 的 or 判定 */
function sortKey(e: ConvMeta): string {
  return String(e.updated_at || e.created_at || '');
}

function sortDescByUpdated(index: ConvMeta[]): ConvMeta[] {
  return index.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return kb < ka ? -1 : kb > ka ? 1 : 0;
  });
}

/** チャットメッセージ本文の抽出（main.py の content/text フォールバックと同じ truthy 判定） */
function messageText(m: Record<string, unknown>): string {
  const content =
    (Array.isArray(m.content) ? (m.content.length > 0 ? m.content : null) : m.content) ||
    m.text ||
    '';
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text')
      .map((c) => String((c as { text?: string }).text ?? ''))
      .join(' ');
  }
  return String(content);
}

function convMatchesBody(entry: ConvMeta, q: string): boolean {
  if ((String(entry.title ?? '') + ' ' + String(entry.uuid ?? '')).toLowerCase().includes(q)) {
    return true;
  }
  const fpath = convPath(String(entry.uuid));
  if (!fs.existsSync(fpath)) return false;
  try {
    const conv = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
    for (const m of conv.chat_messages ?? []) {
      if (messageText(m).toLowerCase().includes(q)) return true;
    }
  } catch {
    /* 壊れたファイルは不一致扱い */
  }
  return false;
}

/** GET /api/conversations/ — 検索（q / from / to / limit / body_search） */
function handleSearch(res: http.ServerResponse, url: URL): void {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(limitParam === null ? 20 : parseInt(limitParam, 10), 1200);
  const bodySearch = (url.searchParams.get('body_search') ?? 'false').toLowerCase() === 'true';

  let index = loadConvIndex();
  if (q && !bodySearch) {
    index = index.filter((e) =>
      (String(e.title ?? '') + ' ' + String(e.uuid ?? '')).toLowerCase().includes(q),
    );
  }
  if (from) {
    index = index.filter((e) => sortKey(e) >= from);
  }
  if (to) {
    index = index.filter((e) => sortKey(e) <= to + 'T23:59:59');
  }
  if (q && bodySearch) {
    index = index.filter((e) => convMatchesBody(e, q));
  }
  sortDescByUpdated(index);
  sendJson(res, 200, index.slice(0, limit));
}

/** GET /api/conversations/index — タイトル一覧（search / limit / offset） */
function handleIndex(res: http.ServerResponse, url: URL): void {
  const search = (url.searchParams.get('search') ?? '').toLowerCase();
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const limit = Math.min(limitParam === null ? 50 : parseInt(limitParam, 10), 500);
  const offset = Math.max(offsetParam === null ? 0 : parseInt(offsetParam, 10), 0);

  let index = loadConvIndex();
  if (search) {
    index = index.filter((e) =>
      (String(e.title ?? '') + ' ' + String(e.uuid ?? '')).toLowerCase().includes(search),
    );
  }
  sortDescByUpdated(index);
  sendJson(res, 200, {
    total: index.length,
    offset,
    limit,
    items: index.slice(offset, offset + limit),
  });
}

/** POST /api/conversations/index/rebuild — 会話ファイル走査で _index.json を再構築 */
function handleRebuild(res: http.ServerResponse): void {
  let rebuilt = 0;
  const newIndex: ConvMeta[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(CONVERSATIONS_DIR);
  } catch {
    files = [];
  }
  for (const fname of files) {
    if (!fname.endsWith('.json') || fname.startsWith('_')) continue;
    let conv: Record<string, unknown>;
    try {
      conv = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, fname), 'utf-8'));
    } catch {
      continue;
    }
    let uid = String(conv.uuid || conv.id || '');
    if (!uid) uid = fname.slice(0, -5);
    newIndex.push({
      uuid: uid,
      title: String(conv.name || conv.title || uid.slice(0, 8)),
      created_at: 'created_at' in conv ? (conv.created_at as string) : '',
      updated_at:
        'updated_at' in conv
          ? (conv.updated_at as string)
          : 'created_at' in conv
            ? (conv.created_at as string)
            : '',
      message_count: Array.isArray(conv.chat_messages) ? conv.chat_messages.length : 0,
    });
    rebuilt += 1;
  }
  sortDescByUpdated(newIndex);
  saveConvIndex(newIndex);
  sendJson(res, 200, { rebuilt });
}

/** POST /api/conversations/share/<uuid> — 共有トークン発行（デフォルト24h） */
async function handleShare(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uuid: string,
): Promise<void> {
  if (!safeUuid(uuid) || !fs.existsSync(convPath(uuid))) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readRequestBody(req));
  } catch {
    data = {};
  }
  const expiresIn = Math.trunc(Number(data.expires_in ?? 86400));
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = jstIsoFromMs(Date.now() + expiresIn * 1000);
  const tokens = loadShareTokens();
  tokens[token] = { conv_uuid: uuid, expires_at: expiresAt };
  writeJson(SHARE_TOKENS_FILE, tokens);
  sendJson(res, 200, {
    token,
    url: `${BASE_URL}/share.html?token=${token}`,
    expires_at: expiresAt,
  });
}

/** GET /api/conversations/view?token= — 共有ビュー（認証不要） */
function handleView(res: http.ServerResponse, url: URL): void {
  const token = url.searchParams.get('token') ?? '';
  const tokens = loadShareTokens();
  const info = tokens[token];
  if (!info || !('conv_uuid' in info)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (Date.now() > Date.parse(String(info.expires_at))) {
    sendJson(res, 410, { error: 'expired' });
    return;
  }
  const fpath = convPath(String(info.conv_uuid));
  if (!fs.existsSync(fpath)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  sendJson(res, 200, JSON.parse(fs.readFileSync(fpath, 'utf-8')));
}

/** PATCH /api/conversations/<uuid>/rating — レーティング設定（v3.56） */
async function handleRating(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uuid: string,
): Promise<void> {
  if (!safeUuid(uuid) || !fs.existsSync(convPath(uuid))) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readRequestBody(req));
  } catch {
    data = {};
  }
  const rating = String(data.rating ?? '');
  if (!['safe', 'mature', 'adult'].includes(rating)) {
    sendJson(res, 400, { error: 'rating must be safe / mature / adult' });
    return;
  }
  const fpath = convPath(uuid);
  const conv = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
  if (rating === 'safe') {
    delete conv.rating;
  } else {
    conv.rating = rating;
  }
  writeJson(fpath, conv);
  // _index.json のメタにも反映
  const index = loadConvIndex();
  for (const m of index) {
    if (m.uuid === uuid) {
      if (rating === 'safe') {
        delete m.rating;
      } else {
        m.rating = rating;
      }
    }
  }
  saveConvIndex(index);
  sendJson(res, 200, { uuid, rating: rating !== 'safe' ? rating : null });
}

/**
 * /api/conversations* のルーティング。担当したら true、担当外
 * （digest・未対応メソッド等）は false = プロキシへ。
 * view 以外は Bearer 認証必須。
 */
export async function handleConversations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';

  // 認証不要の共有ビュー
  if (p === '/api/conversations/view') {
    if (method !== 'GET') return false;
    handleView(res, url);
    return true;
  }

  // ここから先は担当ルートか先に判定し、担当なら認証チェック
  type Route = { handle: () => Promise<void> | void };
  let route: Route | null = null;

  if (p === '/api/conversations/' && method === 'GET') {
    route = { handle: () => handleSearch(res, url) };
  } else if (p === '/api/conversations/index' && method === 'GET') {
    route = { handle: () => handleIndex(res, url) };
  } else if (p === '/api/conversations/index/rebuild' && method === 'POST') {
    route = { handle: () => handleRebuild(res) };
  } else {
    const share = /^\/api\/conversations\/share\/([^/]+)$/.exec(p);
    const annotations = /^\/api\/conversations\/([^/]+)\/annotations$/.exec(p);
    const rating = /^\/api\/conversations\/([^/]+)\/rating$/.exec(p);
    const single = /^\/api\/conversations\/([^/]+)$/.exec(p);
    if (share && method === 'POST') {
      route = { handle: () => handleShare(req, res, decodeURIComponent(share[1])) };
    } else if (annotations && method === 'GET') {
      route = {
        handle: () => {
          const uuid = decodeURIComponent(annotations[1]);
          let anns: unknown[] = [];
          if (safeUuid(uuid)) {
            try {
              anns = JSON.parse(
                fs.readFileSync(path.join(ANNOTATIONS_DIR, `${uuid}.json`), 'utf-8'),
              );
            } catch {
              anns = [];
            }
          }
          sendJson(res, 200, anns);
        },
      };
    } else if (rating && method === 'PATCH') {
      route = { handle: () => handleRating(req, res, decodeURIComponent(rating[1])) };
    } else if (single && method === 'GET' && single[1] !== 'index' && single[1] !== 'view') {
      route = {
        handle: () => {
          const uuid = decodeURIComponent(single[1]);
          if (!safeUuid(uuid) || !fs.existsSync(convPath(uuid))) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          sendJson(res, 200, JSON.parse(fs.readFileSync(convPath(uuid), 'utf-8')));
        },
      };
    }
  }

  if (route === null) return false; // digest 等はプロキシへ

  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  await route.handle();
  return true;
}
