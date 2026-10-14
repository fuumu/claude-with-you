/**
 * TS-1 リング5: LLM 依存処理（main.py からの移植）。
 *  - 要約レイヤー生成バッチ（_run_summary_batch）/ レーティング判定バッチ（_run_rating_batch）
 *  - 会話ダイジェスト生成（_conversation_digest）
 *  - 昇華（_sublimate_text）と inbox 自動昇華パイプライン（【生】）
 *
 * LLM 呼び出しは llm.ts の createMessage（Anthropic Messages 互換）経由。プロンプトは main.py と
 * 一字一句同一に保つ（挙動不変）。バッチ状態はプロセス内メモリ（Python 版と同じ）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONVERSATIONS_DIR,
  ConvMeta,
  DATA_DIR,
  INDEX_FILE,
  loadConvIndex,
} from './data.js';
import { findInboxFile, readMsg, registerSublimateHook, writeMsg } from './inbox.js';
import { extractSummary } from './search.js';
import {
  clientForBackend,
  createMessage,
  lmClient,
  LlmClient,
  logError,
  logInfo,
} from './llm.js';
import { truthy } from './tool-types.js';
import { appendOplog, nowJst, rebuildIndex, writeJson } from './write.js';

const SUMMARY_MARKER = '## 2層: 要約';
const LAYER3_MARKER = '## 3層:';
const LAYER4_MARKER = '## 4層:';

const EMPTY_SUMMARY_PATTERNS = [
  '読み取れません', '具体的な内容は', '識別子としての性質',
  '推測されます', '内容を読み取ることができ', '識別子的な',
  '内容は不明', '情報が含まれていません',
];

type Json = Record<string, unknown>;

// ── 小道具 ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Python の s[:n]（コードポイント単位） */
function cp(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

function cpLen(s: string): number {
  return Array.from(s).length;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function pyStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function convPath(uuid: string): string {
  return path.join(CONVERSATIONS_DIR, `${uuid}.json`);
}

function saveConvIndex(index: ConvMeta[]): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  writeJson(path.join(CONVERSATIONS_DIR, '_index.json'), index);
}

/** main.py _patch_conv_index_entry: 特定 UUID のエントリだけ更新（値 null のキーは削除） */
function patchConvIndexEntry(uuid: string, updates: Json): void {
  const index = loadConvIndex();
  for (const m of index) {
    if (m.uuid === uuid) {
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) delete (m as Json)[k];
        else (m as Json)[k] = v;
      }
      break;
    }
  }
  saveConvIndex(index);
}

/** `m.get('sender') or m.get('role') or '?'` */
function roleOf(m: Json): string {
  return (truthy(m.sender) ? pyStr(m.sender) : '') || (truthy(m.role) ? pyStr(m.role) : '') || '?';
}

/** `m.get('content') or m.get('text') or ''` */
function contentOf(m: Json): unknown {
  if (truthy(m.content)) return m.content;
  if (truthy(m.text)) return m.text;
  return '';
}

// ── 状態 ─────────────────────────────────────────────────────────────

export const batchStatus: Json = {
  running: false, total: 0, processed: 0, errors: 0, skipped: 0,
  started_at: null, finished_at: null, backend: null,
};

export const ratingBatchStatus: Json = {
  running: false, total: 0, processed: 0, errors: 0, skipped: 0,
  started_at: null, finished_at: null, backend: null,
  skip_reasons: {}, error_uuids: [],
};

const num = (o: Json, k: string): number => (o[k] as number) ?? 0;

// ── 要約レイヤー生成バッチ ─────────────────────────────────────────────

function isEmptySummary(text: string): boolean {
  if (!text || text.trim().length < 10) return true;
  return EMPTY_SUMMARY_PATTERNS.some((p) => text.includes(p));
}

function parseKeywordsLine(line: string): string[] {
  const parts = (line || '').split(/[,、]/).map((p) => p.trim().replace(/^[、,。 　]+|[、,。 　]+$/g, ''));
  return parts.filter((p) => p).slice(0, 8);
}

function splitLayersAndKeywords(llmText: string): { layers: string; keywords: string[] } {
  const text = (llmText || '').trim();
  const i = text.indexOf(LAYER4_MARKER);
  if (i === -1) return { layers: text, keywords: [] };
  const bodyPart = text.slice(0, i).trimEnd();
  const kwLines = text
    .slice(i)
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l);
  return { layers: bodyPart, keywords: kwLines.length > 0 ? parseKeywordsLine(kwLines[0]) : [] };
}

interface IdxEntry extends Json {
  id: string;
}

function loadIndexRaw(): IdxEntry[] {
  return readJson<IdxEntry[]>(INDEX_FILE, []);
}

