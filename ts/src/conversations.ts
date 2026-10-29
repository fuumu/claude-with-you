/**
 * TS-1 リング3 / TS-FULL ステップ3: 会話ログ REST（/api/conversations*・/api/conv-artifacts*）。
 * main.py の api_conversations_search / index / index_rebuild / cleanup_empty / get /
 * annotations / share / view / rating / title / conv_artifacts と同一契約（v3.99）。
 * digest は rest-llm.ts、redact は TS-FULL ステップ7。
 *
 * ステップ3 で v3.70 以降に Python 側だけ進んでいた差を揃えた: 検索の AND 化（v3.81）・
 * individual フィルタ（v3.96）・一覧の hidden 除外と include_hidden（v3.79）・rating 変更の oplog。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { extractBearer, verifyToken } from './auth.js';
import {
  CONV_ARTIFACTS_DIR,
  extractModelFromConv,
  extractParticipants,
  improveConvTitle,
  isDefaultTitle,
  loadConvArtifactsIndex,
  msgText,
} from './conv-import.js';
import { ConvMeta, CONVERSATIONS_DIR, DATA_DIR, DATA_ROOT, loadAllEntries, loadConvIndex } from './data.js';
import { readBodyText as readRequestBody } from './http-body.js';
import { logError, logInfo } from './llm.js';
import { cpSlice, isDict, pyGet, pyOr, pyStr, pyStrip, pyTruthy } from './py-compat.js';
import { allTermsIn, queryTerms } from './search.js';
import { bodyMatchTerms, individualMatch } from './tools-conversation.js';
import { appendOplog, jstIsoFromMs, nowJst, rebuildIndex } from './write.js';

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

function convRatingMatch(entry: ConvMeta, ratingFilter: string): boolean {
  const r = entry.rating || ((entry as Record<string, unknown>).rating_source ? 'safe' : '');
  if (ratingFilter === 'safe') return r === 'safe';
  return r === ratingFilter;
}

/** GET /api/conversations/ — 検索（q は空白区切りの AND / from / to / limit / body_search / individual / rating） */
function handleSearch(res: http.ServerResponse, url: URL): void {
  const terms = queryTerms((url.searchParams.get('q') ?? '').toLowerCase());
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(limitParam === null ? 20 : parseInt(limitParam, 10), 1200);
  const bodySearch = (url.searchParams.get('body_search') ?? 'false').toLowerCase() === 'true';
  const ratingFilter = url.searchParams.get('rating') ?? '';
  const individual = url.searchParams.get('individual') ?? '';

  let index = loadConvIndex();
  if (terms.length > 0 && !bodySearch) {
    index = index.filter((e) =>
      allTermsIn(terms, (String(e.title ?? '') + ' ' + String(e.uuid ?? '')).toLowerCase()),
    );
  }
  if (from) {
    index = index.filter((e) => sortKey(e) >= from);
  }
  if (to) {
    index = index.filter((e) => sortKey(e) <= to + 'T23:59:59');
  }
  if (ratingFilter) {
    index = index.filter((e) => convRatingMatch(e, ratingFilter));
  }
  if (terms.length > 0 && bodySearch) {
    index = index.filter((e) => bodyMatchTerms(e, terms));
  }
  if (individual) {
    index = index.filter((e) => individualMatch(e, individual));
  }
  sortDescByUpdated(index);
  sendJson(res, 200, index.slice(0, limit));
}

