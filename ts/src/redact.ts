/**
 * TS-FULL ステップ7: 伏せ字（redact）の生成・承認と REST（main.py _generate_redacted /
 * _approve_redacted / _reject_redacted / api_conversation_redact* と同一契約・v3.69）。
 *   POST /api/conversations/<uuid>/redact           生成（{force}）。adult の会話だけ。未承認で保存
 *   GET  /api/conversations/<uuid>/redacted         生成済みの伏せ字（承認・未承認どちらも）
 *   POST /api/conversations/<uuid>/redact/approve   承認（本文が変わっていたら 400）
 *   POST /api/conversations/<uuid>/redact/reject    差し戻し（キャッシュを消す）
 *   GET  /api/conversations/redact-status           adult 会話の伏せ字状態一覧
 * 承認済みの伏せ字を conversation_read が返す側は tools-conversation.ts。
 *
 * 生成: 会話を文に分けて [mN-sM] を振り、30 文ずつ LLM に「マスクすべき文の番号」を JSON で聞き、
 * 該当文を ●●● に置き換える。キャッシュ {uuid}_redacted.json は本文ハッシュで無効化する。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { extractBearer, verifyToken } from './auth.js';
import { CONVERSATIONS_DIR, loadConvIndex } from './data.js';
import { readBodyText } from './http-body.js';
import { createMessage, lmClient, logError, logInfo } from './llm.js';
import { isDict, Json, pyGet, pyOr, pyStr, pyStrip, pyTruthy, safePathId } from './py-compat.js';
import { nowJst, writeJson } from './write.js';

const REDACT_PROMPT_TEMPLATE = `あなたは会話ログのコンテンツマスク判定を行います。

## マスク対象の定義（rating_policy.md 4章）
- 対象は adult 判定ログのみ
- マスクすべき文 = 「性行為またはそれに準ずる行為の明示的・具体的な描写を含む文」
  （身体部位や行為の直接的な記述、性的行為の進行の具体的描写）
- その文を隠せば残りが mature 相当として読める状態を目指す
- 迷う文はマスク側に倒す（漏れは緩められない）
- 会話の流れ・感情の記述・昇華的表現はマスクしない

## レーティング判定時の理由（位置ヒント）
{rating_reason}

## 入力形式
各文に [mXX-sYY]（メッセージ番号-文番号）のIDが振られています。

## 出力形式（JSON一発・他の説明文は不要）
{"mask": ["m12-s3", "m12-s4", "m18-s1"]}
マスク対象がなければ {"mask": []}

以下の会話ログからマスク対象の文番号を列挙してください:

`;

const CHUNK_SIZE = 30;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const cachePath = (uuid: string) => path.join(CONVERSATIONS_DIR, `${uuid}_redacted.json`);
const convPath = (uuid: string) => path.join(CONVERSATIONS_DIR, `${uuid}.json`);

function readJson(file: string): Json | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return isDict(d) ? d : null;
  } catch {
    return null;
  }
}

/** 文に分ける（句点。！？!? の直後と改行で切る。main.py _split_into_sentences と同じく決定的） */
export function splitIntoSentences(text: string): string[] {
  return text.split(/(?<=[。！？!?])|\r?\n/).map((s) => pyStrip(s ?? '')).filter(Boolean);
}

/** メッセージの本文（content のリストなら text を区切りなしで連結） */
function messageText(m: Json): string {
  const content = pyOr(m.content, m.text, '');
  if (Array.isArray(content)) {
    return content.filter((c) => isDict(c) && c.type === 'text').map((c) => pyStr(pyGet(c, 'text', ''))).join('');
  }
  return pyStr(content);
}

const roleOf = (m: Json) => pyStr(pyOr(m.sender, m.role, '?'));

/** 本文ハッシュ（キャッシュ無効化用・sha256 の先頭 16 桁） */
export function convBodyHash(messages: Json[]): string {
  return crypto.createHash('sha256').update(messages.map(messageText).join(''), 'utf-8').digest('hex').slice(0, 16);
}

type SentenceMap = Map<string, [number, number, string]>;