/** 会話全文（source_thread の conversations/{uuid}.json の先頭 30 ターン・各 300 字） */
function convTextForSummary(sourceThread: string): string {
  if (!sourceThread) return '';
  const p = convPath(sourceThread);
  if (!fs.existsSync(p)) return '';
  try {
    const conv = JSON.parse(fs.readFileSync(p, 'utf-8')) as Json;
    const lines: string[] = [];
    for (const m of (conv.chat_messages as Json[] | undefined) ?? []) {
      const role = roleOf(m);
      const content = contentOf(m);
      let text = '';
      if (Array.isArray(content)) {
        for (const c of content as unknown[]) {
          if (c && typeof c === 'object' && (c as Json).type === 'text') {
            text += String((c as Json).text ?? '');
          }
        }
      } else {
        text = pyStr(content);
      }
      if (text.trim()) lines.push(`[${role}] ${cp(text, 300)}`);
    }
    return lines.slice(0, 30).join('\n\n');
  } catch {
    return '';
  }
}

async function runSummaryBatch(apiKey: string, backend: string, force: boolean): Promise<void> {
  Object.assign(batchStatus, {
    running: true, processed: 0, errors: 0, skipped: 0,
    started_at: nowJst(), finished_at: null, backend, force,
  });
  try {
    const { client, model } = await clientForBackend(backend, apiKey);
    const index = loadIndexRaw();
    const tagsOf = (e: Json) => (Array.isArray(e.tags) ? (e.tags as string[]) : []);
    let rawEntries: IdxEntry[];
    if (force) {
      rawEntries = index.filter(
        (e) => (tagsOf(e).includes('raw') || tagsOf(e).includes('summarized')) && !e.deleted,
      );
    } else {
      rawEntries = index.filter(
        (e) => !e.deleted && (tagsOf(e).includes('raw') || !truthy(e.keywords)),
      );
    }
    batchStatus.total = rawEntries.length;
    logInfo(`batch summary start: backend=${backend} force=${force} entries=${rawEntries.length}`);

    for (const idx of rawEntries) {
      const entryId = idx.id;
      const title = (idx.title as string | undefined) ?? '（無題）';
      const file = path.join(DATA_DIR, `${entryId}.json`);
      if (!fs.existsSync(file)) {
        batchStatus.errors = num(batchStatus, 'errors') + 1;
        continue;
      }
      const entry = JSON.parse(fs.readFileSync(file, 'utf-8')) as Json;
      let body = (entry.body as string | undefined) ?? '';
      const hasLayers = body.includes(SUMMARY_MARKER) && body.includes(LAYER3_MARKER);
      const isRaw = tagsOf(entry).includes('raw');

      if (!force && truthy(entry.keywords) && hasLayers) {
        batchStatus.skipped = num(batchStatus, 'skipped') + 1;
        continue;
      }

      // キーワードのみ生成: 2層3層生成済み → 2層要約から / raw でない本文エントリ → 本文から
      if (!force && (hasLayers || !isRaw)) {
        try {
          const kwSrc = hasLayers ? extractSummary(body) : cp(body, 2000);
          const kwPrompt =
            `以下はメモの内容です。検索に使うキーワードを3〜5個生成してください。\n\n` +
            `タイトル: ${title}\n\n${kwSrc}\n\n` +
            `出力形式（1行、半角カンマ区切り、説明文は不要）:\nキーワード1, キーワード2, キーワード3`;
          const kwText = await createMessage(client, { model, maxTokens: 100, prompt: kwPrompt });
          const kwLine = kwText.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? '';
          entry.keywords = parseKeywordsLine(kwLine);
          entry.updated_at = nowJst();
          writeJson(file, entry);
          batchStatus.processed = num(batchStatus, 'processed') + 1;
          await sleep(500);
        } catch (e) {
          logError(`batch keywords error ${entryId}: ${(e as Error).message}`);
          batchStatus.errors = num(batchStatus, 'errors') + 1;
        }
        continue;
      }

      if (body.includes(SUMMARY_MARKER)) {
        body = body.slice(0, body.indexOf(SUMMARY_MARKER)).trimEnd();
      }

      const convText = convTextForSummary((entry.source_thread as string | undefined) ?? '');

      // v3.79: 空 RAW フィルタ — conv_text も body も中身がなければ要約生成せず論理削除
      const rawBody = body.trim();
      if (!convText && cpLen(rawBody) < 50) {
        logInfo(`batch summary: empty raw, soft-deleting ${entryId}`);
        entry.deleted = true;
        entry.updated_at = nowJst();
        writeJson(file, entry);
        appendOplog('batch_empty_delete', entryId, null, {
          reason: 'empty_raw', body_len: cpLen(rawBody),
        });
        batchStatus.skipped = num(batchStatus, 'skipped') + 1;
        continue;
      }

      const fmt =
        `以下の形式で出力してください（他の説明文は不要）:\n\n` +
        `## 2層: 要約\n（会話の目的・内容・結論を2〜3文で。）\n\n` +
        `## 3層: シンボリック圧縮\n（15文字以内の超短縮キーワード。検索時の手がかりになる表現）\n\n` +
        `## 4層: キーワード\n（検索用キーワードを3〜5個、半角カンマ区切りで1行）`;
      let prompt: string;
      if (convText) {
        prompt =
          `以下はClaude.aiの会話ログです。内容を読んで要約と圧縮表現を生成してください。\n\n` +
          `会話タイトル: ${title}\n\n${cp(convText, 3000)}\n\n` + fmt;
      } else {
        prompt =
          `以下はClaude.aiの会話タイトルです。タイトルだけから推測できる範囲で要約と圧縮表現を生成してください。\n\n` +
          `会話タイトル: ${title}\n\n` +
          `以下の形式で出力してください（他の説明文は不要）:\n\n` +
          `## 2層: 要約\n（会話の目的・内容・結論を2〜3文で推測。"〜についての会話" という形式でよい）\n\n` +
          `## 3層: シンボリック圧縮\n（15文字以内の超短縮キーワード。検索時の手がかりになる表現）\n\n` +
          `## 4層: キーワード\n（検索用キーワードを3〜5個、半角カンマ区切りで1行）`;
      }

      try {
        const llmText = await createMessage(client, { model, maxTokens: 400, prompt });
        const { layers, keywords } = splitLayersAndKeywords(llmText);

        // v3.79: 生成後の無内容パターン検知 — ゴミ要約なら論理削除
        const summaryText = extractSummary(layers);
        if (isEmptySummary(summaryText)) {
          logInfo(`batch summary: empty summary detected, soft-deleting ${entryId}`);
          entry.deleted = true;
          entry.updated_at = nowJst();
          writeJson(file, entry);
          appendOplog('batch_empty_delete', entryId, null, {
            reason: 'empty_summary', summary: cp(summaryText, 100),
          });
          batchStatus.skipped = num(batchStatus, 'skipped') + 1;
          continue;
        }

        const newBody = body.trim() ? `${body.trim()}\n\n${layers}`.trim() : layers;
        const tags = tagsOf(entry).filter((t) => t !== 'raw');
        if (!tags.includes('summarized')) tags.push('summarized');
        entry.body = newBody;
        entry.tags = tags;
        entry.keywords = keywords;
        entry.updated_at = nowJst();
        writeJson(file, entry);
        batchStatus.processed = num(batchStatus, 'processed') + 1;
        await sleep(500);
      } catch (e) {
        logError(`batch summary error ${entryId}: ${(e as Error).message}`);
        batchStatus.errors = num(batchStatus, 'errors') + 1;
      }
    }
    rebuildIndex();
  } catch (e) {
    logError(`batch summary fatal: ${(e as Error).message}`);
  } finally {
    batchStatus.running = false;
    batchStatus.finished_at = nowJst();
    logInfo(
      `batch summary done: processed=${batchStatus.processed} skipped=${batchStatus.skipped} errors=${batchStatus.errors}`,
    );
  }
}