/** GET /api/conversations/index — タイトル一覧（search / limit / offset / include_hidden / individual / rating） */
function handleIndex(res: http.ServerResponse, url: URL): void {
  const search = (url.searchParams.get('search') ?? '').toLowerCase();
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const limit = Math.min(limitParam === null ? 50 : parseInt(limitParam, 10), 500);
  const offset = Math.max(offsetParam === null ? 0 : parseInt(offsetParam, 10), 0);
  const ratingFilter = url.searchParams.get('rating') ?? '';
  const includeHidden = ['true', '1'].includes((url.searchParams.get('include_hidden') ?? '').toLowerCase());
  const individual = url.searchParams.get('individual') ?? '';

  let index = loadConvIndex();
  if (!includeHidden) {
    index = index.filter((e) => !e.hidden);
  }
  if (search) {
    index = index.filter((e) =>
      (String(e.title ?? '') + ' ' + String(e.uuid ?? '')).toLowerCase().includes(search),
    );
  }
  if (individual) {
    index = index.filter((e) => individualMatch(e, individual));
  }
  if (ratingFilter) {
    index = index.filter((e) => convRatingMatch(e, ratingFilter));
  }
  sortDescByUpdated(index);
  sendJson(res, 200, {
    total: index.length,
    offset,
    limit,
    items: index.slice(offset, offset + limit),
  });
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
  const reason = String(data.rating_reason ?? '');
  let source = String(data.rating_source ?? 'manual');
  if (source !== 'manual' && source !== 'auto') source = 'manual';
  const judgedAt = jstIsoFromMs(Date.now());
  const fpath = convPath(uuid);
  const conv = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
  if (rating === 'safe') {
    delete conv.rating;
  } else {
    conv.rating = rating;
  }
  conv.rating_reason = reason;
  conv.rating_source = source;
  conv.rating_judged_at = judgedAt;
  delete conv.rating_skip_reason;
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
      m.rating_reason = reason;
      m.rating_source = source;
      delete m.rating_skip_reason;
    }
  }
  saveConvIndex(index);
  logInfo(`conversation rating: ${uuid} -> ${rating} (source=${source})`);
  appendOplog('conv_rating', uuid, null, { uuid, rating, source, reason });
  sendJson(res, 200, { uuid, rating: rating !== 'safe' ? rating : null,
    rating_reason: reason, rating_source: source });
}

/**
 * POST /api/conversations/index/rebuild — 会話ファイルから _index.json を作り直す（main.py v3.99）。
 * model の補完（v3.85）・既定タイトルの自動改善（v3.96）・participants（v3.96）は会話ファイルにも書き戻す。
 * hidden は会話ファイルに無いので旧インデックスから引き継ぐ（v3.79）。
 * main.py との差: {uuid}_digest*.json・{uuid}_redacted.json のキャッシュは会話として数えない
 * （main.py はこれも会話として読み、model を書き込んだうえで重複エントリを作っていた）
 */
