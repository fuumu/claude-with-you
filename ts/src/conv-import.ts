/**
 * TS-FULL ステップ3: 会話インポートの共通処理。main.py の _save_conversations /
 * _remark_entries_for_update / _improve_conv_title / _extract_participants /
 * _link_source_threads / extract_artifacts / 各形式のコンバーターと同一契約。
 * ルート（POST /import ほか）は rest-import.ts。
 *
 * 巨大な conversations.json を1件ずつ流して処理できるよう、保存・紐づけ・
 * アーティファクト抽出は「1件ずつ add → 最後に finish」の形にしてある。
 * 処理の結果は main.py の「全件を読んでから段階ごとに回す」形と同じになる。
 *
 * main.py との差（意図的）:
 * - uuid にパス区切り・'..'・NUL を含む会話は保存しない（main.py はそのままパスに使っていた）
 * - アーティファクトのファイル名も同様に検証する
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseIsoTs, resolveIndividual, rosterFirstPattern } from './attendance.js';
import {
  ConvMeta,
  CONVERSATIONS_DIR,
  DATA_DIR,
  DATA_ROOT,
  loadAllEntries,
  loadConvIndex,
  loadEntry,
  MemoryEntry,
} from './data.js';
import { logError, logInfo } from './llm.js';
import {
  bufferLines,
  cpLen,
  cpSlice,
  decodeUtf8Strict,
  isDict,
  Json,
  pyGet,
  pyIsoFromEpochSec,
  pyJsonDumps,
  pyOr,
  pyRstrip,
  pyStr,
  pyStrip,
  pyTruthy,
  safePathId,
} from './py-compat.js';
import { appendOplog, jstStamp, nowJst, rebuildIndex, writeJson } from './write.js';

export const IMPORT_LOG = path.join(DATA_ROOT, 'imported_uuids.json');
export const IMPORT_STATUS_FILE = path.join(DATA_ROOT, '.import_status.json');
export const CONV_ARTIFACTS_DIR = path.join(DATA_ROOT, 'conv_artifacts');
const SUMMARY_MARKER = '## 2層: 要約';

/** 会話更新時に旧ファイルから引き継ぐサーバー側メタデータ（main.py _CONV_SERVER_FIELDS） */
const CONV_SERVER_FIELDS = [
  'rating', 'rating_reason', 'rating_source', 'rating_judged_at', 'rating_model', 'rating_skip_reason',
  'model', 'source',
];

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** 偽の値（None・'' 等）は ''、真の値は str()。Python で後から `if not x` / `x or y` に使う値用 */
const txt = (v: unknown): string => (pyTruthy(v) ? pyStr(v) : '');

/** conv.get('uuid') or conv.get('id', '')（偽なら ''） */
export function convUid(conv: Json): string {
  const v = pyOr(conv.uuid, pyGet(conv, 'id', ''));
  return pyTruthy(v) ? String(v) : '';
}

// ── インポート記録 ─────────────────────────────────────────────────────

export function loadImportedUuids(): Set<string> {
  try {
    return new Set((JSON.parse(fs.readFileSync(IMPORT_LOG, 'utf-8')) as unknown[]).map(String));
  } catch {
    return new Set();
  }
}

export function saveImportedUuids(uuids: Set<string>): void {
  fs.writeFileSync(IMPORT_LOG, JSON.stringify([...uuids]), 'utf-8');
}

/** 既存 ExtMemory の source_thread 集合（再インポートの重複チェック用・main.py v3.60） */
export function existingSourceThreads(): Set<string> {
  const threads = new Set<string>();
  try {
    for (const e of loadAllEntries()) {
      if (e.source_thread && !e.deleted) threads.add(String(e.source_thread));
    }
  } catch {
    /* 読めなければ空 */
  }
  return threads;
}

export function writeImportStatus(filename: string): void {
  fs.writeFileSync(IMPORT_STATUS_FILE, JSON.stringify({ last_filename: filename, imported_at: nowJst() }), 'utf-8');
}

export function readImportStatus(): Json {
  try {
    return JSON.parse(fs.readFileSync(IMPORT_STATUS_FILE, 'utf-8')) as Json;
  } catch {
    return { last_filename: null, imported_at: null };
  }
}