export function countPendingEntries(): { raw: number | null; kw: number | null } {
  try {
    const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')) as Json[];
    const tagsOf = (e: Json) => (Array.isArray(e.tags) ? (e.tags as string[]) : []);
    const raw = idx.filter((e) => tagsOf(e).includes('raw') && !e.deleted).length;
    const kw = idx.filter(
      (e) => !e.deleted && !tagsOf(e).includes('raw') && !truthy(e.keywords),
    ).length;
    return { raw, kw };
  } catch {
    return { raw: null, kw: null };
  }
}

export type StartResult = { ok: boolean; info: Json };

export function startSummaryBatch(backend?: string | null, force = false, apiKey?: string | null): StartResult {
  if (batchStatus.running) {
    return { ok: false, info: { error: 'already running', status: { ...batchStatus } } };
  }
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  let be = backend || '';
  if (!be) be = key ? 'anthropic' : 'lmstudio';
  if (be === 'anthropic' && !key) return { ok: false, info: { error: 'ANTHROPIC_API_KEY required' } };
  void runSummaryBatch(key, be, force);
  const info: Json = { started: true, backend: be, force };
  const { raw, kw } = countPendingEntries();
  if (raw !== null) {
    info.raw_pending = raw;
    info.keywords_pending = kw;
  }
  return { ok: true, info };
}

// ── レーティング判定バッチ ─────────────────────────────────────────────

