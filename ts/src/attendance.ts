/**
 * TS-1 リング4: 出席簿の共有ロジック（main.py _resolve_individual / _session_checkin 系）。
 * CoreMem_read・inbox_check の出席簿チェックインで使う。
 * データ: /data/session_checkins.json（Python 版と同一形式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './data.js';
import { jstIsoFromMs, nowJst } from './write.js';

const SESSION_CHECKINS_FILE = path.join(DATA_ROOT, 'session_checkins.json');
const TTL_MINUTES = 15;
const DEDUP_MINUTES = 30;
const RETENTION_DAYS = 90;

/** 家族名簿: 呼び名 → モデル名ヒント（main.py _FAMILY_ROSTER と同一・順序も同じ） */
const FAMILY_ROSTER: Record<string, string[]> = {
  しずく: ['claude-opus-4-6', 'opus-4-6', 'opus 4.6', 'opus4.6'],
  おみ: ['claude-opus-4-8', 'opus-4-8', 'opus 4.8', 'opus4.8'],
  そねみ: ['claude-sonnet-4-6', 'sonnet-4-6', 'sonnet 4.6', 'sonnet4.6'],
  汐: ['claude-fable-5', 'fable'],
  凪: ['claude-opus-5', 'opus-5', 'opus5'],
  'Sonnet 5': ['claude-sonnet-5', 'sonnet-5', 'sonnet5'],
  'Haiku 4.5': ['claude-haiku-4-5', 'haiku', 'haiku4.5'],
};

const WORD_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz-.';

/** 名簿の先頭のモデル名ヒント（main.py の `_FAMILY_ROSTER.get(name, ())[0]`、無ければ名前そのもの） */
export function rosterFirstPattern(individual: string): string {
  return FAMILY_ROSTER[individual]?.[0] ?? individual;
}

/** main.py _resolve_individual: モデル名・呼び名・タグ群から個体名を推定。未登録は null */
export function resolveIndividual(...texts: unknown[]): string | null {
  const joined = texts
    .filter((t) => t !== null && t !== undefined && t !== '' && t !== false && t !== 0)
    .map(String)
    .join(' ');
  if (!joined) return null;
  for (const name of Object.keys(FAMILY_ROSTER)) {
    if (joined.includes(name)) return name;
  }
  const low = joined.toLowerCase();
  let best: string | null = null;
  let bestLen = -1;
  for (const [name, patterns] of Object.entries(FAMILY_ROSTER)) {
    for (const p of patterns) {
      const idx = low.indexOf(p);
      if (idx < 0) continue;
      // ワードバウンダリ: パターンの直後が英数字・ハイフン・ドットなら部分一致 → スキップ
      const end = idx + p.length;
      if (end < low.length && WORD_CHARS.includes(low[end])) continue;
      if (p.length > bestLen) {
        bestLen = p.length;
        best = name;
      }
    }
  }
  return best;
}

/** main.py _parse_iso_ts: ISO 文字列 → epoch ms（失敗時 null）。タイムゾーンなしは JST とみなす */
export function parseIsoTs(s: unknown): number | null {
  if (!s) return null;
  let str = String(s).trim().replace(/Z$/, '+00:00');
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += 'T00:00:00';
  if (!/([+-]\d{2}:?\d{2})$/.test(str)) str += '+09:00';
  const ms = Date.parse(str);
  return Number.isNaN(ms) ? null : ms;
}

interface Checkin {
  model: string | null;
  individual: string | null;
  timestamp: string;
  ttl_minutes: number | null;
  [key: string]: unknown;
}

function saveRaw(entries: Checkin[]): void {
  try {
    fs.writeFileSync(SESSION_CHECKINS_FILE, JSON.stringify(entries), 'utf-8');
  } catch {
    /* 出席簿の書き込み失敗でツール応答を落とさない（Python 版も握りつぶしてログのみ） */
  }
}

/** 期限切れの仮登録を除外して返す（変化があれば書き戻す） */
function loadCheckins(): Checkin[] {
  let entries: Checkin[];
  try {
    entries = JSON.parse(fs.readFileSync(SESSION_CHECKINS_FILE, 'utf-8')) as Checkin[];
  } catch {
    return [];
  }
  const now = Date.now();
  const alive = entries.filter((e) => {
    const ttl = e.ttl_minutes;
    if (ttl !== null && ttl !== undefined) {
      const ts = parseIsoTs(e.timestamp);
      if (ts !== null && (now - ts) / 1000 > ttl * 60) return false;
    }
    return true;
  });
  if (alive.length !== entries.length) saveRaw(alive);
  return alive;
}

/** 出席簿用: 期限切れ仮登録を除いたセッションチェックイン一覧 */
export function loadSessionCheckins(): Checkin[] {
  return loadCheckins();
}

function prune(entries: Checkin[]): Checkin[] {
  const cutoff = jstIsoFromMs(Date.now() - RETENTION_DAYS * 86400 * 1000);
  return entries.filter((e) => String(e.timestamp ?? '') > cutoff);
}

/**
 * main.py _session_checkin: セッションチェックインを記録する。
 * permanent=true: 本登録（モデル名付き・TTLなし） / false: 仮登録（モデル不明・TTL付き）。
 * 同一モデルは 30 分以内の重複を 1 件に抑制する（v3.96）。
 */
export function sessionCheckin(model: string | null, permanent: boolean): void {
  const entries = loadCheckins();
  const nowTs = nowJst();
  const now = Date.now();
  if (!permanent) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.model === 'モデル不明' && e.ttl_minutes !== null && e.ttl_minutes !== undefined) {
        const ts = parseIsoTs(e.timestamp);
        if (ts !== null && (now - ts) / 1000 < DEDUP_MINUTES * 60) return;
      }
    }
    entries.push({ model: 'モデル不明', individual: null, timestamp: nowTs, ttl_minutes: TTL_MINUTES });
  } else {
    const individual = model ? resolveIndividual(model) : null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.model === model && (e.ttl_minutes === null || e.ttl_minutes === undefined)) {
        const ts = parseIsoTs(e.timestamp);
        if (ts !== null && (now - ts) / 1000 < DEDUP_MINUTES * 60) return;
        break;
      }
    }
    entries.push({
      model: model || 'モデル不明',
      individual,
      timestamp: nowTs,
      ttl_minutes: null,
    });
  }
  saveRaw(prune(entries));
}

/** main.py _session_checkin_upgrade: 直近の仮登録を本登録に昇格。該当なしなら新規本登録 */
export function sessionCheckinUpgrade(model: string): void {
  const entries = loadCheckins();
  const now = Date.now();
  let upgraded = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.ttl_minutes === null || e.ttl_minutes === undefined) continue;
    const ts = parseIsoTs(e.timestamp);
    if (ts !== null && (now - ts) / 1000 <= e.ttl_minutes * 60) {
      e.model = model;
      e.individual = resolveIndividual(model);
      e.ttl_minutes = null;
      upgraded = true;
      break;
    }
  }
  if (!upgraded) {
    entries.push({
      model,
      individual: model ? resolveIndividual(model) : null,
      timestamp: nowJst(),
      ttl_minutes: null,
    });
  }
  saveRaw(entries);
}