function handleIndexRebuild(res: http.ServerResponse): void {
  let rebuilt = 0;
  let modelBackfilled = 0;
  let titlesImproved = 0;
  let titlesDefault = 0;
  let titlesNoAuto = 0;
  const debugNoAuto: Record<string, unknown>[] = [];
  const newIndex: ConvMeta[] = [];
  const oldIndex = new Map(loadConvIndex().map((e) => [e.uuid, e]));
  let files: string[] = [];
  try {
    files = fs.readdirSync(CONVERSATIONS_DIR);
  } catch {
    files = [];
  }
  for (const fname of files) {
    if (!fname.endsWith('.json') || fname.startsWith('_')) continue;
    if (/_(digest|digest_safe|redacted)\.json$/.test(fname)) continue;
    const fpath = path.join(CONVERSATIONS_DIR, fname);
    let conv: Record<string, unknown>;
    try {
      conv = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
      if (!isDict(conv)) continue;
    } catch {
      continue;
    }
    const uidRaw = pyOr(conv.uuid, pyGet(conv, 'id', ''));
    const uid = pyTruthy(uidRaw) ? String(uidRaw) : fname.slice(0, -5);
    if (!pyTruthy(conv.model)) {
      const extracted = extractModelFromConv(conv);
      if (extracted) {
        conv.model = extracted;
        try {
          writeJson(fpath, conv);
        } catch {
          /* main.py と同じく書き戻し失敗は無視 */
        }
        modelBackfilled++;
      }
    }
    let title = pyStr(pyOr(conv.name, conv.title, cpSlice(uid, 8)));
    let dirty = false;
    const improved = improveConvTitle(conv);
    if (isDefaultTitle(title)) {
      titlesDefault++;
      if (!improved) {
        titlesNoAuto++;
        let firstUser: Record<string, unknown> | null = null;
        for (const m of (Array.isArray(conv.chat_messages) ? conv.chat_messages : []).slice(0, 5)) {
          if (!isDict(m)) continue;
          const r = pyOr(m.sender, m.role, '');
          if (r === 'human' || r === 'user') {
            firstUser = { role: r, text_preview: cpSlice(msgText(m), 60), keys: Object.keys(m).slice(0, 8) };
            break;
          }
        }
        if (debugNoAuto.length < 10) {
          debugNoAuto.push({
            uuid: cpSlice(uid, 8),
            name: pyGet(conv, 'name', null),
            title_field: pyGet(conv, 'title', null),
            msgs: Array.isArray(conv.chat_messages) ? conv.chat_messages.length : 0,
            first_user: firstUser,
          });
        }
        logInfo(`rebuild: default title but no auto: ${cpSlice(uid, 8)}`);
      }
    }
    if (improved) {
      title = improved;
      titlesImproved++;
      if (pyTruthy(conv.name)) conv.name = improved;
      else conv.title = improved;
      dirty = true;
    }
    const participants = extractParticipants(conv);
    if (participants.length > 0 && JSON.stringify(conv.participants) !== JSON.stringify(participants)) {
      conv.participants = participants;
      dirty = true;
    }
    if (dirty) {
      try {
        writeJson(fpath, conv);
      } catch (e) {
        logError(`rebuild: failed to write back ${cpSlice(uid, 8)}: ${(e as Error).message}`);
      }
    }
    const meta: ConvMeta = {
      uuid: uid,
      title,
      created_at: pyGet(conv, 'created_at', '') as string,
      updated_at: pyGet(conv, 'updated_at', pyGet(conv, 'created_at', '')) as string,
      message_count: Array.isArray(conv.chat_messages) ? conv.chat_messages.length : 0,
    };
    if (participants.length > 0) meta.participants = participants;
    for (const k of ['rating', 'rating_reason', 'rating_source', 'rating_skip_reason', 'model', 'source']) {
      if (pyTruthy(conv[k])) meta[k] = conv[k];
    }
    if (oldIndex.get(uid)?.hidden) meta.hidden = true;
    newIndex.push(meta);
    rebuilt++;
  }
  sortDescByUpdated(newIndex);
  saveConvIndex(newIndex);
  const participantsFilled = newIndex.filter((e) => pyTruthy(e.participants)).length;
  logInfo(`conversations_index_rebuild: rebuilt=${rebuilt} model_backfilled=${modelBackfilled} ` +
    `titles_improved=${titlesImproved} titles_default=${titlesDefault} titles_no_auto=${titlesNoAuto} ` +
    `participants_filled=${participantsFilled}`);
  const result: Record<string, unknown> = {
    rebuilt,
    model_backfilled: modelBackfilled,
    titles_improved: titlesImproved,
    titles_default: titlesDefault,
    titles_no_auto: titlesNoAuto,
    participants_filled: participantsFilled,
  };
  if (debugNoAuto.length > 0) result.debug_no_auto = debugNoAuto;
  sendJson(res, 200, result);
}

/**
 * POST /api/conversations/cleanup-empty — 空ログを hidden にする（main.py v3.79）。
 * rating_skip_reason が no_text / empty で、タイトルが hex 8 文字だけのもの。dry_run なら変えない
 */
async function handleCleanupEmpty(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // main.py は受け取った dry_run の値をそのまま返し、真偽は Python の判定で見る
  let dryRun: unknown = false;
  if (/application\/json/i.test(String(req.headers['content-type'] ?? ''))) {
    try {
      const d = JSON.parse(await readRequestBody(req)) as unknown;
      dryRun = pyGet(d, 'dry_run', false);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }
  }
  const index = loadConvIndex();
  const actions: Record<string, unknown>[] = [];
  for (const e of index) {
    if (e.hidden) continue;
    const skipReason = pyGet(e, 'rating_skip_reason', '');
    const title = pyGet(e, 'title', '');
    if (skipReason !== 'no_text' && skipReason !== 'empty') continue;
    if (typeof title !== 'string' || !/^[0-9a-f]{8}$/.test(title)) continue;
    actions.push({ uuid: pyGet(e, 'uuid', ''), title, skip_reason: skipReason });
    if (!pyTruthy(dryRun)) e.hidden = true;
  }
  if (!pyTruthy(dryRun) && actions.length > 0) {
    saveConvIndex(index);
    logInfo(`conversations cleanup-empty: hidden ${actions.length} entries`);
  }
  sendJson(res, 200, { dry_run: dryRun, hidden_count: actions.length, entries: actions.slice(0, 50),
    total_matched: actions.length });
}

/**
 * PATCH /api/conversations/<uuid>/title — タイトル変更（main.py v3.96）。
 * 会話ファイル・_index.json・対応する「[会話] …」の ExtMemory エントリを同時に更新する
 */
