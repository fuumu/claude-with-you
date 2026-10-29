/**
 * TS-FULL ステップ3: 会話インポート REST（main.py と同一契約）。
 *   POST /import                    claude.ai エクスポート ZIP（conversations.json・memories.json・projects/）
 *   POST /api/import/compare        ZIP と会話ストアのメッセージ数の差分（データは変えない）
 *   POST /api/import/claude-code    Claude Code の .jsonl、または .jsonl を含む .zip
 *   POST /api/import/openwebui      OpenWebUI のチャットエクスポート .json
 *   POST /api/import/unsloth        Unsloth Desktop の .jsonl
 *   GET  /api/import-status         最後の ZIP インポートの記録
 * いずれも Bearer 認証。ファイルは multipart の file、上書きは overwrite=true。
 *
 * main.py との差（意図的）:
 * - 壊れた ZIP・JSON は 500 ではなく 400 を返す
 * - conversations.json は1件ずつ流して処理する（数百 MB でも1本の文字列にしない）。
 *   先に全体を検証してから書き込むので、途中で壊れていても何も変えない
 * - source_thread を紐づけたときも index.json を作り直す（main.py は imported > 0 のときだけで、
 *   紐づけだけの再インポートでは index の source_thread が古いままだった）
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { extractBearer, verifyToken } from './auth.js';
import { artifactsSave } from './coremem.js';
import {
  ArtifactExtractor,
  ConversationSaver,
  convertClaudeCodeSession,
  convertOpenwebuiChat,
  convertUnslothSession,
  convUid,
  existingSourceThreads,
  importEntryId,
  improveConvTitle,
  LinkResult,
  loadImportedUuids,
  readImportStatus,
  remarkEntriesForUpdate,
  saveImportedUuids,
  SaveResult,
  SourceThreadLinker,
  writeImportEntry,
  writeImportStatus,
} from './conv-import.js';
import { CONVERSATIONS_DIR } from './data.js';
import { readBodyBuffer } from './http-body.js';
import { jsonArrayElements } from './json-stream.js';
import { logError, logInfo } from './llm.js';
import { startRatingBatch, startSummaryBatch } from './llm-tasks.js';
import { MultipartFile, parseMultipart } from './multipart.js';
import {
  cpLen,
  cpSlice,
  decodeUtf8Strict,
  fileStem,
  isDict,
  Json,
  jstDateStamp,
  pyGet,
  pyOr,
  pyStr,
  pyTruthy,
  safePathId,
} from './py-compat.js';
import { jstStamp, nowJst, rebuildIndex } from './write.js';
import { listZipEntries, ZipEntry, zipEntryChunks, zipEntryData } from './zip.js';

type Reply = [number, unknown];

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 同名ファイルが複数あれば浅い階層のもの（main.py の os.walk で最初に見つかるもの） */
function findShallowest(entries: ZipEntry[], basename: string): ZipEntry | null {
  let best: ZipEntry | null = null;
  let bestDepth = Infinity;
  for (const e of entries) {
    if (e.isDir) continue;
    const parts = e.name.split('/');
    if (parts[parts.length - 1] !== basename) continue;
    if (parts.length < bestDepth) {
      best = e;
      bestDepth = parts.length;
    }
  }
  return best;
}

/** projects/ ディレクトリ直下の *.json（いちばん浅い projects/ を使う） */
function projectFiles(entries: ZipEntry[]): ZipEntry[] {
  let dir: string | null = null;
  for (const e of entries) {
    const parts = e.name.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== 'projects') continue;
      const candidate = parts.slice(0, i + 1).join('/');
      if (dir === null || candidate.split('/').length < dir.split('/').length ||
        (candidate.split('/').length === dir.split('/').length && candidate < dir)) {
        dir = candidate;
      }
    }
  }
  if (dir === null) return [];
  return entries
    .filter((e) => !e.isDir && e.name.endsWith('.json') && path.posix.dirname(e.name) === dir)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function autoBatch(imported: number, remarked: number): void {
  if ((imported > 0 || remarked > 0) && process.env.MIO_IMPORT_AUTO_BATCH !== 'off') {
    const s = startSummaryBatch();
    logInfo(s.ok ? `auto summary batch started: backend=${s.info.backend}` : `auto summary batch not started: ${s.info.error}`);
    const r = startRatingBatch();
    logInfo(r.ok ? `auto rating batch started: backend=${r.info.backend}` : `auto rating batch not started: ${r.info.error}`);
  }
}

