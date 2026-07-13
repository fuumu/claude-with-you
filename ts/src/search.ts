/**
 * 階層検索: main.py の _hierarchical_search と同一契約（docs/api-contract.ja.md §3）。
 * 1次=インデックス（title+tags+keywords → 3層symbolic）→ 2次=2層要約 → 3次=全文。
 * include_conversations=true で会話タイトル検索を併載（統合検索・v3.61）。
 */
import {
  IndexEntry,
  MemoryEntry,
  loadAllEntries,
  loadConvIndex,
  loadEntry,
  loadIndexList,
} from './data.js';

const SUMMARY_MARKER = '## 2層: 要約';
const LAYER3_MARKER = '## 3層:';

export function queryTerms(q: string): string[] {
  return (q ?? '')
    .toLowerCase()
    .split(/[\s　]+/)
    .filter((t) => t.length > 0);
}

export function allTermsIn(terms: string[], text: string): boolean {
  return terms.length > 0 && terms.every((t) => text.includes(t));
}

export function extractSummary(body: string): string {
  if (!body) return '';
  const i = body.indexOf(SUMMARY_MARKER);
  if (i === -1) return body.slice(0, 300);
  let seg = body.slice(i + SUMMARY_MARKER.length);
  const j = seg.indexOf('\n## ');
  if (j !== -1) seg = seg.slice(0, j);
  return seg.trim();
}

export function extractLayer3(body: string): string {
  if (!body) return '';
  const i = body.indexOf(LAYER3_MARKER);
  if (i === -1) return '';
  let seg = body.slice(i);
  const nl = seg.indexOf('\n');
  seg = nl !== -1 ? seg.slice(nl + 1) : '';
  const j = seg.indexOf('\n## ');
  if (j !== -1) seg = seg.slice(0, j);
  return seg.trim();
}

export function ratingExcluded(
  e: IndexEntry | MemoryEntry,
  includeLocal: boolean,
  includeAdult: boolean,
): boolean {
  if (e.local_only && !includeLocal) return true;
  if (e.rating === 'adult' && !includeAdult) return true;
  return false;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  fullBody?: boolean;
  includeLocal?: boolean;
  includeAdult?: boolean;
  includeConversations?: boolean;
}

export function hierarchicalSearch(q: string, opts: SearchOptions = {}): Record<string, unknown> {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  const includeLocal = opts.includeLocal ?? false;
  const includeAdult = opts.includeAdult ?? false;

  const terms = queryTerms(q);
  const index = loadIndexList().filter(
    (e) => !e.deleted && !ratingExcluded(e, includeLocal, includeAdult),
  );

  // 1次: インデックスのみ（title + tags + keywords、次点で3層symbolic）— bodyを読まない
  const matched = new Map<string, string>(); // id -> match_layer（挿入順 = 優先順）
  for (const e of index) {
    const text = [
      String(e.title ?? ''),
      (e.tags ?? []).map(String).join(' '),
      (e.keywords ?? []).map(String).join(' '),
    ]
      .join(' ')
      .toLowerCase();
    if (allTermsIn(terms, text)) {
      matched.set(e.id, 'keyword');
    } else if (allTermsIn(terms, String(e.symbolic ?? '').toLowerCase())) {
      matched.set(e.id, 'symbolic');
    }
  }

  // 2次: 2層要約 / 3次: 全文 — 1次のヒットが不足する場合のみ
  const target = limit > 0 ? offset + limit : null;
  if (target === null || matched.size < target) {
    const summaryHits: string[] = [];
    const fullHits: string[] = [];
    for (const entry of loadAllEntries()) {
      const eid = entry.id;
      if (!eid || entry.deleted || matched.has(eid)) continue;
      if (ratingExcluded(entry, includeLocal, includeAdult)) continue;
      const body = String(entry.body ?? '');
      if (allTermsIn(terms, extractSummary(body).toLowerCase())) {
        summaryHits.push(eid);
      } else if (allTermsIn(terms, body.toLowerCase())) {
        fullHits.push(eid);
      }
    }
    for (const eid of summaryHits) matched.set(eid, 'summary');
    for (const eid of fullHits) matched.set(eid, 'full');
  }

  const ids = [...matched.keys()];
  const total = ids.length;
  const sliced = limit > 0 ? ids.slice(offset, offset + limit) : ids.slice(offset);

  const results: Record<string, unknown>[] = [];
  for (const eid of sliced) {
    const entry = loadEntry(eid);
    if (!entry) continue;
    const body = String(entry.body ?? '');
    const item: Record<string, unknown> = {
      id: eid,
      title: entry.title ?? '',
      tags: entry.tags ?? [],
      keywords: entry.keywords ?? [],
      created_at: entry.created_at ?? '',
      updated_at: entry.updated_at ?? '',
      importance: entry.importance ?? 'normal',
      source_thread: entry.source_thread ?? '',
      match_layer: matched.get(eid),
      summary: extractSummary(body),
      symbolic: extractLayer3(body),
    };
    if (opts.fullBody) item.body = entry.body ?? '';
    results.push(item);
  }

  const result: Record<string, unknown> = {
    results,
    total,
    has_more: offset + sliced.length < total,
  };

  // 統合検索（v3.61）: 会話ログのタイトルもAND判定で検索して併せて返す
  if (opts.includeConversations) {
    const convHits = loadConvIndex().filter((m) => {
      if (m.rating === 'adult' && !includeAdult) return false;
      return allTermsIn(terms, String(m.title ?? '').toLowerCase());
    });
    convHits.sort((a, b) =>
      (a.updated_at ?? a.created_at ?? '') < (b.updated_at ?? b.created_at ?? '') ? 1 : -1,
    );
    result.conversations_total = convHits.length;
    result.conversations = limit > 0 ? convHits.slice(0, limit) : convHits;
  }
  return result;
}

/** REST /api/memory/index の random=N サンプリング（main.py _random_index_sample 互換） */
export function randomIndexSample(
  index: IndexEntry[],
  randomN: string,
  filterSummarized: boolean,
): IndexEntry[] {
  let pool = index.filter((e) => !e.deleted && !ratingExcluded(e, false, false));
  if (filterSummarized) {
    pool = pool.filter((e) => !(e.tags ?? []).includes('raw'));
  }
  let n = parseInt(randomN, 10);
  if (Number.isNaN(n)) n = 1;
  n = Math.max(1, Math.min(5, n));
  if (pool.length <= n) return pool;
  // Fisher–Yates で n 件抽出
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}