function numberSentences(messages: Json[]): SentenceMap {
  const map: SentenceMap = new Map();
  messages.forEach((m, mi) => {
    const text = pyStrip(messageText(m));
    if (!text) return;
    splitIntoSentences(text).forEach((sent, si) => map.set(`m${mi + 1}-s${si + 1}`, [mi, si, sent]));
  });
  return map;
}

const sidKey = (s: string): [number, number] => {
  const [m, n] = s.split('-');
  return [parseInt(m.slice(1), 10), parseInt(n.slice(1), 10)];
};

/** 伏せ字を生成して未承認で保存する。LLM が使えなければ例外（main.py と同じく 500） */
export async function generateRedacted(uuid: string, force = false): Promise<Json> {
  if (!force && fs.existsSync(cachePath(uuid))) {
    const cached = readJson(cachePath(uuid));
    const conv = readJson(convPath(uuid));
    if (cached && conv) {
      const msgs = (Array.isArray(conv.chat_messages) ? conv.chat_messages : []).filter(isDict);
      if (cached.body_hash === convBodyHash(msgs)) return { ...cached, cached: true };
    }
  }
  const conv = readJson(convPath(uuid));
  if (!conv) return { error: `conversation not found: ${uuid}` };
  if (conv.rating !== 'adult') return { error: 'only adult-rated conversations can be redacted' };
  const messages = (Array.isArray(conv.chat_messages) ? conv.chat_messages : []).filter(isDict);
  if (messages.length === 0) return { error: 'conversation has no messages' };

  const sentenceMap = numberSentences(messages);
  const bodyHash = convBodyHash(messages);
  const reasonRaw = pyGet(conv, 'rating_reason', '');
  const ratingReason = pyTruthy(reasonRaw) ? pyStr(reasonRaw) : '';
  const { client, model } = await lmClient();

  // メッセージ単位でまとめ、30 文を超えない範囲でチャンクにする
  const allSids = [...sentenceMap.keys()].sort((a, b) => {
    const [am, as] = sidKey(a);
    const [bm, bs] = sidKey(b);
    return am - bm || as - bs;
  });
  const groups = new Map<number, string[]>();
  for (const sid of allSids) {
    const mi = sentenceMap.get(sid)![0];
    groups.set(mi, [...(groups.get(mi) ?? []), sid]);
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const mi of [...groups.keys()].sort((a, b) => a - b)) {
    const sids = groups.get(mi)!;
    if (current.length + sids.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current);
      current = [];
    }
    current.push(...sids);
  }
  if (current.length > 0) chunks.push(current);

  const maskIds: string[] = [];
  for (const chunk of chunks) {
    const lines: string[] = [];
    let prevMi: number | null = null;
    for (const sid of chunk) {
      const [mi, , sent] = sentenceMap.get(sid)!;
      if (mi !== prevMi) {
        lines.push(`\n[${roleOf(messages[mi])}]`);
        prevMi = mi;
      }
      lines.push(`[${sid}] ${sent}`);
    }
    // 置換文字列の $& 等を解釈させないよう関数で渡す
    const prompt = REDACT_PROMPT_TEMPLATE.replace('{rating_reason}', () => ratingReason || '（なし）') + lines.join('\n');
    try {
      let raw = await createMessage(client, { model, maxTokens: 500, prompt });
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
      const masks = pyGet(JSON.parse(raw), 'mask', []);
      for (const s of Array.isArray(masks) ? masks : []) {
        if (typeof s === 'string' && sentenceMap.has(s)) maskIds.push(s);
      }
    } catch (e) {
      logError(`redact judge error for ${uuid}: ${(e as Error).message}`);
    }
  }

  const masked = new Set(maskIds);
  const redactedMessages = messages.map((m, mi) => {
    const text = pyStrip(messageText(m));
    if (!text) return { role: roleOf(m), text: '' };
    const out = splitIntoSentences(text).map((sent, si) => (masked.has(`m${mi + 1}-s${si + 1}`) ? '●●●' : sent));
    return { role: roleOf(m), text: out.join('') };
  });
  const result: Json = {
    uuid,
    approved: false,
    mask_ids: maskIds,
    mask_count: maskIds.length,
    total_sentences: sentenceMap.size,
    redacted_messages: redactedMessages,
    body_hash: bodyHash,
    model,
    created_at: nowJst(),
    approved_at: null,
  };
  writeJson(cachePath(uuid), result);
  logInfo(`redacted generated: uuid=${uuid} masked=${maskIds.length}/${sentenceMap.size}`);
  return { ...result, cached: false };
}

