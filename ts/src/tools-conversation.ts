/**
 * TS-1 リング4 グループ4: 会話ログ系 MCP ツール（main.py _handle_tool_call_raw と同一契約）。
 * conversation_index / conversation_search / conversation_share / conversation_read /
 * log_annotate（conversation_digest は LLM 依存のため tools-llm.ts）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveIndividual } from './attendance.js';
import { ConvMeta, CONVERSATIONS_DIR, convRatingView, DATA_ROOT, loadConvIndex } from './data.js';
import { pyOr } from './py-compat.js';
import { allTermsIn, queryTerms } from './search.js';
import { Handler, toInt, truthy } from './tool-types.js';
import { jstIsoFromMs, nowJst, writeJson } from './write.js';

const ANNOTATIONS_DIR = path.join(DATA_ROOT, 'annotations');
const SHARE_TOKENS_FILE = path.join(DATA_ROOT, 'share_tokens.json');
const BASE_URL = process.env.MIO_BASE_URL ?? 'http://localhost:5002';

type Rec = Record<string, unknown>;

/** uuid セグメントの安全確認（パス区切り・.. を含む値はファイルとして扱わない） */
function safeUuid(uuid: string): boolean {
  return !!uuid && !uuid.includes('/') && !uuid.includes('\\') && !uuid.includes('..');
}

function convPath(uuid: string): string {
  return path.join(CONVERSATIONS_DIR, `${uuid}.json`);
}

function str(v: unknown, dflt = ''): string {
  return v === undefined || v === null ? dflt : String(v);
}

/** Python の s[:n]（コードポイント単位）。サロゲートペアを割らない */
function cpSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

/** Python sort(key=updated_at or created_at, reverse=True) 相当（安定ソート） */
function sortKey(e: ConvMeta): string {
  return String(e.updated_at || e.created_at || '');
}
function sortDesc(index: ConvMeta[]): ConvMeta[] {
  return index.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return kb < ka ? -1 : kb > ka ? 1 : 0;
  });
}

const ratingView = convRatingView;

function ratingMatch(entry: ConvMeta, filter: string): boolean {
  let r: unknown = entry.rating;
  if (!r) r = entry.rating_source ? 'safe' : null;
  return r === filter;
}

/** main.py _conv_individual_match（REST の conversations.ts からも使う） */
export function individualMatch(entry: ConvMeta, filter: string): boolean {
  const resolved = resolveIndividual(filter);
  let participants = (Array.isArray(entry.participants) ? entry.participants : []) as unknown[];
  if (participants.length === 0) {
    const m = str(entry.model);
    if (m) participants = [m];
  }
  for (const p of participants) {
    if (resolved && resolveIndividual(p) === resolved) return true;
    if (String(p).toLowerCase().includes(filter.toLowerCase())) return true;
  }
  return false;
}

function redactStatus(uuid: string): string {
  const p = path.join(CONVERSATIONS_DIR, `${uuid}_redacted.json`);
  if (!fs.existsSync(p)) return 'not_generated';
  try {
    const rd = JSON.parse(fs.readFileSync(p, 'utf-8')) as Rec;
    return rd.approved ? 'approved' : 'pending_approval';
  } catch {
    return 'not_generated';
  }
}

/** main.py _conv_body_match_terms: タイトル/uuid または本文に全 terms が含まれるか */
export function bodyMatchTerms(entry: ConvMeta, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const titleText = (str(entry.title) + ' ' + str(entry.uuid)).toLowerCase();
  if (allTermsIn(terms, titleText)) return true;
  const uuid = str(entry.uuid);
  if (!safeUuid(uuid)) return false;
  const fpath = convPath(uuid);
  if (!fs.existsSync(fpath)) return false;
  try {
    const conv = JSON.parse(fs.readFileSync(fpath, 'utf-8')) as Rec;
    const full: string[] = [];
    for (const m of (conv.chat_messages as Rec[] | undefined) ?? []) {
      // Python の `content or text or ''`（空リストも偽）
      const content = pyOr(m.content, m.text, '');
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object' && (c as Rec).type === 'text') {
            full.push(str((c as Rec).text).toLowerCase());
          }
        }
      } else {
        full.push(String(content).toLowerCase());
      }
    }
    return allTermsIn(terms, full.join(' '));
  } catch {
    return false;
  }
}