const EMPTY_SAVE: SaveResult = { saved: 0, updated: 0, skipped: 0, updated_uuids: [] };
const EMPTY_LINK: LinkResult = { linked: 0, by_pattern: 0, by_time: 0, unmatched: 0 };

/** 保存→remark→紐づけを main.py の順に行う（コンバーター系3ルートの共通部分） */
function saveRemarkLink(convs: Json[], label: string): { conv: SaveResult; remarked: number; link: LinkResult } {
  let conv = EMPTY_SAVE;
  try {
    const saver = new ConversationSaver();
    for (const c of convs) saver.add(c);
    conv = saver.finish();
  } catch (e) {
    logError(`${label} conv save error: ${errMsg(e)}`);
  }
  let remarked = 0;
  if (conv.updated_uuids.length > 0) {
    try {
      remarked = remarkEntriesForUpdate(conv.updated_uuids);
    } catch (e) {
      logError(`remark for update error: ${errMsg(e)}`);
    }
  }
  let link = EMPTY_LINK;
  try {
    const linker = new SourceThreadLinker();
    for (const c of convs) linker.add(c);
    link = linker.finish();
  } catch (e) {
    logError(`source_thread link error: ${errMsg(e)}`);
  }
  return { conv, remarked, link };
}

function resultOf(imported: number, skipped: number, errors: number | null, conv: SaveResult, remarked: number,
  link: LinkResult): Json {
  const result: Json = { imported, skipped };
  if (errors !== null) result.errors = errors;
  Object.assign(result, {
    conversations_saved: conv.saved,
    conversations_updated: conv.updated,
    source_threads_linked: link.linked,
  });
  if (remarked > 0) result.entries_remarked = remarked;
  return result;
}

/** コンバーター系で変換済みの会話から ExtMemory エントリを作る */
function createConvEntries(convs: Json[], titlePrefix: string, tag: string, author: string,
  importedUuids: Set<string>): number {
  convs.forEach((conv, i) => {
    const uid = String(conv.uuid);
    writeImportEntry({
      id: importEntryId(i, uid),
      created_at: pyOr(conv.created_at, nowJst()),
      updated_at: nowJst(),
      title: `${titlePrefix} ${pyStr(conv.name)}`,
      body: '',
      tags: ['会話ログ', tag, 'raw'],
      source_thread: uid,
      importance: 'low',
      author,
      deleted: false,
    });
    importedUuids.add(uid);
  });
  return convs.length;
}

// ── POST /import ─────────────────────────────────────────────────────

