/**
 * TS-FULL ステップ4: 管理 REST（main.py と同一契約）。
 *   GET    /api/memory/search          旧キーワード検索（admin.html・logs.html が使う。空白区切り AND）
 *   POST   /api/memory/dedup-scan      同じ source_thread の重複エントリを論理削除（dry_run 可）
 *   POST   /api/memory/cleanup-empty   空の「[会話] hex8」要約エントリを論理削除（dry_run 可）
 *   GET    /api/oplog                  操作ログ全件　DELETE /api/oplog/<index>
 *   POST   /api/share-token            記憶の共有トークン（{entry_id}）
 *   POST   /api/memory/share/<id>      同上（admin.html 新形式）
 *   GET    /api/share/<token>          共有された記憶（認証不要・期限切れは 410）
 *   GET    /api/projects               プロジェクト一覧
 *   GET    /api/attendance             出席簿
 *   GET    /api/export                 CoreMem（最新版）＋ ExtMemory のバックアップ ZIP
 *   POST   /api/import/backup          export ZIP からの復元（mode=skip/overwrite・dry_run）
 * /api/share/<token> 以外は Bearer 認証。
 *
 * 廃止（TS-FULL ステップ4・移植しない）: 旧パス埋め込みトークン API（/api/<token>/memory/...）、
 * GET /api/memories/symbolic。
 * main.py との差（意図的）: 会話・アルバムの共有トークンを /api/share/<token> に渡すと 404（main.py は 500）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { attendanceView } from './attendance-view.js';
import { extractBearer, verifyToken } from './auth.js';
import { artifactsList, artifactsRead, artifactsSave, validateArtifactName } from './coremem.js';
import { DATA_DIR, DATA_ROOT, INDEX_FILE, loadAllEntries, MemoryEntry } from './data.js';
import { readBodyBuffer, readBodyText } from './http-body.js';
import { parseMultipart } from './multipart.js';
import { cpLen, isDict, Json, pyGet, pyTruthy } from './py-compat.js';
import { allTermsIn, queryTerms } from './search.js';
import { listProjects } from './tools-project.js';
import { VERSION } from './version.js';
import { appendOplog, jstIsoFromMs, jstStamp, nowJst, OPLOG_FILE, rebuildIndex, writeJson } from './write.js';
import { buildZip, listZipEntries, ZipEntry, zipEntryData } from './zip.js';

const SHARE_TOKENS_FILE = path.join(DATA_ROOT, 'share_tokens.json');
const BASE_URL = process.env.MIO_BASE_URL ?? 'http://localhost:5002';
const EMPTY_CONV_TITLE_RE = /^\[会話\] [0-9a-f]{8}$/;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** Python の list[start:] / list[:end]（負の値は末尾から） */
function pySlice<T>(a: T[], start?: number, end?: number): T[] {
  const norm = (i: number) => (i < 0 ? Math.max(a.length + i, 0) : Math.min(i, a.length));
  return a.slice(start === undefined ? 0 : norm(start), end === undefined ? a.length : norm(end));
}

/** ?limit= 等の整数パラメータ（Python の int()。不正なら null） */
function intParam(url: URL, key: string, dflt: number): number | null {
  const v = url.searchParams.get(key);
  if (v === null) return dflt;
  return /^\s*[+-]?\d+\s*$/.test(v) ? parseInt(v, 10) : null;
}

/** JSON ボディの dry_run（main.py: request.json.get('dry_run', False) if request.is_json else False） */
async function dryRunOf(req: http.IncomingMessage): Promise<{ ok: boolean; value: unknown }> {
  if (!/application\/json/i.test(String(req.headers['content-type'] ?? ''))) return { ok: true, value: false };
  try {
    return { ok: true, value: pyGet(JSON.parse(await readBodyText(req)), 'dry_run', false) };
  } catch {
    return { ok: false, value: false };
  }
}

function entryFile(id: string): string | null {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0')) return null;
  return path.join(DATA_DIR, `${id}.json`);
}

function markDeleted(e: MemoryEntry): boolean {
  const p = entryFile(e.id);
  if (!p || !fs.existsSync(p)) return false;
  e.deleted = true;
  e.updated_at = nowJst();
  writeJson(p, e);
  return true;
}

// ── 記憶の管理系 ─────────────────────────────────────────────────────

function oldSearch(url: URL): [number, unknown] {
  const terms = queryTerms((url.searchParams.get('q') ?? '').toLowerCase());
  const limit = intParam(url, 'limit', 0);
  const offset = intParam(url, 'offset', 0);
  if (limit === null || offset === null) return [400, { error: 'invalid limit/offset' }];
  if (terms.length === 0) return [200, []];
  let results = loadAllEntries().filter((e) => {
    if (e.deleted) return false;
    const tags = Array.isArray(e.tags) ? e.tags.join(' ') : '';
    const text = (`${e.id ?? ''} ` + String(e.title || '') + String(e.body || '') + tags).toLowerCase();
    return allTermsIn(terms, text);
  });
  if (offset) results = pySlice(results, offset);
  if (limit) results = pySlice(results, undefined, limit);
  return [200, results];
}

