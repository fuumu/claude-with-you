/**
 * TS-1 リング2: 書き込み系 REST（create/patch/delete/reindex）。
 * main.py の create_entry / update_entry / delete_entry / rebuild_index /
 * append_oplog と同一契約（ID採番・JSON形状・indent=2・oplog形式・論理削除）。
 *
 * 排他方針: /data/ の JSON は「最後に書いた者が勝つ」read-modify-write。
 * テスト構成ではリクエストは逐次なので競合しない。本番で TS を前段に
 * 入れる際は、REST 書き込みは TS・MCP tools/call は Python（転送先）という
 * 分担になるため、index.json / oplog.json の再構築が交互に走っても
 * 両実装が同一アルゴリズムなので結果は収束する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DATA_ROOT, INDEX_FILE, loadAllEntries, MemoryEntry } from './data.js';
import { extractLayer3 } from './search.js';

export const OPLOG_FILE = path.join(DATA_ROOT, 'oplog.json');

/** UNIXミリ秒を Python datetime.isoformat()（JST）互換文字列にする */
export function jstIsoFromMs(ms: number): string {
  const d = new Date(ms + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const micro = String(d.getUTCMilliseconds()).padStart(3, '0') + '000';
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${micro}+09:00`
  );
}

/** Python now_jst()（datetime.now(JST).isoformat()）互換の JST タイムスタンプ */
export function nowJst(): string {
  return jstIsoFromMs(Date.now());
}

/** Python strftime('%Y%m%d_%H%M%S')（JST）互換 */
function jstStamp(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/** Python json.dump(..., ensure_ascii=False, indent=2) 互換の書き込み */
function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function entryPath(id: string): string | null {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  return path.join(DATA_DIR, `${id}.json`);
}

/** main.py rebuild_index() と同一の index.json 再構築 */
export function rebuildIndex(): void {
  const entries = loadAllEntries();
  const index: Record<string, unknown>[] = [];
  for (const e of entries) {
    if (e.deleted) continue;
    const item: Record<string, unknown> = {
      id: e.id,
      title: e.title ?? '',
      tags: e.tags ?? [],
      created_at: e.created_at ?? '',
      importance: e.importance ?? 'normal',
      deleted: e.deleted ?? false,
    };
    if ('keywords' in e) item.keywords = e.keywords ?? [];
    const symbolic = extractLayer3(String(e.body ?? ''));
    if (symbolic) item.symbolic = symbolic;
    if (e.rating && e.rating !== 'safe') item.rating = e.rating;
    if (e.local_only) item.local_only = true;
    index.push(item);
  }
  writeJson(INDEX_FILE, index);
}

/** main.py append_oplog() と同一形式の追記 */
export function appendOplog(
  operation: string,
  entryId: string,
  before: MemoryEntry | null,
  after: MemoryEntry,
): void {
  let oplog: unknown[] = [];
  try {
    oplog = JSON.parse(fs.readFileSync(OPLOG_FILE, 'utf-8')) as unknown[];
  } catch {
    oplog = [];
  }
  oplog.push({
    timestamp: nowJst(),
    operation,
    entry_id: entryId,
    author: 'mio',
    diff: { before, after },
  });
  writeJson(OPLOG_FILE, oplog);
}

/** POST /api/memory — 作成。title 必須（無ければ null = 400） */
export function createEntry(data: Record<string, unknown>): MemoryEntry | null {
  if (!data || !data.title) return null;
  const tags = Array.isArray(data.tags) ? (data.tags as string[]) : [];
  const tagSlug = tags.length > 0 ? String(tags[0] ?? '').replace(/ /g, '_').slice(0, 20) : 'note';
  const entryId = `${jstStamp()}_${tagSlug}`;
  const now = nowJst();
  const entry: MemoryEntry = {
    id: entryId,
    created_at: now,
    updated_at: now,
    title: String(data.title ?? ''),
    body: String(data.body ?? ''),
    tags,
    source_thread: String(data.source_thread ?? ''),
    importance: String(data.importance ?? 'normal'),
    author: 'mio',
    deleted: false,
  };
  writeJson(path.join(DATA_DIR, `${entryId}.json`), entry);
  appendOplog('create', entryId, null, entry);
  rebuildIndex();
  return entry;
}

/** PATCH /api/memory/<id> — 部分更新。無ければ null = 404 */
export function updateEntry(id: string, data: Record<string, unknown>): MemoryEntry | null {
  const p = entryPath(id);
  if (!p || !fs.existsSync(p)) return null;
  const entry = JSON.parse(fs.readFileSync(p, 'utf-8')) as MemoryEntry;
  const before = { ...entry };
  for (const key of ['title', 'body', 'tags', 'source_thread', 'importance', 'keywords']) {
    if (key in data) {
      // tags/keywords は null を空配列に正規化（main.py v3.24 と同じ）
      entry[key] =
        key === 'tags' || key === 'keywords' ? ((data[key] ?? []) as string[]) : data[key];
    }
  }
  entry.updated_at = nowJst();
  writeJson(p, entry);
  appendOplog('update', id, before, entry);
  rebuildIndex();
  return entry;
}

/** DELETE /api/memory/<id> — 論理削除。無ければ null = 404 */
export function deleteEntry(id: string): boolean {
  const p = entryPath(id);
  if (!p || !fs.existsSync(p)) return false;
  const entry = JSON.parse(fs.readFileSync(p, 'utf-8')) as MemoryEntry;
  const before = { ...entry };
  entry.deleted = true;
  entry.updated_at = nowJst();
  writeJson(p, entry);
  appendOplog('delete', id, before, entry);
  rebuildIndex();
  return true;
}

/** POST /api/memory/reindex — 全再構築して非削除件数を返す */
export function reindexAll(): number {
  rebuildIndex();
  try {
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')) as { deleted?: boolean }[];
    return index.filter((e) => !e.deleted).length;
  } catch {
    return 0;
  }
}