async function importZip(file: MultipartFile, overwrite: boolean): Promise<Reply> {
  if (!file.filename.toLowerCase().endsWith('.zip')) return [400, { error: 'zip file required' }];
  const buf = file.data;
  let entries: ZipEntry[];
  try {
    entries = listZipEntries(buf);
  } catch (e) {
    return [400, { error: `invalid zip: ${errMsg(e)}` }];
  }
  const convEntry = findShallowest(entries, 'conversations.json');
  if (!convEntry) return [400, { error: 'conversations.json not found in zip' }];
  const elements = () => jsonArrayElements(zipEntryChunks(buf, convEntry), { requireArray: true });

  // 1周目: 全体を検証する（壊れていたら何も書かない。main.py は json.load で先に全体を読んでいた）
  try {
    for await (const _ of elements()) { /* 読むだけ */ }
  } catch (e) {
    return [400, { error: `invalid conversations.json: ${errMsg(e)}` }];
  }

  let imported = 0;
  let skipped = 0;
  const importedUuids = loadImportedUuids();
  const existingThreads = existingSourceThreads();
  const saver = new ConversationSaver();
  const linker = new SourceThreadLinker();
  const extractor = new ArtifactExtractor(overwrite);

  // 2周目: 1件ずつ ExtMemory エントリ作成 → 会話の保存 → 紐づけの記録 → アーティファクト抽出
  let i = -1;
  for await (const el of elements()) {
    i++;
    if (!isDict(el)) {
      skipped++;
      continue;
    }
    const conv = el;
    const uid = convUid(conv);
    if (uid && !safePathId(uid)) {
      logError(`ZIP import: unsafe uuid skipped: ${uid}`);
      skipped++;
      continue;
    }
    if (!uid || (!overwrite && (importedUuids.has(uid) || existingThreads.has(uid)))) {
      skipped++;
    } else {
      const title = improveConvTitle(conv) ?? pyStr(pyOr(conv.name, conv.title, cpSlice(uid, 8)));
      writeImportEntry({
        id: importEntryId(i, uid),
        created_at: pyGet(conv, 'created_at', nowJst()),
        updated_at: nowJst(),
        title: `[会話] ${title}`,
        body: '',
        tags: ['会話ログ', 'raw'],
        source_thread: uid,
        importance: 'low',
        author: 'mio',
        deleted: false,
      });
      importedUuids.add(uid);
      imported++;
    }
    for (const [step, fn] of [['conv save', () => saver.add(conv)], ['source_thread link', () => linker.add(conv)],
      ['artifact extract', () => extractor.add(conv)]] as const) {
      try {
        fn();
      } catch (e) {
        logError(`${step} error: ${errMsg(e)}`);
      }
    }
  }

  let conv = EMPTY_SAVE;
  try {
    conv = saver.finish();
  } catch (e) {
    logError(`conv save error: ${errMsg(e)}`);
  }
  let remarked = 0;
  if (conv.updated_uuids.length > 0) {
    try {
      remarked = remarkEntriesForUpdate(conv.updated_uuids);
    } catch (e) {
      logError(`remark for update error: ${errMsg(e)}`);
    }
  }
  let link = EMPTY_LINK;
  try {
    link = linker.finish();
  } catch (e) {
    logError(`source_thread link error: ${errMsg(e)}`);
  }
  let artifactsExtracted = 0;
  try {
    artifactsExtracted = extractor.finish();
  } catch (e) {
    logError(`artifact extract error: ${errMsg(e)}`);
  }

  // memories.json（claude.ai のメモリー）→ CoreMem core_memories_{日付}.md
  let artifactName: string | null = null;
  const memEntry = findShallowest(entries, 'memories.json');
  if (memEntry) {
    try {
      const memories = JSON.parse(decodeUtf8Strict(zipEntryData(buf, memEntry))) as unknown;
      if (Array.isArray(memories) && memories.length > 0) {
        const content = pyGet(memories[0], 'conversations_memory', '');
        if (pyTruthy(content)) {
          artifactName = `core_memories_${jstDateStamp()}.md`;
          artifactsSave(artifactName, pyStr(content));
        }
      }
    } catch (e) {
      logError(`memories.json import error: ${errMsg(e)}`);
    }
  }

  // projects/*.json → [project] エントリ
  for (const pe of projectFiles(entries)) {
    let proj: unknown;
    try {
      proj = JSON.parse(decodeUtf8Strict(zipEntryData(buf, pe)));
    } catch (e) {
      logError(`project import error (${pe.name}): ${errMsg(e)}`);
      continue;
    }
    if (!isDict(proj) || pyTruthy(proj.is_starter_project)) continue;
    const projUuid = pyStr(pyGet(proj, 'uuid', ''));
    if (!overwrite && (importedUuids.has(projUuid) || existingThreads.has(projUuid))) {
      skipped++;
      continue;
    }
    const bodyLines = [
      `## ${pyStr(pyGet(proj, 'name', ''))}`,
      `uuid: ${projUuid}`,
      `description: ${pyStr(pyGet(proj, 'description', ''))}`,
      `created_at: ${pyStr(pyGet(proj, 'created_at', ''))}`,
    ];
    const docs = pyGet(proj, 'docs', []);
    if (Array.isArray(docs) && docs.length > 0) {
      bodyLines.push(`\n## Knowledge (${docs.length}件)`);
      for (const doc of docs) {
        bodyLines.push(`- ${pyStr(pyGet(doc, 'filename', ''))}: ${cpSlice(pyStr(pyGet(doc, 'content', '')), 200)}...`);
      }
    }
    writeImportEntry({
      id: `${jstStamp()}_proj_${cpSlice(projUuid, 8)}`,
      created_at: pyGet(proj, 'created_at', nowJst()),
      updated_at: nowJst(),
      title: `[project] ${pyStr(pyGet(proj, 'name', cpSlice(projUuid, 8)))}`,
      body: bodyLines.join('\n'),
      tags: ['project', 'raw'],
      source_thread: projUuid,
      importance: 'low',
      author: 'mio',
      deleted: false,
    });
    importedUuids.add(projUuid);
    imported++;
  }

  if (imported > 0 || link.linked > 0) rebuildIndex();
  saveImportedUuids(importedUuids);

  logInfo(`ZIP import: imported=${imported} skipped=${skipped} conv_updated=${conv.updated} remarked=${remarked} ` +
    `memories=${artifactName} conv_saved=${conv.saved} artifacts_extracted=${artifactsExtracted}`);
  if (imported > 0 || remarked > 0 || artifactName) writeImportStatus(file.filename);
  const result: Json = {
    imported,
    skipped,
    conversations_saved: conv.saved,
    conversations_updated: conv.updated,
    artifacts_extracted: artifactsExtracted,
    source_threads_linked: link.linked,
  };
  if (remarked > 0) result.entries_remarked = remarked;
  if (artifactName) {
    result.memories_imported = true;
    result.memories_artifact = artifactName;
  }
  autoBatch(imported, remarked);
  return [200, result];
}