function dedupScan(dryRun: unknown): Json {
  const byThread = new Map<string, MemoryEntry[]>();
  for (const e of loadAllEntries()) {
    if (e.deleted || !e.source_thread) continue;
    const list = byThread.get(String(e.source_thread)) ?? [];
    list.push(e);
    byThread.set(String(e.source_thread), list);
  }
  const duplicates = [...byThread.entries()].filter(([, g]) => g.length > 1);
  // main.py _richness: (要約層あり, 本文の長さ, importance) の降順。同点は元の順（安定ソート）
  const richness = (e: MemoryEntry): [number, number, string] => {
    const body = String(e.body ?? '');
    return [body.includes('## layer-2') || body.includes('## layer-3') ? 1 : 0, cpLen(body), String(e.importance ?? '')];
  };
  const cmp = (a: MemoryEntry, b: MemoryEntry) => {
    const ra = richness(a);
    const rb = richness(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? 1 : -1;
    return 0;
  };
  const actions: Json[] = [];
  for (const [st, group] of duplicates) {
    group.sort(cmp);
    const keep = group[0];
    for (const victim of group.slice(1)) {
      actions.push({
        source_thread: st,
        keep_id: keep.id,
        delete_id: victim.id,
        keep_body_len: cpLen(String(keep.body ?? '')),
        delete_body_len: cpLen(String(victim.body ?? '')),
      });
      if (!pyTruthy(dryRun) && markDeleted(victim)) {
        appendOplog('dedup_delete', victim.id, null, { reason: 'source_thread_duplicate', kept: keep.id });
      }
    }
  }
  if (!pyTruthy(dryRun) && actions.length > 0) rebuildIndex();
  return { dry_run: dryRun, duplicate_threads: duplicates.length, deleted_count: actions.length, actions };
}

function cleanupEmpty(dryRun: unknown): Json {
  const actions: Json[] = [];
  for (const e of loadAllEntries()) {
    if (e.deleted) continue;
    const title = pyGet(e, 'title', '');
    const tags = Array.isArray(e.tags) ? e.tags : [];
    if (typeof title !== 'string' || !EMPTY_CONV_TITLE_RE.test(title) || !tags.includes('会話ログ') ||
      !tags.includes('summarized') || pyGet(e, 'importance', '') !== 'low') {
      continue;
    }
    actions.push({ id: e.id, title });
    if (!pyTruthy(dryRun) && markDeleted(e)) {
      appendOplog('cleanup_empty_delete', e.id, null, { reason: 'empty_summary_entry', title });
    }
  }
  if (!pyTruthy(dryRun) && actions.length > 0) rebuildIndex();
  return { dry_run: dryRun, deleted_count: actions.length, entries: actions };
}

// ── 共有トークン ─────────────────────────────────────────────────────

type ShareTokens = Record<string, Json>;

function issueShareToken(entryId: string, expiresIn: number): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = jstIsoFromMs(Date.now() + expiresIn * 1000);
  const tokens = readJsonFile<ShareTokens>(SHARE_TOKENS_FILE, {});
  tokens[token] = { entry_id: entryId, expires_at: expiresAt };
  writeJson(SHARE_TOKENS_FILE, tokens);
  return { token, expiresAt };
}

function expiresInOf(data: unknown): number | null {
  const v = pyGet(data, 'expires_in', 86400);
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v) ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function sharedEntry(token: string): [number, unknown] {
  const info = readJsonFile<ShareTokens>(SHARE_TOKENS_FILE, {})[token];
  if (!info) return [404, { error: 'not found' }];
  const exp = Date.parse(String(info.expires_at));
  if (Number.isFinite(exp) && Date.now() > exp) return [410, { error: 'expired' }];
  const p = typeof info.entry_id === 'string' ? entryFile(info.entry_id) : null;
  if (!p || !fs.existsSync(p)) return [404, { error: 'not found' }];
  return [200, JSON.parse(fs.readFileSync(p, 'utf-8'))];
}

// ── バックアップ ─────────────────────────────────────────────────────