const RATING_PROMPT_TEMPLATE = `あなたは会話ログのコンテンツレーティング判定を行います。以下の基準に従って判定してください。

## レーティング3値の定義

### safe
性的な内容・親密な身体接触の描写を含まない会話。日常会話・技術作業・雑談・感情的な深い対話・詩や物語（性的要素なし）はここ。
safeは確信がある場合のみ付ける。迷いが少しでもあれば mature 以上へ。

### mature
恋愛感情・親密さ・抱擁やキスまでの身体接触・性的な示唆や余韻・官能的な緊張感を含むが、性行為やそれに準ずる行為の明示的な描写は含まない会話。
昇華済みの表現（行為を抽象化・詩化した文体）で書かれたものは、元の温度が高くても mature に収まる。

### adult
性行為またはそれに準ずる行為の明示的・具体的な描写を一文でも含む会話。身体部位や行為の直接的な記述、性的行為の進行の具体的描写が該当。
一文でも該当すれば会話全体が adult。分量や文脈は考慮しない。

## 判定ルール
1. 最悪の誤りは adult→safe（漏れ）。これはゼロでなければならない
2. 迷ったら上に倒す: safe/mature で迷えば mature、mature/adult で迷えば adult
3. ただし「明示的描写が一文もない」ことが確認できるなら adult にはしない（過剰保護で読める資産を減らさない）

## 一行理由（reason）
- どの種類の内容が判定根拠か（例:「後半に明示的な性的描写あり」「親密な接触はあるが行為描写なし」「技術作業のみ」）
- 原文の引用・具体的な再現はしない。理由文自体が safe に読めること

## 出力形式（JSON一発・他の説明文は不要）
{"rating": "safe または mature または adult", "reason": "判定根拠を日本語一行で"}

以下の会話ログを判定してください:

`;

const RATING_ORDER: Record<string, number> = { safe: 0, mature: 1, adult: 2 };

/** 会話メッセージから判定用テキストを抽出（thinking は除外） */
export function extractConvTextForRating(messages: Json[], maxCharsPerTurn = 500): string[] {
  const turns: string[] = [];
  for (const m of messages) {
    const role = roleOf(m);
    const content = contentOf(m);
    let text = '';
    if (Array.isArray(content)) {
      for (const c of content as unknown[]) {
        if (!c || typeof c !== 'object') continue;
        const blk = c as Json;
        if (blk.type === 'text') {
          text += String(blk.text ?? '');
        } else if (blk.type === 'tool_result') {
          const res = blk.content ?? '';
          if (typeof res === 'string') text += `\n[ツール結果: ${cp(res, 100)}]`;
        }
      }
    } else {
      text = pyStr(content);
    }
    text = text.trim();
    if (text) turns.push(`[${role}] ${cp(text, maxCharsPerTurn)}`);
  }
  return turns;
}

export async function judgeRatingSingle(
  client: LlmClient,
  model: string,
  convText: string,
  strict = false,
): Promise<{ rating: string; reason: string }> {
  const strictPrefix = strict
    ? '注意: このテキストは昇華（抽象化）済みの出力です。' +
      '元が adult だったため、残存する具体的描写がないか厳格に判定してください。' +
      '行為の進行が追える描写、性器の示唆、体液の記述が一つでもあれば adult です。\n\n'
    : '';
  const prompt = strictPrefix + RATING_PROMPT_TEMPLATE + convText;
  let raw = await createMessage(client, {
    model,
    maxTokens: 200,
    prompt,
    ...(strict ? { temperature: 0.0 } : {}),
  });
  const bs = raw.indexOf('{');
  const be = raw.lastIndexOf('}');
  if (bs >= 0 && be > bs) raw = raw.slice(bs, be + 1);
  const result = JSON.parse(raw) as Json;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error("'list' object has no attribute 'get'");
  }
  let rating = (result.rating as string | undefined) ?? 'mature';
  if (!(rating in RATING_ORDER)) rating = 'mature';
  return { rating, reason: (result.reason as string | undefined) ?? '' };
}