/** インポートで作る ExtMemory エントリ（[会話] 等）を保存して oplog に残す */
export function writeImportEntry(entry: Json): void {
  writeJson(path.join(DATA_DIR, `${entry.id}.json`), entry);
  appendOplog('import', String(entry.id), null, entry);
}

/** インポート用エントリ ID: {YYYYmmdd_HHMMSS}_{i:04d}_{uid[:8]} */
export function importEntryId(i: number, uid: string): string {
  return `${jstStamp()}_${String(i).padStart(4, '0')}_${cpSlice(uid, 8)}`;
}

// ── タイトル改善・参加モデル抽出（main.py v3.96） ───────────────────────

/** main.py _msg_text: メッセージの本文テキスト */
export function msgText(msg: Json): string {
  const content = msg.content;
  if (typeof content === 'string' && pyStrip(content)) return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isDict(block) && block.type === 'text') {
        const t = pyGet(block, 'text', '');
        if (typeof t === 'string' && pyStrip(t)) return t;
      }
    }
  }
  const t = pyOr(msg.text, '');
  return typeof t === 'string' ? t : pyStr(t);
}

const DEFAULT_TITLES_EXACT = new Set(['greeting', 'new chat', 'untitled', 'new conversation', 'chat', '']);
const DEFAULT_TITLE_RE =
  /^(?:(?:good\s+)?(?:morning|evening|afternoon|night)\s+)?greeting(?:\s+(?:exchange|to\s+[\p{L}\p{N}_]+))?$/iu;

/** Anthropic の既定タイトル（Greeting / New chat / Evening greeting 等）か */
export function isDefaultTitle(title: unknown): boolean {
  const s = pyStrip(pyTruthy(title) ? pyStr(title) : '');
  if (DEFAULT_TITLES_EXACT.has(s.toLowerCase())) return true;
  return DEFAULT_TITLE_RE.test(s);
}

/** 最初のユーザーメッセージの冒頭からタイトルを作る（最大 40 文字 + …） */
export function autoTitleFromConv(conv: Json, maxLen = 40): string | null {
  for (const m of arr(conv.chat_messages)) {
    if (!isDict(m)) continue;
    const role = pyOr(m.sender, m.role, '');
    if (role !== 'human' && role !== 'user') continue;
    let text = pyStrip(msgText(m));
    if (!text) continue;
    text = pyStrip(text.replace(/\n/g, ' '));
    if (cpLen(text) > maxLen) text = cpSlice(text, maxLen) + '…';
    return text;
  }
  return null;
}

/** 既定タイトルなら改善後のタイトル、改善不要なら null */
export function improveConvTitle(conv: Json): string | null {
  if (!isDefaultTitle(pyOr(conv.name, conv.title, ''))) return null;
  return autoTitleFromConv(conv);
}

const MODEL_HINT_RE = /(?:You are powered by the model named|powered by)\s+([\p{L}\p{N}_.\- ]+?)[.\s,]/iu;

/** main.py _extract_model_from_conv: 会話からモデル名を推定する */
export function extractModelFromConv(conv: Json): string | null {
  const msgs = arr(conv.chat_messages).filter(isDict);
  for (const msg of msgs) {
    if (msg.sender === 'human') continue;
    const m = pyOr(msg.model, msg.modelName);
    if (pyTruthy(m)) return String(m);
  }
  for (const msg of msgs.slice(0, 5)) {
    const hit = MODEL_HINT_RE.exec(msgText(msg));
    if (hit) return pyStrip(hit[1]);
  }
  for (const msg of msgs.slice(0, 3)) {
    const text = msgText(msg);
    if (text) {
      const individual = resolveIndividual(text);
      if (individual) return rosterFirstPattern(individual);
    }
  }
  const individual = resolveIndividual(pyOr(conv.name, conv.title, ''));
  return individual ? rosterFirstPattern(individual) : null;
}

/** main.py _extract_participants: 応答側のモデル名を重複なしで集める */
export function extractParticipants(conv: Json): string[] {
  const models: string[] = [];
  for (const msg of arr(conv.chat_messages)) {
    if (!isDict(msg) || msg.sender === 'human' || msg.role === 'user') continue;
    const m = pyOr(msg.model, msg.modelName);
    if (pyTruthy(m) && !models.includes(String(m))) models.push(String(m));
  }
  if (models.length === 0) {
    const top = pyTruthy(conv.model) ? String(conv.model) : extractModelFromConv(conv);
    if (top) models.push(top);
  }
  return models;
}