// ── POST /api/import/compare ─────────────────────────────────────────

async function importCompare(file: MultipartFile): Promise<Reply> {
  if (!file.filename.toLowerCase().endsWith('.zip')) return [400, { error: 'zip file required' }];
  let entries: ZipEntry[];
  try {
    entries = listZipEntries(file.data);
  } catch (e) {
    return [400, { error: `invalid zip: ${errMsg(e)}` }];
  }
  const convEntry = findShallowest(entries, 'conversations.json');
  if (!convEntry) return [400, { error: 'conversations.json not found in zip' }];
  const results: Json[] = [];
  try {
    for await (const el of jsonArrayElements(zipEntryChunks(file.data, convEntry), { requireArray: true })) {
      if (!isDict(el)) continue;
      const uid = convUid(el);
      if (!uid) continue;
      const zipCount = Array.isArray(el.chat_messages) ? el.chat_messages.length : 0;
      const title = pyStr(pyOr(el.name, el.title, cpSlice(uid, 8)));
      const fpath = path.join(CONVERSATIONS_DIR, `${uid}.json`);
      if (safePathId(uid) && fs.existsSync(fpath)) {
        let localCount = -1;
        try {
          const old = JSON.parse(fs.readFileSync(fpath, 'utf-8')) as Json;
          localCount = Array.isArray(old.chat_messages) ? old.chat_messages.length : 0;
        } catch {
          localCount = -1;
        }
        const diff = zipCount - localCount;
        const action = diff > 0 ? 'update' : diff === 0 ? 'skip' : 'skip (local has more)';
        results.push({ uuid: uid, title, zip_msgs: zipCount, local_msgs: localCount, diff, action });
      } else {
        results.push({ uuid: uid, title, zip_msgs: zipCount, local_msgs: 0, diff: zipCount, action: 'new' });
      }
    }
  } catch (e) {
    return [400, { error: `invalid conversations.json: ${errMsg(e)}` }];
  }
  return [200, {
    total_in_zip: results.length,
    new: results.filter((r) => r.action === 'new').length,
    updatable: results.filter((r) => r.action === 'update').length,
    skip: results.filter((r) => String(r.action).startsWith('skip')).length,
    conversations: results,
  }];
}

// ── POST /api/import/claude-code ─────────────────────────────────────