async function handleTitle(req: http.IncomingMessage, res: http.ServerResponse, uuid: string): Promise<void> {
  if (!safeUuid(uuid) || !fs.existsSync(convPath(uuid))) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  let data: unknown = {};
  try {
    data = JSON.parse(await readRequestBody(req));
  } catch {
    data = {};
  }
  const raw = pyGet(data, 'title', '');
  const newTitle = pyStrip(pyTruthy(raw) ? pyStr(raw) : '');
  if (!newTitle) {
    sendJson(res, 400, { error: 'title is required' });
    return;
  }
  const fpath = convPath(uuid);
  const conv = JSON.parse(fs.readFileSync(fpath, 'utf-8')) as Record<string, unknown>;
  const oldTitle = pyStr(pyOr(conv.name, conv.title, ''));
  conv.name = newTitle;
  if ('title' in conv) conv.title = newTitle;
  writeJson(fpath, conv);
  const index = loadConvIndex();
  for (const m of index) if (m.uuid === uuid) m.title = newTitle;
  saveConvIndex(index);
  for (const entry of loadAllEntries()) {
    if (entry.source_thread === uuid && !entry.deleted && String(entry.title ?? '').startsWith('[会話] ')) {
      entry.title = `[会話] ${newTitle}`;
      entry.updated_at = nowJst();
      writeJson(path.join(DATA_DIR, `${entry.id}.json`), entry);
    }
  }
  rebuildIndex();
  logInfo(`conversation title: ${uuid} "${oldTitle}" -> "${newTitle}"`);
  sendJson(res, 200, { uuid, title: newTitle, old_title: oldTitle });
}

/**
 * GET /api/conv-artifacts（q は AND 検索）・GET /api/conv-artifacts/<uuid>/<path> — インポート時に
 * 会話の tool_use から取り出したファイル（main.py と同一契約）。
 * main.py との差: ファイルのパスは conv_artifacts の外を指せない（main.py は .. を通していた）
 */
export function handleConvArtifacts(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const p = url.pathname;
  if (req.method !== 'GET' || !(p === '/api/conv-artifacts' || p.startsWith('/api/conv-artifacts/'))) return false;
  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  if (p === '/api/conv-artifacts') {
    const terms = queryTerms((url.searchParams.get('q') ?? '').toLowerCase());
    let index = loadConvArtifactsIndex();
    if (terms.length > 0) {
      index = index.filter((e) =>
        allTermsIn(terms, `${pyStr(pyGet(e, 'filename', ''))} ${pyStr(pyGet(e, 'conv_name', ''))}`.toLowerCase()));
    }
    sendJson(res, 200, index);
    return true;
  }
  const m = /^\/api\/conv-artifacts\/([^/]+)\/(.+)$/.exec(p);
  if (!m) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  let convUuid: string;
  let filename: string;
  try {
    convUuid = decodeURIComponent(m[1]);
    filename = m[2].split('/').map(decodeURIComponent).join('/');
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  const base = path.resolve(CONV_ARTIFACTS_DIR);
  const fpath = path.resolve(base, convUuid, filename);
  if (!fpath.startsWith(base + path.sep) || !fs.existsSync(fpath) || !fs.statSync(fpath).isFile()) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  sendJson(res, 200, { conv_uuid: convUuid, filename, content: fs.readFileSync(fpath, 'utf-8') });
  return true;
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
    route = { handle: () => handleIndexRebuild(res) };
  } else if (p === '/api/conversations/cleanup-empty' && method === 'POST') {
    route = { handle: () => handleCleanupEmpty(req, res) };
  } else {
    const share = /^\/api\/conversations\/share\/([^/]+)$/.exec(p);
    const annotations = /^\/api\/conversations\/([^/]+)\/annotations$/.exec(p);
    const rating = /^\/api\/conversations\/([^/]+)\/rating$/.exec(p);
    const title = /^\/api\/conversations\/([^/]+)\/title$/.exec(p);
    const single = /^\/api\/conversations\/([^/]+)$/.exec(p);
    if (title && method === 'PATCH') {
      route = { handle: () => handleTitle(req, res, decodeURIComponent(title[1])) };
    } else if (share && method === 'POST') {
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
    } else if (single && method === 'GET' && single[1] !== 'index' && single[1] !== 'view' && single[1] !== 'redact-status') {
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