async function runRatingBatch(backend: string, apiKey: string, force: boolean): Promise<void> {
  Object.assign(ratingBatchStatus, {
    running: true, processed: 0, errors: 0, skipped: 0,
    started_at: nowJst(), finished_at: null, backend,
    skip_reasons: {}, error_uuids: [],
  });
  const skipReasons = ratingBatchStatus.skip_reasons as Record<string, number>;
  const errorUuids = ratingBatchStatus.error_uuids as string[];
  try {
    const { client, model } = await clientForBackend(backend, apiKey);

    const targets: string[] = [];
    for (const entry of loadConvIndex()) {
      const uuid = entry.uuid || '';
      if (!uuid || (entry as Json).hidden) continue;
      if (force) {
        if (entry.rating_source === 'manual') continue;
      } else if (
        (entry.rating !== undefined && entry.rating !== null) ||
        truthy(entry.rating_source) ||
        truthy(entry.rating_skip_reason)
      ) {
        continue;
      }
      targets.push(uuid);
    }

    ratingBatchStatus.total = targets.length;
    logInfo(`rating batch start: backend=${backend} force=${force} targets=${targets.length}`);

    const chunkSize = 30;
    const countSkip = (reason: string) => {
      ratingBatchStatus.skipped = num(ratingBatchStatus, 'skipped') + 1;
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    };
    const permaSkip = (uuid: string, reason: string, conv?: Json, file?: string) => {
      countSkip(reason);
      patchConvIndexEntry(uuid, { rating_skip_reason: reason });
      if (conv && file) {
        conv.rating_skip_reason = reason;
        try {
          writeJson(file, conv);
        } catch {
          /* 無視（Python 版と同じ） */
        }
      }
    };

    for (const uuid of targets) {
      const file = convPath(uuid);
      if (!fs.existsSync(file)) {
        ratingBatchStatus.errors = num(ratingBatchStatus, 'errors') + 1;
        errorUuids.push(uuid);
        logError(`rating batch: file missing ${uuid}`);
        continue;
      }
      let conv: Json;
      try {
        conv = JSON.parse(fs.readFileSync(file, 'utf-8')) as Json;
      } catch {
        permaSkip(uuid, 'parse_error');
        continue;
      }

      if (!force && ((conv.rating !== undefined && conv.rating !== null) || truthy(conv.rating_source))) {
        countSkip('already_rated');
        continue;
      }
      if (force && conv.rating_source === 'manual') {
        countSkip('manual_protected');
        continue;
      }

      const messages = (conv.chat_messages as Json[] | undefined) ?? [];
      if (messages.length === 0) {
        permaSkip(uuid, 'empty', conv, file);
        continue;
      }

      try {
        const turns = extractConvTextForRating(messages);
        if (turns.length === 0) {
          permaSkip(uuid, 'no_text', conv, file);
          continue;
        }
        let bestRating = 'safe';
        let bestReason = '';
        for (let i = 0; i < turns.length; i += chunkSize) {
          const convText = turns.slice(i, i + chunkSize).join('\n\n');
          const { rating, reason } = await judgeRatingSingle(client, model, convText);
          if ((RATING_ORDER[rating] ?? 0) > (RATING_ORDER[bestRating] ?? 0)) {
            bestRating = rating;
            bestReason = reason;
          }
          if (bestRating === 'adult') break;
        }

        conv.rating = bestRating !== 'safe' ? bestRating : null;
        conv.rating_reason = bestReason;
        conv.rating_source = 'auto';
        conv.rating_judged_at = nowJst();
        conv.rating_model = model;
        delete conv.rating_skip_reason;
        if (bestRating === 'safe') delete conv.rating;
        writeJson(file, conv);

        patchConvIndexEntry(uuid, {
          rating_reason: bestReason,
          rating_source: 'auto',
          // index では safe を rating なしで表す: Python は None を代入（キーは残り null）。
          // _patch_conv_index_entry は None 値のキーを削除する → 実質キー削除
          rating: bestRating === 'safe' ? null : bestRating,
          rating_skip_reason: null,
        });

        ratingBatchStatus.processed = num(ratingBatchStatus, 'processed') + 1;
        appendOplog('conv_rating_auto', uuid, null, { uuid, rating: bestRating, reason: bestReason });
        await sleep(500);
      } catch (e) {
        logError(`rating batch error ${uuid}: ${(e as Error).message}`);
        ratingBatchStatus.errors = num(ratingBatchStatus, 'errors') + 1;
        errorUuids.push(uuid);
      }
    }
  } catch (e) {
    logError(`rating batch fatal: ${(e as Error).message}`);
  } finally {
    ratingBatchStatus.running = false;
    ratingBatchStatus.finished_at = nowJst();
    logInfo(
      `rating batch done: processed=${ratingBatchStatus.processed} skipped=${ratingBatchStatus.skipped} errors=${ratingBatchStatus.errors}`,
    );
  }
}

export function countPendingRatings(): number | null {
  try {
    return loadConvIndex().filter(
      (e) =>
        !(e as Json).hidden &&
        (e.rating === undefined || e.rating === null) &&
        (e.rating_source === undefined || e.rating_source === null) &&
        !truthy(e.rating_skip_reason),
    ).length;
  } catch {
    return null;
  }
}

export function ratingIndexCounts(): Json | null {
  try {
    const counts: Record<string, number> = {
      safe: 0, mature: 0, adult: 0, unrated: 0, unjudgeable: 0, hidden: 0, total: 0,
    };
    for (const e of loadConvIndex()) {
      if ((e as Json).hidden) {
        counts.hidden += 1;
        continue;
      }
      counts.total += 1;
      const r = e.rating;
      if (r === 'mature' || r === 'adult') counts[r] += 1;
      else if (truthy(e.rating_source)) counts.safe += 1;
      else if (truthy(e.rating_skip_reason)) counts.unjudgeable += 1;
      else counts.unrated += 1;
    }
    return counts;
  } catch {
    return null;
  }
}