// ── 会話ストアへの保存（main.py _save_conversations） ────────────────────

export interface SaveResult {
  saved: number;
  updated: number;
  skipped: number;
  updated_uuids: string[];
}

function saveConvIndex(index: ConvMeta[]): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  writeJson(path.join(CONVERSATIONS_DIR, '_index.json'), index);
}

/**
 * 会話を1件ずつ個別ファイルに保存し、最後にインデックスを書く。
 * 既存ファイルがあればメッセージ数が多いときだけ更新し、rating 等のサーバー側メタは引き継ぐ
 */
export class ConversationSaver {
  private index: ConvMeta[];
  private readonly existingIndex = new Map<string, ConvMeta>();
  private readonly positions = new Map<string, number[]>();
  readonly result: SaveResult = { saved: 0, updated: 0, skipped: 0, updated_uuids: [] };

  constructor() {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    this.index = loadConvIndex();
    this.index.forEach((e, i) => {
      if (!e.uuid) return;
      this.existingIndex.set(e.uuid, e);
      const list = this.positions.get(e.uuid) ?? [];
      list.push(i);
      this.positions.set(e.uuid, list);
    });
  }

  add(conv: Json): void {
    const uid = convUid(conv);
    if (!uid) return;
    if (!safePathId(uid)) {
      logError(`conv save: unsafe uuid skipped: ${uid}`);
      this.result.skipped++;
      return;
    }
    const fpath = path.join(CONVERSATIONS_DIR, `${uid}.json`);
    const msgCount = arr(conv.chat_messages).length;
    let old: Json | null = null;
    if (fs.existsSync(fpath)) {
      try {
        old = JSON.parse(fs.readFileSync(fpath, 'utf-8')) as Json;
        const oldCount = arr(old.chat_messages).length;
        if (msgCount <= oldCount) {
          this.result.skipped++;
          return;
        }
        logInfo(`conv update: ${uid.slice(0, 8)} msgs ${oldCount}->${msgCount} (+${msgCount - oldCount})`);
        this.result.updated_uuids.push(uid);
        this.result.updated++;
      } catch {
        old = null;
      }
    }
    if (old !== null) {
      for (const k of CONV_SERVER_FIELDS) if (k in old && !(k in conv)) conv[k] = old[k];
    }
    let title = pyStr(pyOr(conv.name, conv.title, cpSlice(uid, 8)));
    const improved = improveConvTitle(conv);
    if (improved) {
      title = improved;
      if (pyTruthy(conv.name)) conv.name = improved;
      else conv.title = improved;
    }
    const participants = extractParticipants(conv);
    if (participants.length > 0) conv.participants = participants;
    writeJson(fpath, conv);

    const meta: ConvMeta = {
      uuid: uid,
      title,
      created_at: pyGet(conv, 'created_at', '') as string,
      updated_at: pyGet(conv, 'updated_at', pyGet(conv, 'created_at', '')) as string,
      message_count: msgCount,
    };
    if (participants.length > 0) meta.participants = participants;
    for (const k of CONV_SERVER_FIELDS) if (pyTruthy(conv[k])) meta[k] = conv[k];
    const oldIdx = this.existingIndex.get(uid);
    if (oldIdx) {
      for (const k of CONV_SERVER_FIELDS) if (k in oldIdx && !(k in meta)) meta[k] = oldIdx[k];
      if (oldIdx.hidden) meta.hidden = true;
      for (const pos of this.positions.get(uid) ?? []) this.index[pos] = meta;
    } else {
      this.index.push(meta);
      this.result.saved++;
    }
  }

  finish(): SaveResult {
    saveConvIndex(this.index);
    logInfo(`_save_conversations: new=${this.result.saved} updated=${this.result.updated} skipped=${this.result.skipped}`);
    return this.result;
  }
}