// ── annotations ─────────────────────────────────────────────────────

interface Annotation {
  seq: number;
  target: unknown;
  note: unknown;
  author: unknown;
  created_at: string;
  [key: string]: unknown;
}

function annotationsPath(uid: string): string {
  return path.join(ANNOTATIONS_DIR, `${uid}.json`);
}

function loadAnnotations(uid: string): Annotation[] {
  try {
    return JSON.parse(fs.readFileSync(annotationsPath(uid), 'utf-8')) as Annotation[];
  } catch {
    return [];
  }
}

/** main.py _ann_target_no: int / "No.XX" / 数字文字列 / null → 通番 or null（会話全体） */
function annTargetNo(target: unknown): number | null {
  if (target === null || target === undefined || target === '') return null;
  const m = /(\d+)/.exec(String(target));
  return m ? parseInt(m[1], 10) : null;
}

function formatAnnotation(a: Annotation): string {
  const date = cpSlice(str(a.created_at), 10);
  const author = 'author' in a ? String(a.author) : '?';
  return `📝[annotation #${a.seq} by ${author} @${date}] ${str(a.note)}`;
}

// ── ハンドラー ──────────────────────────────────────────────────────

const conversationIndex: Handler = (args) => {
  const search = str(args.search).toLowerCase();
  const limitRaw = 'limit' in args ? toInt(args.limit) : 50;
  const offsetRaw = 'offset' in args ? toInt(args.offset) : 0;
  if (Number.isNaN(limitRaw) || Number.isNaN(offsetRaw)) {
    return { error: 'limit / offset must be integers' };
  }
  const limit = Math.min(limitRaw, 500);
  const offset = Math.max(offsetRaw, 0);
  const ratingFilter = args.rating as string | undefined;
  const individualFilter = args.individual as string | undefined;
  const includeRedact = truthy(args.include_redact_status);

  let index = loadConvIndex().filter((e) => !e.hidden);
  if (search) {
    index = index.filter((e) => (str(e.title) + ' ' + str(e.uuid)).toLowerCase().includes(search));
  }
  if (ratingFilter) index = index.filter((e) => ratingMatch(e, ratingFilter));
  if (individualFilter) index = index.filter((e) => individualMatch(e, String(individualFilter)));
  sortDesc(index);
  const total = index.length;
  const items = index.slice(offset, offset + limit).map(ratingView);
  if (includeRedact) {
    for (const item of items) {
      if (item.rating === 'adult' || (!item.rating && !item.rating_source && ratingFilter === 'adult')) {
        item.redact_status = redactStatus(str(item.uuid));
      }
    }
  }
  return { total, offset, limit, items, server_time: nowJst() };
};

const conversationSearch: Handler = (args) => {
  const q = str(args.q).toLowerCase();
  const terms = queryTerms(q);
  const dateFrom = str(args.date_from);
  const dateTo = str(args.date_to);
  const limitRaw = 'limit' in args ? toInt(args.limit) : 5;
  if (Number.isNaN(limitRaw)) return { error: 'limit must be an integer' };
  const limit = Math.min(limitRaw, 50);
  const bodySearch = truthy(args.body_search);
  const ratingFilter = args.rating as string | undefined;
  const individualFilter = args.individual as string | undefined;
  const includeRedact = truthy(args.include_redact_status);

  let index = loadConvIndex().filter((e) => !e.hidden);
  if (terms.length > 0 && !bodySearch) {
    index = index.filter((e) => allTermsIn(terms, (str(e.title) + ' ' + str(e.uuid)).toLowerCase()));
  }
  if (dateFrom) index = index.filter((e) => sortKey(e) >= dateFrom);
  if (dateTo) index = index.filter((e) => sortKey(e) <= dateTo + 'T23:59:59');
  if (ratingFilter) index = index.filter((e) => ratingMatch(e, ratingFilter));
  if (individualFilter) index = index.filter((e) => individualMatch(e, String(individualFilter)));
  if (terms.length > 0 && bodySearch) index = index.filter((e) => bodyMatchTerms(e, terms));
  sortDesc(index);
  const items = index.slice(0, limit).map(ratingView);
  if (includeRedact) {
    for (const item of items) {
      if (item.rating === 'adult') item.redact_status = redactStatus(str(item.uuid));
    }
  }
  return items;
};