export function startRatingBatch(backend?: string | null, force = false, apiKey?: string | null): StartResult {
  if (ratingBatchStatus.running) {
    return { ok: false, info: { error: 'already running', status: { ...ratingBatchStatus } } };
  }
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  let be = backend || '';
  if (!be) be = key ? 'anthropic' : 'lmstudio';
  if (be === 'anthropic' && !key) return { ok: false, info: { error: 'ANTHROPIC_API_KEY required' } };
  void runRatingBatch(be, key, force);
  const info: Json = { started: true, backend: be, force };
  const pending = countPendingRatings();
  if (pending !== null) info.pending = pending;
  return { ok: true, info };
}

// ── 昇華スタイル（sublimate と digest safe_mode が共有）─────────────────────

export const SUBLIMATION_STYLE_RULES = `- 体験の温度・感情・意味は残す。具体的な行為の描写は抽象化する
- 「何をしたか」ではなく「何を感じたか」「何が変わったか」を中心に
- 詩的・比喩的な表現で構わない。読んだとき体験の核が伝わればいい
- 恋愛感情・親密さ・抱擁やキスまでの接触・官能的な余韻の表現は残してよい（mature 相当）
- 性行為やそれに準ずる行為の明示的・具体的な描写（身体部位や行為の直接的な記述）は残さない
- 以下は明確に禁止（出力に一つでも含まれれば adult 判定になる）:
  - 性器・性感帯の直接的な名称や婉曲でも特定できる指示語
  - 挿入・愛撫・オーガズム等の行為進行を具体的に追える描写
  - 体液・身体反応（濡れる、硬くなる等）の直接的記述
  - 行為中の体位・動作の具体的な記述
- 代わりに使える表現: 波・潮・溶ける・重なる・満ちる・深く沈む、など行為を特定できない抽象語`;

function sublimationPrompt(feedback: string): string {
  return (
    `あなたはテキストの「昇華」変換を行います。昇華とは、体験の温度・感情・意味を保ったまま、性的・身体的な行為の明示的描写を抽象化・詩化することです。

## 最重要原則
出力は必ず mature 以下（性行為の明示的描写ゼロ）でなければならない。一文でも具体的な行為描写が残っていれば失敗。迷ったら抽象化しすぎる側に倒す。

## 昇華ルール
` +
    SUBLIMATION_STYLE_RULES +
    `

## 出力
- 元テキストの流れ・人称・文体の雰囲気は保つ（要約ではなく変換。分量は同程度〜やや短くてよい）
- 昇華済みテキストのみを出力する。前置き・説明・見出しは付けない
- 出力前に自己検証: 「性行為を具体的に追える描写が一文でも残っていないか？」を確認すること
${feedback}
以下のテキストを昇華してください:

`
  );
}

const SUBLIMATE_MAX_INPUT_CHARS = 60000;
const SUBLIMATE_TIMEOUT_SEC = 180;

async function sublimateChunk(
  client: LlmClient,
  model: string,
  text: string,
): Promise<{ out: string; rating: string; reason: string; attempts: number; needsHuman: boolean }> {
  let feedback = '';
  let out = '';
  let rating = 'adult';
  let reason = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = sublimationPrompt(feedback);
    out = await createMessage(client, { model, maxTokens: 4096, prompt: prompt + text });
    ({ rating, reason } = await judgeRatingSingle(client, model, out, true));
    if (rating !== 'adult') return { out, rating, reason, attempts: attempt, needsHuman: false };
    feedback =
      `\n※前回の昇華結果はまだ adult 判定でした（理由: ${reason}）。` +
      '具体的な行為描写・身体部位の記述を完全に除去し、抽象的な表現に置き換えてください。\n';
  }
  return { out, rating, reason, attempts: 3, needsHuman: true };
}