function importClaudeCode(file: MultipartFile, overwrite: boolean): Reply {
  const fname = file.filename || '';
  const sessions: [string, () => Buffer][] = [];
  if (fname.toLowerCase().endsWith('.zip')) {
    let entries: ZipEntry[];
    try {
      entries = listZipEntries(file.data);
    } catch (e) {
      return [400, { error: `invalid zip: ${errMsg(e)}` }];
    }
    for (const e of entries) {
      if (e.isDir) continue;
      const parts = e.name.split('/');
      const base = parts[parts.length - 1];
      if (parts.slice(0, -1).includes('subagents') || !base.endsWith('.jsonl')) continue;
      sessions.push([base.slice(0, -'.jsonl'.length), () => zipEntryData(file.data, e)]);
    }
  } else if (fname.toLowerCase().endsWith('.jsonl')) {
    sessions.push([fileStem(fname), () => file.data]);
  } else {
    return [400, { error: 'jsonl or zip file required' }];
  }

  let skipped = 0;
  let errors = 0;
  const convs: Json[] = [];
  const importedUuids = loadImportedUuids();
  const existingThreads = existingSourceThreads();
  for (const [sid, data] of sessions) {
    if (!overwrite && (importedUuids.has(sid) || existingThreads.has(sid))) {
      skipped++;
      continue;
    }
    if (!safePathId(sid)) {
      logError(`claude-code import: unsafe session id skipped: ${sid}`);
      skipped++;
      continue;
    }
    let conv: Json | null;
    try {
      conv = convertClaudeCodeSession(data(), sid);
    } catch (e) {
      logError(`claude-code convert error (${sid}): ${errMsg(e)}`);
      errors++;
      continue;
    }
    if (!conv) {
      skipped++;
      continue;
    }
    convs.push(conv);
  }
  const imported = createConvEntries(convs, '[会話/Code]', 'claude-code', 'claude-code', importedUuids);
  const { conv, remarked, link } = saveRemarkLink(convs, 'claude-code');
  if (imported > 0 || link.linked > 0) rebuildIndex();
  saveImportedUuids(importedUuids);
  logInfo(`claude-code import: imported=${imported} skipped=${skipped} errors=${errors} conv_saved=${conv.saved} ` +
    `conv_updated=${conv.updated} remarked=${remarked}`);
  autoBatch(imported, remarked);
  return [200, resultOf(imported, skipped, errors, conv, remarked, link)];
}

// ── POST /api/import/openwebui ───────────────────────────────────────

async function importOpenwebui(file: MultipartFile, overwrite: boolean): Promise<Reply> {
  const fname = file.filename || '';
  if (!fname.toLowerCase().endsWith('.json')) return [400, { error: 'JSON file required' }];

  // 配列（通常）または1件のオブジェクト。それ以外は main.py と同じく 400
  let i = 0;
  const data = file.data;
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) i = 3;
  while (i < data.length && [0x20, 0x09, 0x0a, 0x0d].includes(data[i])) i++;
  if (data[i] !== 0x5b && data[i] !== 0x7b) {
    try {
      JSON.parse(decodeUtf8Strict(data));
    } catch (e) {
      return [400, { error: `Invalid JSON: ${errMsg(e)}` }];
    }
    return [400, { error: 'Expected JSON array of chat objects' }];
  }

  let skipped = 0;
  let errors = 0;
  const convs: Json[] = [];
  const importedUuids = loadImportedUuids();
  const existingThreads = existingSourceThreads();
  try {
    for await (const chatObj of jsonArrayElements([data])) {
      if (!isDict(chatObj)) {
        skipped++;
        continue;
      }
      const cidRaw = pyOr(chatObj.id, pyGet(pyGet(chatObj, 'chat', {}), 'id', ''));
      const cid = pyTruthy(cidRaw) ? pyStr(cidRaw) : '';
      if (!cid) {
        skipped++;
        continue;
      }
      if (!overwrite && (importedUuids.has(cid) || existingThreads.has(cid))) {
        skipped++;
        continue;
      }
      let conv: Json | null;
      try {
        conv = convertOpenwebuiChat(chatObj);
      } catch (e) {
        logError(`openwebui convert error (${cid}): ${errMsg(e)}`);
        errors++;
        continue;
      }
      if (!conv) {
        skipped++;
        continue;
      }
      if (!safePathId(String(conv.uuid))) {
        logError(`openwebui import: unsafe chat id skipped: ${conv.uuid}`);
        skipped++;
        continue;
      }
      convs.push(conv);
    }
  } catch (e) {
    return [400, { error: `Invalid JSON: ${errMsg(e)}` }];
  }

  const imported = createConvEntries(convs, '[会話/OpenWebUI]', 'openwebui', 'openwebui', importedUuids);
  const { conv, remarked, link } = saveRemarkLink(convs, 'openwebui');
  if (imported > 0 || link.linked > 0) rebuildIndex();
  saveImportedUuids(importedUuids);
  logInfo(`openwebui import: imported=${imported} skipped=${skipped} errors=${errors} conv_saved=${conv.saved} ` +
    `conv_updated=${conv.updated} remarked=${remarked}`);
  autoBatch(imported, remarked);
  return [200, resultOf(imported, skipped, errors, conv, remarked, link)];
}