/** 会話が更新された ExtMemory エントリを再要約の対象（raw）に戻す（main.py v3.84） */
export function remarkEntriesForUpdate(updatedUuids: string[]): number {
  if (updatedUuids.length === 0) return 0;
  const uuidSet = new Set(updatedUuids);
  let remarked = 0;
  for (const entry of loadAllEntries()) {
    const st = entry.source_thread;
    if (!st || !uuidSet.has(String(st)) || entry.deleted) continue;
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (tags.includes('raw')) continue;
    const body = typeof entry.body === 'string' ? entry.body : '';
    if (body.includes(SUMMARY_MARKER)) entry.body = pyRstrip(body.slice(0, body.indexOf(SUMMARY_MARKER)));
    const si = tags.indexOf('summarized');
    if (si >= 0) tags.splice(si, 1);
    tags.push('raw');
    entry.tags = tags;
    for (const k of ['keywords', 'rating', 'rating_reason', 'rating_source', 'rating_judged_at', 'rating_model',
      'rating_skip_reason']) {
      delete entry[k];
    }
    entry.updated_at = nowJst();
    writeJson(path.join(DATA_DIR, `${entry.id}.json`), entry);
    appendOplog('remark_for_update', entry.id, null, { source_thread: st, reason: 'conversation_updated' });
    remarked++;
  }
  if (remarked > 0) rebuildIndex();
  return remarked;
}

// ── source_thread 自動紐づけ（main.py v3.60） ───────────────────────────

const MEMORY_ID_RE = /memory_id\s*[:：]\s*[`"'*＊「]*([0-9]{8}_[0-9]{6}_[^\s`"'。、，,）)\]】」…]+)/g;

/** main.py _conv_message_texts */
function* convMessageTexts(conv: Json): Generator<string> {
  for (const m of arr(conv.chat_messages)) {
    if (!isDict(m)) continue;
    const content = pyOr(m.content, m.text, '');
    if (Array.isArray(content)) {
      yield content
        .filter((c) => isDict(c) && c.type === 'text')
        .map((c) => pyStr(pyGet(c, 'text', '')))
        .join(' ');
    } else {
      yield pyStr(content);
    }
  }
}

export interface LinkResult {
  linked: number;
  by_pattern: number;
  by_time: number;
  unmatched: number;
}

/**
 * インポートした会話と source_thread 未設定の ExtMemory エントリを紐づける。
 * 1. 本文中の `memory_id: <id>` 記載（確実）  2. created_at がちょうど1つの会話の時間範囲に入るもの（補助）
 * 既に source_thread が入っているエントリは上書きしない。
 *
 * add() は一致を記録するだけで、書き込みは finish() でまとめて行う。main.py は
 * remark（更新された会話のエントリを raw に戻す）のあとで紐づけるので、先に書くと
 * いま紐づいたエントリまで remark されてしまう
 */
export class SourceThreadLinker {
  private readonly pending = new Map<string, MemoryEntry>();
  private readonly ranges: [string, number, number][] = [];
  private readonly patternMatches: [MemoryEntry, string][] = [];
  private readonly enabled: boolean;

  constructor() {
    for (const e of loadAllEntries()) {
      if (!e.deleted && !e.source_thread && e.id) this.pending.set(e.id, e);
    }
    this.enabled = this.pending.size > 0;
  }

  private apply(stale: MemoryEntry, uid: string, how: string): void {
    // 長いインポートの間に別のリクエストが書き換えていても上書きしないよう、書く直前に読み直す
    const entry = loadEntry(stale.id) ?? stale;
    if (entry.source_thread || entry.deleted) return;
    const before = { source_thread: pyGet(entry, 'source_thread', '') };
    entry.source_thread = uid;
    entry.updated_at = nowJst();
    writeJson(path.join(DATA_DIR, `${entry.id}.json`), entry);
    appendOplog('link_source_thread', entry.id, before, { source_thread: uid, method: how });
  }

  add(conv: Json): void {
    if (!this.enabled) return;
    const uid = convUid(conv);
    if (!uid) return;
    const start = parseIsoTs(conv.created_at);
    const end = parseIsoTs(conv.updated_at) ?? start;
    if (start !== null) this.ranges.push([uid, start, end as number]);
    for (const text of convMessageTexts(conv)) {
      for (const m of text.matchAll(MEMORY_ID_RE)) {
        const entry = this.pending.get(m[1]);
        if (entry !== undefined) {
          this.pending.delete(m[1]);
          this.patternMatches.push([entry, uid]);
        }
      }
    }
  }

  finish(): LinkResult {
    if (!this.enabled) return { linked: 0, by_pattern: 0, by_time: 0, unmatched: 0 };
    for (const [entry, uid] of this.patternMatches) this.apply(entry, uid, 'pattern');
    const byPattern = this.patternMatches.length;
    let byTime = 0;
    for (const eid of [...this.pending.keys()]) {
      const ts = parseIsoTs(this.pending.get(eid)!.created_at);
      if (ts === null) continue;
      const hits = new Set(this.ranges.filter(([, s, e]) => s <= ts && ts <= e).map(([u]) => u));
      if (hits.size === 1) {
        this.apply(this.pending.get(eid)!, [...hits][0], 'time');
        this.pending.delete(eid);
        byTime++;
      }
    }
    const result = { linked: byPattern + byTime, by_pattern: byPattern, by_time: byTime,
      unmatched: this.pending.size };
    logInfo(`source_thread link: ${JSON.stringify(result)}`);
    return result;
  }
}

// ── 会話内アーティファクト抽出（main.py extract_artifacts） ─────────────

const ARTIFACT_EXT_MAP: Record<string, string> = {
  python: '.py', javascript: '.js', typescript: '.ts', html: '.html', css: '.css', bash: '.sh',
  shell: '.sh', json: '.json', markdown: '.md', '': '.txt',
};

export function convArtifactsIndexPath(): string {
  return path.join(CONV_ARTIFACTS_DIR, '_index.json');
}

/** _index.json（過去の重複は (conv_uuid, filename) ごとに後勝ち・並びは最初の出現順） */
export function loadConvArtifactsIndex(): Json[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(convArtifactsIndexPath(), 'utf-8'));
  } catch {
    return [];
  }
  const seen = new Map<string, Json>();
  for (const e of arr(raw)) {
    if (!isDict(e)) continue;
    seen.set(`${pyStr(e.conv_uuid)}\0${pyStr(e.filename)}`, e);
  }
  return [...seen.values()];
}