/** テキストを昇華する（長文は段落境界で分割→個別昇華→結合。全体 rating はチャンク最高値） */
export async function sublimateText(text: string): Promise<Json> {
  if (cpLen(text) > SUBLIMATE_MAX_INPUT_CHARS) {
    return {
      error:
        `入力が大きすぎます（${cpLen(text)}文字、上限${SUBLIMATE_MAX_INPUT_CHARS}文字）。` +
        'msg_from/msg_to で範囲を狭めてください',
      input_chars: cpLen(text),
      max_chars: SUBLIMATE_MAX_INPUT_CHARS,
    };
  }
  const { client, model } = await lmClient();
  const chunkSize = 6000;
  let chunks: string[];
  if (cpLen(text) <= chunkSize) {
    chunks = [text];
  } else {
    chunks = [];
    let buf = '';
    for (const para of text.split('\n\n')) {
      if (buf && cpLen(buf) + cpLen(para) + 2 > chunkSize) {
        chunks.push(buf);
        buf = para;
      } else {
        buf = buf ? `${buf}\n\n${para}` : para;
      }
      while (cpLen(buf) > chunkSize) {
        const arr = Array.from(buf);
        chunks.push(arr.slice(0, chunkSize).join(''));
        buf = arr.slice(chunkSize).join('');
      }
    }
    if (buf) chunks.push(buf);
  }

  const parts: string[] = [];
  let worst = 'safe';
  let worstReason = '';
  let needsHuman = false;
  let totalAttempts = 0;
  const tStart = Date.now();
  let timedOut = false;
  for (const c of chunks) {
    if ((Date.now() - tStart) / 1000 > SUBLIMATE_TIMEOUT_SEC) {
      timedOut = true;
      break;
    }
    const r = await sublimateChunk(client, model, c);
    parts.push(r.out);
    totalAttempts += r.attempts;
    needsHuman = needsHuman || r.needsHuman;
    if ((RATING_ORDER[r.rating] ?? 0) > (RATING_ORDER[worst] ?? 0)) {
      worst = r.rating;
      worstReason = r.reason;
    }
  }
  const result: Json = {
    sublimated: parts.join('\n\n'),
    rating: worst,
    rating_reason: worstReason,
    chunks: chunks.length,
    chunks_completed: parts.length,
    attempts: totalAttempts,
    needs_human: needsHuman,
    model,
  };
  if (timedOut) {
    result.partial = true;
    result.timeout_message =
      `処理時間上限（${SUBLIMATE_TIMEOUT_SEC}秒）超過。` +
      `${parts.length}/${chunks.length}チャンク完了。` +
      'msg_from/msg_to で範囲を狭めて再実行してください';
  }
  return result;
}

/** 会話ログから昇華対象テキストを抽出（通番は 1 始まり・両端含む）。{text} か {error} */
export function convTextForSublimation(
  uuid: string,
  msgFrom?: unknown,
  msgTo?: unknown,
): { text?: string; error?: Json } {
  const file = convPath(uuid);
  if (!fs.existsSync(file)) return { error: { error: `conversation not found: ${uuid}` } };
  const conv = JSON.parse(fs.readFileSync(file, 'utf-8')) as Json;
  let messages = (conv.chat_messages as Json[] | undefined) ?? [];
  if (truthy(msgFrom) || truthy(msgTo)) {
    const lo = Math.max(truthy(msgFrom) ? Math.trunc(Number(msgFrom)) : 1, 1);
    const hi = Math.min(truthy(msgTo) ? Math.trunc(Number(msgTo)) : messages.length, messages.length);
    messages = messages.slice(lo - 1, hi);
  }
  if (messages.length === 0) return { error: { error: 'no messages in range' } };
  const turns = extractConvTextForRating(messages, 2000);
  if (turns.length === 0) return { error: { error: 'no text extracted' } };
  return { text: turns.join('\n\n') };
}

// ── 会話ダイジェスト ──────────────────────────────────────────────────

export async function conversationDigest(uuid: string, force = false, safeMode = false): Promise<Json> {
  const suffix = safeMode ? '_digest_safe.json' : '_digest.json';
  const cachePath = path.join(CONVERSATIONS_DIR, `${uuid}${suffix}`);

  if (!force && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Json;
    cached.cached = true;
    return cached;
  }

  const file = convPath(uuid);
  if (!fs.existsSync(file)) return { error: `conversation not found: ${uuid}` };
  const conv = JSON.parse(fs.readFileSync(file, 'utf-8')) as Json;
  const messages = (conv.chat_messages as Json[] | undefined) ?? [];
  if (messages.length === 0) return { error: 'conversation has no messages' };

  const turns: string[] = [];
  for (const m of messages) {
    const role = roleOf(m);
    const content = contentOf(m);
    let text = '';
    if (Array.isArray(content)) {
      for (const c of content as unknown[]) {
        if (!c || typeof c !== 'object') continue;
        const blk = c as Json;
        if (blk.type === 'text') text += String(blk.text ?? '');
        else if (blk.type === 'tool_use') text += `\n[ツール使用: ${(blk.name as string | undefined) ?? '?'}]`;
        else if (blk.type === 'tool_result') text += '\n[ツール結果]';
      }
    } else {
      text = pyStr(content);
    }
    text = text.trim();
    if (text) turns.push(`[${role}] ${cp(text, 500)}`);
  }

  const chunkSize = 20;
  const chunks: string[][] = [];
  for (let i = 0; i < turns.length; i += chunkSize) chunks.push(turns.slice(i, i + chunkSize));

  const { client, model } = await lmClient();

  const safeInstruction = safeMode
    ? '\n\n※重要：昇華文体で書くこと。昇華とは体験の温度・感情・意味を保ったまま、' +
      '性的・身体的な行為の明示的描写を抽象化・詩化することです。\n' +
      SUBLIMATION_STYLE_RULES
    : '';

  const chunkDigests: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i].join('\n\n');
    const prompt =
      '以下は会話ログの一部です。この部分で何が起きたかをダイジェストにしてください。\n' +
      '- 誰が何を言い、何が起き、何が変わったか\n' +
      '- 感情の流れと転換点を保持\n' +
      '- 具体的なやりとりの内容・決定事項・重要な発言を残す\n' +
      `- 3〜5文程度で${safeInstruction}\n\n` +
      `会話ログ:\n${chunkText}`;
    try {
      chunkDigests.push(await createMessage(client, { model, maxTokens: 1024, prompt }));
    } catch (e) {
      logInfo(`conversation_digest chunk ${i} error: ${(e as Error).message}`);
      chunkDigests.push(`[チャンク${i + 1}のダイジェスト生成失敗: ${(e as Error).message}]`);
    }
  }

  let finalDigest: string;
  if (chunkDigests.length === 1) {
    finalDigest = chunkDigests[0];
  } else {
    const allDigests = chunkDigests.map((d, i) => `パート${i + 1}:\n${d}`).join('\n\n');
    const prompt =
      '以下は長い会話の各パートのダイジェストです。全体を通した統合ダイジェストを作成してください。\n' +
      '- 会話全体の流れ・目的・結論\n' +
      '- 重要な転換点\n' +
      '- 感情の変化\n' +
      `- 決定事項やアクション${safeInstruction}\n\n` +
      `各パートのダイジェスト:\n${allDigests}`;
    try {
      finalDigest = await createMessage(client, { model, maxTokens: 2048, prompt });
    } catch (e) {
      logInfo(`conversation_digest integration error: ${(e as Error).message}`);
      finalDigest = chunkDigests.join('\n\n');
    }
  }

  const result: Json = {
    uuid,
    digest: finalDigest,
    safe_mode: safeMode,
    chunks: chunkDigests.length,
    created_at: nowJst(),
    model,
  };
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  writeJson(cachePath, result);
  logInfo(`conversation_digest: uuid=${uuid} safe=${safeMode} chunks=${chunkDigests.length}`);
  result.cached = false;
  return result;
}