function exportZip(): Buffer {
  const files: { name: string; data: Buffer }[] = [];
  let nMem = 0;
  let nCore = 0;
  if (fs.existsSync(INDEX_FILE)) files.push({ name: 'extmemory/index.json', data: fs.readFileSync(INDEX_FILE) });
  if (fs.existsSync(DATA_DIR)) {
    for (const fn of fs.readdirSync(DATA_DIR).sort()) {
      if (!fn.endsWith('.json')) continue;
      files.push({ name: `extmemory/memory/${fn}`, data: fs.readFileSync(path.join(DATA_DIR, fn)) });
      nMem++;
    }
  }
  for (const item of artifactsList()) {
    const name = String(item.name);
    const r = artifactsRead(name, null);
    if (typeof r.content === 'string') {
      files.push({ name: `coremem/${name}`, data: Buffer.from(r.content, 'utf-8') });
      nCore++;
    }
  }
  const meta = {
    exported_at: nowJst(),
    server_version: VERSION,
    extmemory_count: nMem,
    coremem_count: nCore,
    note: 'CoreMem は最新版本文のスナップショット（版履歴なし）。復元は各 name で CoreMem_save、ExtMemory は memory/*.json を /data/memory/ に配置し reindex。',
  };
  files.push({ name: 'export_meta.json', data: Buffer.from(JSON.stringify(meta, null, 2), 'utf-8') });
  return buildZip(files);
}

function importBackup(buf: Buffer, modeRaw: string, dryRun: boolean): [number, unknown] {
  const mode = modeRaw.toLowerCase();
  if (mode !== 'skip' && mode !== 'overwrite') return [400, { error: "mode must be 'skip' or 'overwrite'" }];
  const result: Json = {
    mode,
    dry_run: dryRun,
    memory: { restored: 0, skipped: 0, overwritten: 0 },
    coremem: { restored: 0, skipped: 0, overwritten: 0 },
    conflicts: [] as string[],
    errors: [] as string[],
  };
  const mem = result.memory as Record<string, number>;
  const core = result.coremem as Record<string, number>;
  const conflicts = result.conflicts as string[];
  const errors = result.errors as string[];
  let entries: ZipEntry[];
  try {
    entries = listZipEntries(buf);
  } catch {
    return [400, { error: 'valid zip file required' }];
  }
  const names = entries.map((e) => e.name);
  if (!names.some((n) => n.startsWith('extmemory/') || n.startsWith('coremem/'))) {
    return [400, { error: 'not an export zip (no extmemory/ or coremem/)' }];
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const metaEntry = byName.get('export_meta.json');
  if (metaEntry) {
    try {
      result.export_meta = JSON.parse(zipEntryData(buf, metaEntry).toString('utf-8'));
    } catch {
      /* main.py と同じく無視 */
    }
  }
  const sorted = [...names].sort();
  let memWritten = false;
  // ExtMemory（index.json は復元せず最後に作り直す）
  for (const n of sorted) {
    if (!(n.startsWith('extmemory/memory/') && n.endsWith('.json'))) continue;
    const fn = path.posix.basename(n);
    const entryId = fn.slice(0, -'.json'.length);
    let entry: unknown;
    try {
      entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(zipEntryData(buf, byName.get(n)!)));
    } catch {
      errors.push(`memory:${entryId}: parse error`);
      continue;
    }
    const dest = path.join(DATA_DIR, fn);
    const exists = fs.existsSync(dest);
    if (exists && mode === 'skip') {
      mem.skipped++;
      conflicts.push(`memory:${entryId}`);
      continue;
    }
    if (!dryRun) {
      const before = exists ? readJsonFile<Json | null>(dest, null) : null;
      writeJson(dest, entry);
      appendOplog('restore', entryId, before, entry as Json);
      memWritten = true;
    }
    mem[exists ? 'overwritten' : 'restored']++;
  }
  // CoreMem（版管理で新しい版として積む。既存の版は壊さない）
  for (const n of sorted) {
    if (!n.startsWith('coremem/') || n.endsWith('/')) continue;
    const name = n.slice('coremem/'.length);
    if (!name || !validateArtifactName(name)) {
      errors.push(`coremem:${name}: invalid name`);
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(zipEntryData(buf, byName.get(n)!));
    } catch {
      errors.push(`coremem:${name}: read error`);
      continue;
    }
    const exists = typeof artifactsRead(name, null).content === 'string';
    if (exists && mode === 'skip') {
      core.skipped++;
      conflicts.push(`coremem:${name}`);
      continue;
    }
    if (!dryRun) artifactsSave(name, content);
    core[exists ? 'overwritten' : 'restored']++;
  }
  if (memWritten) rebuildIndex();
  return [200, result];
}

// ── ルーティング ─────────────────────────────────────────────────────

