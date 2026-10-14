/**
 * TS-1 リング4 グループ8: 出席簿ビュー（main.py _attendance_rows / _attendance_view と同一契約）。
 * 5 層（会話ログ・inbox・ExtMemory・CoreMem attendance.md・セッションチェックイン）から
 * 稼働痕跡を集めて日付降順で返す。
 */
import { loadSessionCheckins, parseIsoTs, resolveIndividual } from './attendance.js';
import { artifactsRead } from './coremem.js';
import { convRatingView, loadConvIndex, loadIndexList } from './data.js';
import { loadInboxMessages } from './inbox.js';

type Row = Record<string, unknown>;

/** from_model 表記からローカル環境の稼働を推定するマーカー */
const LOCAL_MARKER_RE = /バカンス|vacation|ローカル|local|gemma|lmstudio|openwebui/i;
const ROSTER_NAMES = ['しずく', 'おみ', 'そねみ', '汐', '凪', 'Sonnet 5', 'Haiku 4.5'];

function isLocalActor(models: unknown[]): boolean {
  for (const m of models ?? []) {
    const s = String(m);
    if (LOCAL_MARKER_RE.test(s)) return true;
    for (const name of ROSTER_NAMES) {
      if (s === `${name}B`) return true;
    }
  }
  return false;
}

function attendanceRows(): Row[] {
  const rows: Row[] = [];
  // 1. 会話ログのメタデータ（チャット側 / Claude Code / OpenWebUI=ローカル）
  for (const e of loadConvIndex()) {
    const model = String(e.model ?? '');
    const source = String(e.source ?? '');
    const channel = source === 'claude-code' ? 'code' : source === 'openwebui' ? 'local' : 'chat';
    rows.push({
      date: e.updated_at || e.created_at || '',
      channel,
      individual: resolveIndividual(model),
      model: model || null,
      uuid: e.uuid ?? null,
      title: e.title ?? '',
      rating: convRatingView(e).rating,
      kind: 'conversation',
    });
  }
  // 2. inbox（コード側稼働・ローカル便の痕跡。既読も含む全件）
  for (const m of loadInboxMessages(null, false)) {
    let fm: unknown[] = [];
    if (Array.isArray(m.from_model)) fm = m.from_model;
    else if (typeof m.from_model === 'string' && m.from_model) fm = [m.from_model];
    const channel = isLocalActor(fm) ? 'local' : m.from === 'code' ? 'code' : 'chat';
    rows.push({
      date: m.created_at ?? '',
      channel,
      individual: resolveIndividual(...fm),
      model: fm.map(String).join(' / ') || null,
      inbox_id: m.id ?? null,
      title: m.title ?? '',
      kind: 'inbox',
    });
  }
  // 3. ExtMemory（タグから個体を推定できるエントリのみ）
  for (const e of loadIndexList()) {
    const individual = resolveIndividual(...((e.tags as unknown[] | undefined) ?? []));
    if (!individual) continue;
    rows.push({
      date: e.created_at ?? '',
      channel: null,
      individual,
      model: null,
      memory_id: e.id ?? null,
      title: e.title ?? '',
      kind: 'memory',
    });
  }
  // 4. CoreMem attendance.md — 手動チェックイン行（書式: `YYYY-MM-DD | 個体 | 器 | チャネル | 一言`）
  const res = artifactsRead('attendance.md', null);
  for (let line of String(res.content ?? '').split(/\r?\n/)) {
    line = line.trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const parts = line.split('|').map((p) => p.trim());
    rows.push({
      date: parts[0],
      channel: parts.length > 3 ? parts[3] : null,
      individual: parts.length > 1 ? resolveIndividual(parts[1]) || parts[1] : null,
      model: parts.length > 2 ? parts[2] : null,
      title: parts.length > 4 ? parts[4] : '',
      kind: 'checkin',
    });
  }
  // 5. セッションチェックイン（CoreMem_read / inbox_check 経由の自動登録, v3.85）
  for (const e of loadSessionCheckins()) {
    const model = e.model;
    rows.push({
      date: e.timestamp ?? '',
      channel: null,
      individual: model ? resolveIndividual(model) : null,
      model,
      title: '(auto checkin)',
      kind: 'session_checkin',
    });
  }
  // 日付降順（安定ソート。Python の sort(reverse=True) と同順）
  rows.sort((a, b) => {
    const ka = String(a.date || '');
    const kb = String(b.date || '');
    return kb < ka ? -1 : kb > ka ? 1 : 0;
  });
  return rows;
}

export interface AttendanceOptions {
  individual?: string | null;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  kindFilter?: Set<string> | null;
}

export function attendanceView(opts: AttendanceOptions): Record<string, unknown> {
  const individual = opts.individual || null;
  const dateFrom = opts.dateFrom ?? '';
  const dateTo = opts.dateTo ?? '';
  const limit = opts.limit ?? 50;
  let allRows = attendanceRows();
  if (opts.kindFilter && opts.kindFilter.size > 0) {
    allRows = allRows.filter((r) => opts.kindFilter!.has(String(r.kind)));
  }
  const resolved = individual ? resolveIndividual(individual) : null;

  const match = (r: Row): boolean => {
    if (individual === '?' && !r.individual) return true;
    if (resolved && r.individual === resolved) return true;
    const m = String(r.model ?? '');
    return !!individual && m.toLowerCase().includes(individual.toLowerCase());
  };
  const inPeriod = (r: Row): boolean => {
    const d = String(r.date || '');
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d.slice(0, 10) > dateTo.slice(0, 10)) return false;
    return true;
  };

  const now = Date.now();
  const summary = (rowsFor: Row[]): Record<string, unknown> => {
    const first = rowsFor.find((r) => r.date);
    const last = first ? (first.date as string) : null; // 日付降順前提
    const ts = parseIsoTs(last);
    return {
      last_seen: last,
      days_since: ts !== null ? Math.max(Math.floor((now - ts) / 86400000), 0) : null,
      count: rowsFor.length,
    };
  };

  let result: Record<string, unknown>;
  let filtered: Row[];
  if (individual) {
    const mine = allRows.filter(match);
    filtered = mine.filter(inPeriod);
    const others = new Map<string, number>();
    for (const r of allRows) {
      if (match(r) || !inPeriod(r)) continue;
      const key = String(r.individual || r.model || '?');
      others.set(key, (others.get(key) ?? 0) + 1);
    }
    result = {
      individual: resolved || individual,
      others_in_period: Object.fromEntries(others),
      ...summary(mine), // 最終稼働日は期間フィルタに依らず全期間で出す
    };
  } else {
    filtered = allRows.filter(inPeriod);
    const by = new Map<string, Row[]>();
    for (const r of filtered) {
      const k = String(r.individual || '?');
      (by.get(k) ?? by.set(k, []).get(k)!).push(r);
    }
    const individuals: Record<string, unknown> = {};
    for (const [k, v] of by) individuals[k] = summary(v);
    result = { individual: 'all', individuals };
    const unresolved = by.get('?');
    if (unresolved) {
      const dist = new Map<string, number>();
      for (const r of unresolved) {
        const m = String(r.model || '(empty)');
        dist.set(m, (dist.get(m) ?? 0) + 1);
      }
      result.unresolved_models = Object.fromEntries(
        [...dist.entries()].sort((a, b) => b[1] - a[1]),
      );
    }
  }
  result.period = { from: dateFrom || null, to: dateTo || null };
  result.total = filtered.length;
  result.rows = filtered.slice(0, limit);
  return result;
}