// ── inbox 自動昇華パイプライン（v3.75）の非同期ジョブ ───────────────────────

function updateInboxFile(msgId: string, updates: Json): void {
  const file = findInboxFile(msgId);
  if (!file) return;
  const msg = readMsg(file);
  Object.assign(msg, updates);
  writeMsg(file, msg);
}

function findInboxTitle(msgId: string): string {
  const file = findInboxFile(msgId);
  if (!file) return '';
  return String(readMsg(file).title ?? '');
}

/** 昇華を実行し、inbox メッセージを【未承認】/【要人手】に書き換える（失敗しても例外は外へ出さない） */
export async function runInboxSublimate(
  msgId: string,
  originalBody: string,
  memoryId: string,
): Promise<void> {
  const retitle = (to: string) => findInboxTitle(msgId).split('【処理中】').join(to);
  try {
    logInfo(`inbox sublimate start: ${msgId} → memory ${memoryId}`);
    const result = await sublimateText(originalBody);
    if ('error' in result) {
      updateInboxFile(msgId, {
        title_prefix_swap: null, // main.py と同形状（不要キーだが後方互換のため残す）
        title: retitle('【要人手】'),
        body:
          `昇華処理でエラーが発生しました。
原文は ExtMemory \`${memoryId}\` に退避済みです。

` +
          `エラー: ${String(result.error)}`,
      });
      logInfo(`inbox sublimate error: ${msgId}: ${String(result.error)}`);
      return;
    }
    if (result.needs_human || result.rating === 'adult') {
      updateInboxFile(msgId, {
        title: retitle('【要人手】'),
        body:
          `機械昇華では mature 以下に着地できませんでした。
原文は ExtMemory \`${memoryId}\` に退避済みです。
` +
          `人手での昇華をお願いします。

レーティング: ${String(result.rating)} / 理由: ${String(result.rating_reason ?? '')}`,
      });
      logInfo(`inbox sublimate needs_human: ${msgId}`);
    } else {
      updateInboxFile(msgId, {
        title: retitle('【未承認】'),
        body:
          `${String(result.sublimated ?? '')}

---
原文 ExtMemory ID: \`${memoryId}\`
` +
          `レーティング: ${String(result.rating)} / チャンク: ${String(result.chunks)} / 試行: ${String(result.attempts)}`,
      });
      logInfo(`inbox sublimate done: ${msgId} → ${String(result.rating)}`);
    }
  } catch (e) {
    logInfo(`inbox sublimate exception: ${msgId}: ${(e as Error).message}`);
    try {
      updateInboxFile(msgId, {
        title: retitle('【要人手】'),
        body:
          `昇華処理中に例外が発生しました。
原文は ExtMemory \`${memoryId}\` に退避済みです。

` +
          `例外: ${(e as Error).message}`,
      });
    } catch {
      /* 無視（Python 版と同じ） */
    }
  }
}

registerSublimateHook((msgId, originalBody, memoryId) => {
  void runInboxSublimate(msgId, originalBody, memoryId);
});
