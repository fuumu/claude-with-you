/**
 * データ層: /data/ 配下の JSON を Python 実装（main.py）と同一形式で読む。
 * リング1は読み取り専用（書き込みは Python に残る）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATA_ROOT = process.env.MIO_DATA_ROOT ?? '/data';
export const DATA_DIR = path.join(DATA_ROOT, 'memory');
export const INDEX_FILE = path.join(DATA_ROOT, 'index.json');
export const OAUTH_STORE = path.join(DATA_ROOT, 'oauth_store.json');
export const CONVERSATIONS_DIR = path.join(DATA_ROOT, 'conversations');

export interface IndexEntry {
  id: string;
  title?: string;
  tags?: string[];
  created_at?: string;
  importance?: string;
  deleted?: boolean;
  keywords?: string[];
  symbolic?: string;
  rating?: string;
  local_only?: boolean;
  [key: string]: unknown;
}

export interface MemoryEntry extends IndexEntry {
  body?: string;
  updated_at?: string;
  source_thread?: string;
}

export interface ConvMeta {
  uuid: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  message_count?: number;
  rating?: string;
  [key: string]: unknown;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** index.json を生のリストで読む（無ければ空）。deleted も含む */
export function loadIndexList(): IndexEntry[] {
  return readJson<IndexEntry[]>(INDEX_FILE, []);
}

/** 全エントリを created_at 降順で読む（main.py load_all_entries と同じ） */
export function loadAllEntries(): MemoryEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const f of files) {
    try {
      entries.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')));
    } catch {
      /* 壊れたファイルはスキップ */
    }
  }
  entries.sort((a, b) => ((a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1));
  return entries;
}

/** ID 指定で1エントリ読む。無ければ null */
export function loadEntry(id: string): MemoryEntry | null {
  // パストラバーサル防止（Python 側は Flask のルーティングが '/' を弾く）
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  const p = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return readJson<MemoryEntry | null>(p, null);
}

/** 会話ログの _index.json を読む（無ければ空） */
export function loadConvIndex(): ConvMeta[] {
  return readJson<ConvMeta[]>(path.join(CONVERSATIONS_DIR, '_index.json'), []);
}