/** 管理 REST なら処理して true */
export async function handleAdminRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';

  // 認証不要の共有ビュー
  const shared = /^\/api\/share\/([^/]+)$/.exec(p);
  if (shared && method === 'GET') {
    const [status, body] = sharedEntry(decodeURIComponent(shared[1]));
    sendJson(res, status, body);
    return true;
  }

  const oplogDel = /^\/api\/oplog\/(\d+)$/.exec(p);
  const memShare = /^\/api\/memory\/share\/([^/]+)$/.exec(p);
  const routes: Record<string, boolean> = {
    search: p === '/api/memory/search' && method === 'GET',
    dedup: p === '/api/memory/dedup-scan' && method === 'POST',
    cleanup: p === '/api/memory/cleanup-empty' && method === 'POST',
    oplog: p === '/api/oplog' && method === 'GET',
    oplogDel: !!oplogDel && method === 'DELETE',
    shareToken: p === '/api/share-token' && method === 'POST',
    memShare: !!memShare && method === 'POST',
    projects: p === '/api/projects' && method === 'GET',
    attendance: p === '/api/attendance' && method === 'GET',
    export: p === '/api/export' && method === 'GET',
    backup: p === '/api/import/backup' && method === 'POST',
  };
  const route = Object.keys(routes).find((k) => routes[k]);
  if (!route) return false;
  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  switch (route) {
    case 'search': {
      const [status, body] = oldSearch(url);
      sendJson(res, status, body);
      return true;
    }
    case 'dedup':
    case 'cleanup': {
      const dr = await dryRunOf(req);
      if (!dr.ok) sendJson(res, 400, { error: 'invalid JSON' });
      else sendJson(res, 200, route === 'dedup' ? dedupScan(dr.value) : cleanupEmpty(dr.value));
      return true;
    }
    case 'oplog':
      sendJson(res, 200, readJsonFile<unknown[]>(OPLOG_FILE, []));
      return true;
    case 'oplogDel': {
      if (!fs.existsSync(OPLOG_FILE)) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const oplog = readJsonFile<unknown[]>(OPLOG_FILE, []);
      const index = parseInt(oplogDel![1], 10);
      if (index >= oplog.length) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const [removed] = oplog.splice(index, 1);
      writeJson(OPLOG_FILE, oplog);
      sendJson(res, 200, { status: 'deleted', removed });
      return true;
    }
    case 'shareToken':
    case 'memShare': {
      let data: unknown = {};
      try {
        data = JSON.parse(await readBodyText(req));
      } catch {
        data = route === 'shareToken' ? null : {};
      }
      const entryId = route === 'shareToken' ? pyGet(data, 'entry_id', null) : decodeURIComponent(memShare![1]);
      if (route === 'shareToken' && (!pyTruthy(data) || !isDict(data) || !('entry_id' in data))) {
        sendJson(res, 400, { error: 'entry_id is required' });
        return true;
      }
      const ep = typeof entryId === 'string' ? entryFile(entryId) : null;
      if (!ep || !fs.existsSync(ep)) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const expiresIn = expiresInOf(data);
      if (expiresIn === null) {
        sendJson(res, 400, { error: 'expires_in must be an integer' });
        return true;
      }
      const { token, expiresAt } = issueShareToken(entryId as string, expiresIn);
      if (route === 'shareToken') {
        sendJson(res, 200, { token, url: `${BASE_URL}/admin.html?id=${entryId}&token=${token}` });
      } else {
        sendJson(res, 200, { token, url: `${BASE_URL}/admin.html?token=${token}&id=${entryId}`, expires_at: expiresAt });
      }
      return true;
    }
    case 'projects':
      sendJson(res, 200, listProjects());
      return true;
    case 'attendance': {
      const limit = intParam(url, 'limit', 50);
      if (limit === null) {
        sendJson(res, 400, { error: 'invalid limit' });
        return true;
      }
      const kindRaw = url.searchParams.get('kind') ?? '';
      const kinds = kindRaw ? new Set(kindRaw.split(',').map((k) => k.trim()).filter(Boolean)) : null;
      sendJson(res, 200, attendanceView({
        individual: url.searchParams.get('individual') || null,
        dateFrom: url.searchParams.get('date_from') ?? '',
        dateTo: url.searchParams.get('date_to') ?? '',
        limit,
        kindFilter: kinds,
      }));
      return true;
    }
    case 'export': {
      const zip = exportZip();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename=mio_backup_${jstStamp()}.zip`,
        'Content-Length': zip.length,
      });
      res.end(zip);
      return true;
    }
    case 'backup': {
      const form = parseMultipart(await readBodyBuffer(req), req.headers['content-type']);
      const file = form?.files.file;
      if (!form || !file) {
        sendJson(res, 400, { error: 'file is required' });
        return true;
      }
      const [status, body] = importBackup(file.data, form.fields.mode ?? 'skip',
        (form.fields.dry_run ?? 'false').toLowerCase() === 'true');
      sendJson(res, status, body);
      return true;
    }
  }
  return false;
}