const conversationShare: Handler = (args) => {
  const uid = str(args.uuid);
  if (!safeUuid(uid) || !fs.existsSync(convPath(uid))) {
    return { error: `conversation not found: ${uid}` };
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = jstIsoFromMs(Date.now() + 86400 * 1000);
  let tokens: Rec = {};
  try {
    tokens = JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf-8')) as Rec;
  } catch {
    tokens = {};
  }
  tokens[token] = { conv_uuid: uid, expires_at: expiresAt };
  writeJson(SHARE_TOKENS_FILE, tokens);
  return { token, url: `${BASE_URL}/share.html?token=${token}`, expires_at: expiresAt };
};

/** 承認済み伏せ字ログ（{uuid}_redacted.json の approved=true のみ） */
function getRedacted(uid: string): Rec | null {
  const p = path.join(CONVERSATIONS_DIR, `${uid}_redacted.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Rec;
    return data.approved ? data : null;
  } catch {
    return null;
  }
}

const conversationRead: Handler = (args) => {
  const uid = str(args.uuid);
  const includeThinking = truthy(args.include_thinking);
  const includeAnnotations = truthy(args.include_annotations);
  const includeBody = 'include_body' in args ? truthy(args.include_body) : true;
  const thinkingLimit =
    args.thinking_limit !== undefined && args.thinking_limit !== null
      ? toInt(args.thinking_limit)
      : 1500; // 0 / 負数 = 無制限
  if (Number.isNaN(thinkingLimit)) return { error: 'thinking_limit must be an integer' };

  // v3.96: message_from/message_to（No.指定）→ turn_offset/turn_limit に変換
  let turnOffset: number;
  let turnLimit: number;
  if (args.message_from !== undefined && args.message_from !== null) {
    const from = toInt(args.message_from);
    if (Number.isNaN(from)) return { error: 'message_from must be an integer' };
    turnOffset = Math.max(from - 1, 0);
    if (args.message_to !== undefined && args.message_to !== null) {
      const to = toInt(args.message_to);
      if (Number.isNaN(to)) return { error: 'message_to must be an integer' };
      turnLimit = Math.max(to - turnOffset, 0);
    } else {
      turnLimit = 0;
    }
  } else {
    turnOffset = truthy(args.turn_offset) ? toInt(args.turn_offset) : 0; // 負値=末尾起点
    turnLimit = truthy(args.turn_limit) ? toInt(args.turn_limit) : 0; // 0=無制限
    if (Number.isNaN(turnOffset) || Number.isNaN(turnLimit)) {
      return { error: 'turn_offset / turn_limit must be integers' };
    }
  }

  if (!safeUuid(uid) || !fs.existsSync(convPath(uid))) {
    return { error: `conversation not found: ${uid}` };
  }
  let conv: Rec;
  try {
    conv = JSON.parse(fs.readFileSync(convPath(uid), 'utf-8')) as Rec;
  } catch (e) {
    return { error: `conversation unreadable: ${uid}: ${(e as Error).message}` };
  }
  const assistantLabel = resolveIndividual(conv.model ?? '') || 'assistant';

  // M-LOCAL-7: rating=adult の閲覧制御
  // 優先順位: 1. include_raw=true → 原文  2. redact=true → 承認済み伏せ字  3. 既定 → 伏せ字 or safe ダイジェスト
  if (conv.rating === 'adult' && !truthy(args.include_raw)) {
    const wantRedact = truthy(args.redact);
    const redacted = getRedacted(uid);
    if (redacted) {
      const rmsgs = (redacted.redacted_messages as Rec[] | undefined) ?? [];
      const total = rmsgs.length;
      const lo = turnOffset < 0 ? Math.max(0, total + turnOffset) : Math.min(turnOffset, total);
      const hi = turnLimit > 0 ? Math.min(lo + turnLimit, total) : total;
      const lines = rmsgs
        .slice(lo, hi)
        .map((rm) => `[${rm.role === 'assistant' ? assistantLabel : String(rm.role)}] ${String(rm.text)}`);
      const result: Rec = {
        uuid: uid,
        title: str(conv.name),
        rating: 'adult',
        gated: true,
        redacted: true,
        mask_count: redacted.mask_count ?? 0,
        body: lines.join('\n\n'),
      };
      if (turnOffset !== 0 || turnLimit !== 0) {
        result.total_messages = total;
        result.slice = hi > lo ? `${lo + 1}-${hi}` : '該当なし';
      }
      return result;
    }
    if (wantRedact) {
      return {
        uuid: uid,
        title: str(conv.name),
        rating: 'adult',
        gated: true,
        redacted: false,
        notice:
          'この会話の承認済み伏せ字ログはまだありません。' +
          '生成: POST /api/conversations/{uuid}/redact → ' +
          '承認: POST /api/conversations/{uuid}/redact/approve',
      };
    }
    const notice =
      'この会話は rating=adult のため、原文の代わりに safe ダイジェストを返しています。' +
      '原文が必要な場合は include_raw=true を、伏せ字ログが必要な場合は redact=true を明示してください。';
    const safePath = path.join(CONVERSATIONS_DIR, `${uid}_digest_safe.json`);
    if (fs.existsSync(safePath)) {
      const dg = JSON.parse(fs.readFileSync(safePath, 'utf-8')) as Rec;
      return {
        uuid: uid,
        title: str(conv.name),
        rating: 'adult',
        gated: true,
        notice,
        digest: str(dg.digest),
      };
    }
    return {
      uuid: uid,
      title: str(conv.name),
      rating: 'adult',
      gated: true,
      notice:
        notice +
        ' safe ダイジェスト未生成のため本文は返せません。' +
        'conversation_digest(uuid, safe_mode=true) で生成できます。',
    };
  }

  const messages = ((conv.chat_messages as Rec[] | undefined) ?? []) as Rec[];
  const totalMsgs = messages.length;
  // メッセージ単位スライス（turn_offset 負値=末尾起点 / turn_limit 0=無制限）
  const sliceLo = turnOffset < 0 ? Math.max(0, totalMsgs + turnOffset) : Math.min(turnOffset, totalMsgs);
  const sliceHi = turnLimit > 0 ? Math.min(sliceLo + turnLimit, totalMsgs) : totalMsgs;
  const slicingActive = turnOffset !== 0 || turnLimit !== 0;
  // include_thinking 時はメッセージ上限を緩和（thinking は長文になりがち）
  let msgCap: number | null;
  if (includeThinking) msgCap = thinkingLimit > 0 ? Math.max(2000, thinkingLimit + 500) : null;
  else msgCap = 500;

  // 注記をメッセージ通番（chat_messages の1始まりインデックス）ごとに整理
  const annByNo = new Map<number, Annotation[]>();
  const annGlobal: Annotation[] = [];
  if (includeAnnotations) {
    for (const a of loadAnnotations(uid)) {
      const no = annTargetNo(a.target);
      if (no === null) annGlobal.push(a);
      else (annByNo.get(no) ?? annByNo.set(no, []).get(no)!).push(a);
    }
  }
  const emitted = new Set<number>();
  let thinkingFound = 0;
  const lines: string[] = [];
  messages.forEach((m, i) => {
    const no = i + 1;
    if (slicingActive && !(sliceLo < no && no <= sliceHi)) return;
    let role = str((m.sender as unknown) || (m.role as unknown) || '?', '?');
    if (role === 'assistant') role = assistantLabel;
    const rawContent = (m.content as unknown) || (m.text as unknown) || '';
    let text = '';
    if (Array.isArray(rawContent)) {
      for (const c of rawContent) {
        if (!c || typeof c !== 'object') continue;
        const cc = c as Rec;
        if (cc.type === 'text') {
          text += str(cc.text);
        } else if (cc.type === 'thinking') {
          thinkingFound += 1;
          if (includeThinking) {
            let tt = str((cc.thinking as unknown) || (cc.text as unknown) || '').trim();
            if (tt) {
              if (thinkingLimit > 0) tt = cpSlice(tt, thinkingLimit);
              text += `\n💭[thinking]\n${tt}\n[/thinking]\n`;
            }
          }
        }
      }
    } else {
      text = String(rawContent);
    }
    const anns = annByNo.get(no);
    if (includeBody && text.trim()) {
      const body = msgCap ? cpSlice(text, msgCap) : text;
      const prefix = includeAnnotations ? `[No.${no}][${role}]` : `[${role}]`;
      let line = `${prefix} ${body}`;
      if (anns) {
        emitted.add(no);
        line += '\n' + anns.map(formatAnnotation).join('\n');
      }
      lines.push(line);
    } else if (!includeBody && anns) {
      emitted.add(no);
      lines.push(`[No.${no}][${role}]\n` + anns.map(formatAnnotation).join('\n'));
    }
  });

  const title = str((conv.name as unknown) || (conv.title as unknown) || '無題');
  let result = `# ${title}\n\n`;
  if (slicingActive) {
    result +=
      sliceHi > sliceLo
        ? `表示: 全${totalMsgs}件中 ${sliceLo + 1}-${sliceHi}\n\n`
        : `表示: 全${totalMsgs}件中 該当なし\n\n`;
  }
  if (annGlobal.length > 0) result += annGlobal.map(formatAnnotation).join('\n') + '\n\n';
  result += lines.join('\n\n');
  // 対象メッセージが非表示（空テキスト等）だった注記は末尾にまとめる
  const leftover: Annotation[] = [];
  for (const [no, list] of annByNo) {
    if (emitted.has(no)) continue;
    if (slicingActive && !(sliceLo < no && no <= sliceHi)) continue;
    leftover.push(...list);
  }
  if (leftover.length > 0) {
    result += '\n\n---\n（以下は対象メッセージが表示されなかった注記）\n';
    result += leftover.map((a) => `[No.${annTargetNo(a.target)}] ${formatAnnotation(a)}`).join('\n');
  }
  if (thinkingFound && !includeThinking) {
    result += `\n\n---\n（この会話には thinking ブロックが ${thinkingFound} 件あります。include_thinking=true で取得できます）`;
  }
  return result;
};

const logAnnotate: Handler = (args) => {
  const uid = str(args.uuid);
  const note = args.note;
  const author = args.author;
  const target = args.target; // メッセージ通番 / "No.XX" / 省略=会話全体
  if (!uid || !truthy(note) || !truthy(author)) {
    return { error: 'uuid, note, author are required' };
  }
  if (!safeUuid(uid) || !fs.existsSync(convPath(uid))) {
    return { error: `conversation not found: ${uid}` };
  }
  fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });
  const anns = loadAnnotations(uid);
  const entry: Annotation = {
    seq: anns.length + 1,
    target: target === undefined ? null : target,
    note,
    author,
    created_at: nowJst(),
  };
  anns.push(entry);
  writeJson(annotationsPath(uid), anns);
  return { ok: true, uuid: uid, seq: entry.seq, target: entry.target, created_at: entry.created_at };
};

export const CONVERSATION_HANDLERS: Record<string, Handler> = {
  conversation_index: conversationIndex,
  conversation_search: conversationSearch,
  conversation_share: conversationShare,
  conversation_read: conversationRead,
  log_annotate: logAnnotate,
};