function safeFileName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/** 会話の tool_use（create_file / artifacts）からファイルを取り出して conv_artifacts に保存する */
export class ArtifactExtractor {
  private index: Json[];
  private readonly existing: Set<string>;
  extracted = 0;

  constructor(private readonly overwrite: boolean) {
    fs.mkdirSync(CONV_ARTIFACTS_DIR, { recursive: true });
    this.index = loadConvArtifactsIndex();
    this.existing = new Set(this.index.map((e) => `${pyStr(e.conv_uuid)}\0${pyStr(e.filename)}`));
  }

  add(conv: Json): void {
    const convUuid = txt(pyGet(conv, 'uuid', ''));
    if (convUuid && !safePathId(convUuid)) return;
    const convName = pyStr(pyOr(conv.name, conv.title, cpSlice(convUuid, 8)));
    const convDate = cpSlice(pyStr(pyOr(conv.updated_at, conv.created_at, '')), 10);
    for (const msg of arr(conv.chat_messages)) {
      if (!isDict(msg) || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!isDict(block) || block.type !== 'tool_use') continue;
        const name = pyGet(block, 'name', '');
        const inp = pyGet(block, 'input', {});
        if (!isDict(inp)) continue;
        let fileContent: unknown = null;
        let filename = '';
        if (name === 'create_file') {
          const p = pyStr(pyGet(inp, 'path', ''));
          fileContent = pyGet(inp, 'file_text', '');
          filename = path.posix.basename(p);
          // /home/claude/ 以下の中間ファイルは除外（outputs/ は含める）
          if (p.includes('/home/claude/') && !p.includes('/mnt/user-data/outputs/')) continue;
        } else if (name === 'artifacts') {
          fileContent = pyGet(inp, 'content', '');
          const artifactId = pyStr(pyGet(inp, 'id', 'unknown'));
          const lang = pyGet(inp, 'language', '');
          const mime = pyStr(pyGet(inp, 'type', ''));
          const ext = mime.includes('react') ? '.jsx' : (ARTIFACT_EXT_MAP[pyStr(lang)] ?? '.txt');
          filename = `${artifactId}${ext}`;
        }
        if (!filename || !pyTruthy(fileContent)) continue;
        if (!safeFileName(filename) || (!convUuid && filename === '_index.json')) continue;
        const key = `${convUuid}\0${filename}`;
        if (this.existing.has(key)) {
          if (!this.overwrite) continue;
          this.index = this.index.filter((e) => !(e.conv_uuid === convUuid && e.filename === filename));
          this.existing.delete(key);
        }
        const text = pyStr(fileContent);
        const destDir = path.join(CONV_ARTIFACTS_DIR, convUuid);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, filename), text, 'utf-8');
        this.index.push({
          conv_uuid: convUuid,
          conv_name: convName,
          conv_date: convDate,
          filename,
          size: cpLen(text),
          path: `${convUuid}/${filename}`,
        });
        this.existing.add(key);
        this.extracted++;
      }
    }
  }

  finish(): number {
    if (this.extracted > 0) writeJson(convArtifactsIndexPath(), this.index);
    return this.extracted;
  }
}