function approveRedacted(uuid: string): Json {
  const data = readJson(cachePath(uuid));
  if (!data) return { error: 'redacted version not found. Generate first.' };
  const conv = readJson(convPath(uuid));
  if (conv) {
    const msgs = (Array.isArray(conv.chat_messages) ? conv.chat_messages : []).filter(isDict);
    if (data.body_hash !== convBodyHash(msgs)) {
      return { error: 'conversation body changed since redaction. Regenerate first.' };
    }
  }
  data.approved = true;
  data.approved_at = nowJst();
  writeJson(cachePath(uuid), data);
  logInfo(`redacted approved: uuid=${uuid}`);
  return { uuid, approved: true, approved_at: data.approved_at, mask_count: data.mask_count ?? 0 };
}

function rejectRedacted(uuid: string): Json {
  if (!fs.existsSync(cachePath(uuid))) return { error: 'redacted version not found' };
  fs.unlinkSync(cachePath(uuid));
  logInfo(`redacted rejected: uuid=${uuid}`);
  return { uuid, rejected: true };
}

function redactStatusList(): Json[] {
  const items: Json[] = [];
  for (const e of loadConvIndex()) {
    if (e.rating !== 'adult') continue;
    const uuid = pyStr(pyGet(e, 'uuid', ''));
    let status = 'not_generated';
    let maskCount: unknown = null;
    if (safePathId(uuid) && fs.existsSync(cachePath(uuid))) {
      const rd = readJson(cachePath(uuid));
      if (rd) {
        status = pyTruthy(rd.approved) ? 'approved' : 'pending_approval';
        maskCount = pyGet(rd, 'mask_count', null);
      }
    }
    items.push({ uuid, title: pyGet(e, 'title', ''), status, mask_count: maskCount, created_at: pyGet(e, 'created_at', '') });
  }
  return items;
}

/** 伏せ字の REST なら処理して true */
export async function handleRedactRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';
  const isStatus = p === '/api/conversations/redact-status' && method === 'GET';
  const m = /^\/api\/conversations\/([^/]+)\/(redact|redacted|redact\/approve|redact\/reject)$/.exec(p);
  const kind = m?.[2];
  const known = isStatus || (kind === 'redacted' ? method === 'GET' : !!kind && method === 'POST');
  if (!known) return false;
  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  if (isStatus) {
    sendJson(res, 200, redactStatusList());
    return true;
  }
  const uuid = decodeURIComponent(m![1]);
  if (!safePathId(uuid)) {
    sendJson(res, 404, { error: kind === 'redacted' ? 'redacted version not found' : `conversation not found: ${uuid}` });
    return true;
  }
  if (kind === 'redact') {
    let data: unknown = {};
    try {
      data = JSON.parse(await readBodyText(req));
    } catch {
      data = {};
    }
    const result = await generateRedacted(uuid, pyTruthy(pyGet(isDict(data) ? data : {}, 'force', false)));
    if ('error' in result) sendJson(res, String(result.error).includes('not found') ? 404 : 400, result);
    else sendJson(res, 200, result);
  } else if (kind === 'redacted') {
    const data = readJson(cachePath(uuid));
    if (!data) sendJson(res, 404, { error: 'redacted version not found' });
    else sendJson(res, 200, data);
  } else if (kind === 'redact/approve') {
    const result = approveRedacted(uuid);
    sendJson(res, 'error' in result ? 400 : 200, result);
  } else {
    const result = rejectRedacted(uuid);
    sendJson(res, 'error' in result ? 404 : 200, result);
  }
  return true;
}