// ── POST /api/import/unsloth ─────────────────────────────────────────

function importUnsloth(file: MultipartFile, overwrite: boolean): Reply {
  const fname = file.filename || '';
  if (!fname.toLowerCase().endsWith('.jsonl')) return [400, { error: 'JSONL file required' }];
  const sessionId = fileStem(fname);
  let skipped = 0;
  let errors = 0;
  const convs: Json[] = [];
  const importedUuids = loadImportedUuids();
  const existingThreads = existingSourceThreads();
  if ((!overwrite && (importedUuids.has(sessionId) || existingThreads.has(sessionId))) || !safePathId(sessionId)) {
    skipped = 1;
  } else {
    let conv: Json | null = null;
    try {
      conv = convertUnslothSession(file.data, sessionId, fname);
    } catch (e) {
      logError(`unsloth convert error (${sessionId}): ${errMsg(e)}`);
      errors = 1;
    }
    if (conv) convs.push(conv);
    else if (errors === 0) skipped = 1;
  }
  const imported = createConvEntries(convs, '[会話/Unsloth]', 'unsloth', 'unsloth', importedUuids) > 0 ? 1 : 0;
  const { conv, remarked, link } = saveRemarkLink(convs, 'unsloth');
  if (imported > 0 || link.linked > 0) rebuildIndex();
  saveImportedUuids(importedUuids);
  logInfo(`unsloth import: imported=${imported} skipped=${skipped} errors=${errors} conv_saved=${conv.saved} ` +
    `conv_updated=${conv.updated} remarked=${remarked}`);
  autoBatch(imported, remarked);
  return [200, resultOf(imported, skipped, errors, conv, remarked, link)];
}

// ── ルーティング ─────────────────────────────────────────────────────

const POST_ROUTES: Record<string, (file: MultipartFile, overwrite: boolean) => Reply | Promise<Reply>> = {
  '/import': importZip,
  '/api/import/compare': (file) => importCompare(file),
  '/api/import/claude-code': importClaudeCode,
  '/api/import/openwebui': importOpenwebui,
  '/api/import/unsloth': importUnsloth,
};

/** インポート系ルートなら処理して true */
export async function handleImportRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';
  const isStatus = p === '/api/import-status' && method === 'GET';
  const handler = method === 'POST' ? POST_ROUTES[p] : undefined;
  if (!isStatus && !handler) return false;

  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  if (isStatus) {
    sendJson(res, 200, readImportStatus());
    return true;
  }
  const form = parseMultipart(await readBodyBuffer(req), req.headers['content-type']);
  const file = form?.files.file;
  if (!form || !file) {
    sendJson(res, 400, { error: 'file is required' });
    return true;
  }
  const overwrite = (form.fields.overwrite ?? 'false').toLowerCase() === 'true';
  const [status, body] = await handler!(file, overwrite);
  sendJson(res, status, body);
  return true;
}