// ── 形式別コンバーター ─────────────────────────────────────────────────

function parseJsonLine(line: Buffer): Json | null {
  const s = pyStrip(decodeUtf8Strict(line));
  if (!s) return null;
  try {
    const rec = JSON.parse(s) as unknown;
    return isDict(rec) ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code セッション JSONL → 会話（main.py _convert_claude_code_session）。
 * user / assistant のレコードだけ（isMeta / isSidechain は除外）。メッセージが無ければ null。
 * 不正な UTF-8 は例外（呼び出し側で errors に数える）
 */
export function convertClaudeCodeSession(buf: Buffer, sessionId: string): Json | null {
  let title = '';
  let fallbackTitle = '';
  const messages: Json[] = [];
  let firstTs: unknown = '';
  let lastTs: unknown = '';
  let model: unknown = '';
  for (const line of bufferLines(buf)) {
    const rec = parseJsonLine(line);
    if (rec === null) continue;
    const rtype = pyGet(rec, 'type', '');
    if (rtype === 'ai-title') {
      title = pyStr(pyOr(pyGet(rec, 'aiTitle', ''), title));
      continue;
    }
    if (rtype === 'summary' && !fallbackTitle) {
      fallbackTitle = txt(pyGet(rec, 'summary', ''));
      continue;
    }
    if (rtype !== 'user' && rtype !== 'assistant') continue;
    if (pyTruthy(rec.isMeta) || pyTruthy(rec.isSidechain)) continue;
    const msg = pyOr(rec.message, {});
    if (!isDict(msg)) continue;
    const raw = msg.content;
    if (raw === null || raw === undefined) continue;
    const ts = pyGet(rec, 'timestamp', '');
    if (pyTruthy(ts)) {
      if (!pyTruthy(firstTs)) firstTs = ts;
      lastTs = ts;
    }
    if (!pyTruthy(model) && pyTruthy(msg.model)) model = msg.model;
    const blocks: Json[] = [];
    const texts: unknown[] = [];
    if (typeof raw === 'string') {
      if (raw) {
        blocks.push({ type: 'text', text: raw });
        texts.push(raw);
      }
    } else if (Array.isArray(raw)) {
      for (const b of raw) {
        if (!isDict(b)) continue;
        const btype = pyGet(b, 'type', '');
        if (btype === 'text') {
          blocks.push({ type: 'text', text: pyGet(b, 'text', '') });
          texts.push(pyGet(b, 'text', ''));
        } else if (btype === 'thinking') {
          blocks.push({ type: 'thinking', thinking: pyGet(b, 'thinking', '') });
        } else if (btype === 'tool_use') {
          blocks.push({ type: 'tool_use', name: pyGet(b, 'name', ''), input: pyGet(b, 'input', {}) });
        } else if (btype === 'tool_result') {
          let content = b.content;
          if (Array.isArray(content)) {
            content = content
              .filter((c) => isDict(c) && c.type === 'text')
              .map((c) => pyStr(pyGet(c, 'text', '')))
              .join('\n');
          }
          blocks.push({ type: 'tool_result', content: typeof content === 'string' ? content : '' });
        }
      }
    }
    if (blocks.length === 0) continue;
    messages.push({
      uuid: pyGet(rec, 'uuid', ''),
      sender: rtype === 'user' ? 'human' : 'assistant',
      text: texts.filter(pyTruthy).map(pyStr).join('\n'),
      content: blocks,
      created_at: ts,
      updated_at: ts,
    });
  }
  if (messages.length === 0) return null;
  if (!title) title = fallbackTitle;
  if (!title) {
    for (const m of messages) {
      if (m.sender === 'human' && m.text) {
        title = cpSlice(pyStrip(String(m.text)).replace(/\n/g, ' '), 40);
        break;
      }
    }
  }
  return {
    uuid: sessionId,
    name: title || cpSlice(sessionId, 8),
    source: 'claude-code',
    model,
    created_at: firstTs,
    updated_at: pyOr(lastTs, firstTs),
    chat_messages: messages,
  };
}

/** タイムスタンプ（数値なら JST の isoformat、それ以外は str） */
function owuiTs(v: unknown): string {
  return typeof v === 'number' ? pyIsoFromEpochSec(v) : pyStr(v);
}

/**
 * OpenWebUI のチャット1件 → 会話（main.py _convert_openwebui_chat）。
 * history.messages（ツリー）があればそれを timestamp 順に、なければ messages 配列を使う
 */
export function convertOpenwebuiChat(chatObj: Json): Json | null {
  const chatData = pyGet(chatObj, 'chat', chatObj);
  if (!isDict(chatData)) throw new Error('chat is not an object');
  const chatId = txt(pyOr(chatObj.id, pyGet(chatData, 'id', '')));
  let title = pyStr(pyOr(chatObj.title, chatData.title, ''));
  let createdAt = pyTruthy(chatObj.created_at) ? owuiTs(chatObj.created_at) : '';
  let updatedAt = pyTruthy(chatObj.updated_at) ? owuiTs(chatObj.updated_at) : '';

  let rawMsgs: unknown[] = [];
  const history = pyGet(chatData, 'history', {});
  const histTree = isDict(history) ? history.messages : undefined;
  if (isDict(histTree) && Object.keys(histTree).length > 0) {
    const chain: Json[] = [];
    for (const [mid, mdata] of Object.entries(histTree)) {
      const entry: Json = { ...(isDict(mdata) ? mdata : {}) };
      if (!('id' in entry)) entry.id = mid;
      chain.push(entry);
    }
    const key = (m: Json) => (typeof m.timestamp === 'number' ? m.timestamp : 0);
    chain.sort((a, b) => key(a) - key(b));
    rawMsgs = chain;
  }
  if (rawMsgs.length === 0) rawMsgs = arr(pyOr(chatData.messages, []));
  if (rawMsgs.length === 0) return null;

  const models = pyGet(chatData, 'models', []);
  const model = Array.isArray(models) && models.length > 0 ? models[0] : '';

  const messages: Json[] = [];
  for (const m of rawMsgs) {
    if (!isDict(m)) continue;
    const role = pyGet(m, 'role', '');
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const contentRaw = pyGet(m, 'content', '');
    let text = '';
    const toolCalls: Json[] = [];
    if (role === 'assistant' && !pyTruthy(contentRaw)) {
      let outputs = pyOr(m.output, m.outputs, []);
      if (!Array.isArray(outputs)) outputs = [outputs];
      const textParts: string[] = [];
      for (const out of outputs as unknown[]) {
        if (!isDict(out)) continue;
        const outType = pyGet(out, 'type', '');
        if (outType === 'message') {
          for (const c of arr(pyOr(out.content, []))) {
            if (isDict(c) && c.type === 'output_text') {
              const t = pyGet(c, 'text', '');
              if (pyTruthy(t)) textParts.push(pyStr(t));
            } else if (isDict(c) && pyTruthy(c.text)) {
              textParts.push(pyStr(c.text));
            }
          }
        } else if (outType === 'function_call') {
          const tc: Json = { name: pyGet(out, 'name', ''), status: pyGet(out, 'status', '') };
          if (pyTruthy(out.arguments)) tc.arguments = cpSlice(pyStr(out.arguments), 200);
          toolCalls.push(tc);
        }
      }
      text = textParts.join('\n\n');
    } else {
      text = typeof contentRaw === 'string' ? contentRaw : pyJsonDumps(contentRaw);
    }
    if (!text && role !== 'system' && toolCalls.length === 0) continue;

    const ts = pyTruthy(m.timestamp) ? owuiTs(m.timestamp) : '';
    if (!createdAt && ts) createdAt = ts;
    if (ts) updatedAt = ts;
    const blocks: Json[] = [{ type: 'text', text }];
    if (toolCalls.length > 0) blocks.push({ type: 'tool_calls', tool_calls: toolCalls });
    const msgEntry: Json = {
      uuid: pyGet(m, 'id', ''),
      sender: role === 'user' ? 'human' : 'assistant',
      text,
      content: blocks,
      created_at: ts,
      updated_at: ts,
    };
    const mModel = pyOr(m.model, m.modelName, '');
    if (pyTruthy(mModel)) msgEntry.model = mModel;
    messages.push(msgEntry);
  }
  if (messages.length === 0) return null;
  if (!title) {
    for (const msg of messages) {
      if (msg.sender === 'human' && msg.text) {
        title = cpSlice(pyStrip(String(msg.text)).replace(/\n/g, ' '), 40);
        break;
      }
    }
  }
  return {
    uuid: chatId,
    name: title || cpSlice(chatId, 8),
    source: 'openwebui',
    model,
    created_at: createdAt,
    updated_at: updatedAt || createdAt,
    chat_messages: messages,
  };
}

const UNSLOTH_TS_RE = /([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2})/;
const THINKING_RE = /<thinking>([\s\S]*?)<\/thinking>/;

/** ファイル名の 2026-09-01T08-41-31 → 2026-09-01T08:41:31+09:00（Python の strptime と同じく範囲外は不可） */
function unslothCreatedAt(stamp: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(stamp);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (y < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d ||
    dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`;
}

/**
 * Unsloth Desktop の JSONL → 会話（main.py _convert_unsloth_session）。
 * 1行1メッセージ {role, content}。assistant の <thinking> と tool_calls を保持する
 */
export function convertUnslothSession(buf: Buffer, sessionId: string, filename = ''): Json | null {
  let title = '';
  const messages: Json[] = [];
  const empty = { uuid: '', created_at: '', updated_at: '' };
  for (const line of bufferLines(buf)) {
    const rec = parseJsonLine(line);
    if (rec === null) continue;
    const role = pyGet(rec, 'role', '');
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    let contentRaw = pyGet(rec, 'content', '');
    if (typeof contentRaw !== 'string') contentRaw = pyJsonDumps(contentRaw);
    const content = contentRaw as string;

    if (role === 'tool') {
      messages.push({
        uuid: '', sender: 'assistant', text: '',
        content: [{ type: 'tool_result', tool_call_id: pyGet(rec, 'tool_call_id', ''), name: pyGet(rec, 'name', ''),
          content }],
        created_at: '', updated_at: '',
      });
      continue;
    }
    if (role === 'user') {
      if (!title && pyStrip(content)) title = cpSlice(pyStrip(content).replace(/\n/g, ' '), 40);
      messages.push({ ...empty, sender: 'human', text: content, content: [{ type: 'text', text: content }] });
      continue;
    }
    // assistant: [前, thinking1, 間, thinking2, …, 後] に分割
    const blocks: Json[] = [];
    const texts: string[] = [];
    content.split(THINKING_RE).forEach((part, idx) => {
      if (idx % 2 === 0) {
        const t = pyStrip(part ?? '');
        if (t) {
          blocks.push({ type: 'text', text: t });
          texts.push(t);
        }
      } else {
        blocks.push({ type: 'thinking', thinking: pyStrip(part ?? '') });
      }
    });
    const toolCalls = rec.tool_calls;
    if (pyTruthy(toolCalls) && Array.isArray(toolCalls)) {
      const tcList: Json[] = [];
      for (const tc of toolCalls) {
        const fn = isDict(tc) ? pyGet(tc, 'function', {}) : {};
        const entry: Json = { name: pyGet(fn, 'name', ''), id: isDict(tc) ? pyGet(tc, 'id', '') : '' };
        const args = pyGet(fn, 'arguments', '');
        if (pyTruthy(args)) entry.arguments = cpSlice(pyStr(args), 500);
        tcList.push(entry);
      }
      blocks.push({ type: 'tool_calls', tool_calls: tcList });
    }
    if (blocks.length === 0) continue;
    messages.push({ ...empty, sender: 'assistant', text: texts.filter(Boolean).join('\n'), content: blocks });
  }
  if (messages.length === 0) return null;

  let createdAt = '';
  const m = UNSLOTH_TS_RE.exec(filename || sessionId);
  if (m) {
    // strptime に失敗したときの main.py の値（最初の2つの '-' を ':' に置換）も再現する
    createdAt = unslothCreatedAt(m[1]) ?? m[1].replace('-', ':').replace('-', ':');
  }
  return {
    uuid: sessionId,
    name: title || cpSlice(sessionId, 8),
    source: 'unsloth',
    model: '',
    created_at: createdAt,
    updated_at: createdAt,
    chat_messages: messages,
  };
}
