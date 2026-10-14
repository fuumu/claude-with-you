/**
 * TS-1 リング4: MCP tools/list・tools/call のネイティブディスパッチャー。
 *
 * - tools/list: main.py の _MCP_TOOLS を生成したスナップショット（tool-defs.ts）を返す。
 *   定義の同期は scripts/gen_ts_tool_defs.py と tests/test_mcp_core.py の照合テストで担保する。
 * - tools/call: ツール名でハンドラーに振り分ける。ハンドラーは既存の TS モジュール
 *   （data / search / write / coremem / inbox / conversations …）の関数を呼ぶ。
 *   未移行ツールは null を返し、呼び出し側（mcp.ts）が従来どおり Python へ転送する（段階移行）。
 *   グループ別のハンドラーは tools-*.ts に置き、ここで登録する。
 *
 * レスポンス形状は main.py の _handle_tool_call / _process_mcp_message と同一:
 *   result = { content: [{ type: 'text', text: JSON(結果 + server_time + server_version) }] }
 *   list → {data: [...]}、str → {text: ...} にラップしてから server_time/server_version を付与。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, loadEntry, loadIndexList } from './data.js';
import { hierarchicalSearch, randomIndexSample, ratingExcluded } from './search.js';
import { TOOL_DEFS, ToolDef } from './tool-defs.js';
import { Args, FORWARD, Handler, ToolContext, truthy, toInt } from './tool-types.js';
import { ALBUM_HANDLERS } from './tools-album.js';
import { CONVERSATION_HANDLERS } from './tools-conversation.js';
import { COREMEM_HANDLERS } from './tools-coremem.js';
import { FILE_HANDLERS } from './tools-file.js';
import { INBOX_HANDLERS } from './tools-inbox.js';
import { MISC_HANDLERS } from './tools-misc.js';
import { PROJECT_HANDLERS } from './tools-project.js';
import { jstIsoFromMs, mcpUpsertEntry, mcpWriteEntry, nowJst, writeJson } from './write.js';

export type { ToolContext } from './tool-types.js';

const SHARE_TOKENS_FILE = path.join(DATA_ROOT, 'share_tokens.json');
const BASE_URL = process.env.MIO_BASE_URL ?? 'http://localhost:5002';

function injectServerTime(result: unknown, ctx: ToolContext): unknown {
  const st = nowJst();
  if (Array.isArray(result)) {
    return { data: result, server_time: st, server_version: ctx.serverVersion };
  }
  if (typeof result === 'string') {
    return { text: result, server_time: st, server_version: ctx.serverVersion };
  }
  if (result && typeof result === 'object') {
    return { ...(result as object), server_time: st, server_version: ctx.serverVersion };
  }
  return result;
}

// ── グループ1: memory 系 ──────────────────────────────────────────────

const memoryReadIndex: Handler = (args) => {
  const index = loadIndexList();
  const incLocal = truthy(args.include_local);
  const incAdult = truthy(args.include_adult);
  if (args.random !== undefined && args.random !== null) {
    return randomIndexSample(
      index,
      args.random as string | number,
      args.filter === 'summarized',
      incLocal,
      incAdult,
    );
  }
  return index.filter((e) => !ratingExcluded(e, incLocal, incAdult));
};

const memoryRead: Handler = (args) => {
  const entry = loadEntry(String(args.id ?? ''));
  return entry ?? { error: 'not found' };
};

const memoryWrite: Handler = (args) => mcpWriteEntry(args);

const memoryUpsert: Handler = (args) => {
  if (!args.id) return { error: 'id is required' };
  return mcpUpsertEntry(args) ?? { error: 'invalid id' };
};

const memorySearch: Handler = (args) => {
  try {
    const limit = args.limit !== undefined && args.limit !== null ? toInt(args.limit) : 10;
    const offset = args.offset !== undefined && args.offset !== null ? toInt(args.offset) : 0;
    if (Number.isNaN(limit) || Number.isNaN(offset)) {
      throw new Error('invalid literal for int() with base 10');
    }
    return hierarchicalSearch(String(args.q || ''), {
      limit,
      offset,
      fullBody: truthy(args.full_body),
      includeLocal: truthy(args.include_local),
      includeAdult: truthy(args.include_adult),
      includeConversations: truthy(args.include_conversations),
      author: String(args.author || ''),
      searchLayer: String(args.search_layer || ''),
    });
  } catch (e) {
    return { error: String((e as Error).message ?? e), results: [], total: 0, has_more: false };
  }
};

const memoryShare: Handler = (args) => {
  const entryId = String(args.id ?? '');
  if (!loadEntry(entryId)) return { error: `entry not found: ${entryId}` };
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = jstIsoFromMs(Date.now() + 86400 * 1000);
  let tokens: Record<string, unknown> = {};
  try {
    tokens = JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf-8')) as Record<string, unknown>;
  } catch {
    tokens = {};
  }
  tokens[token] = { entry_id: entryId, expires_at: expiresAt };
  writeJson(SHARE_TOKENS_FILE, tokens);
  return {
    token,
    url: `${BASE_URL}/admin.html?token=${token}&id=${entryId}`,
    expires_at: expiresAt,
  };
};

const HANDLERS: Record<string, Handler> = {
  memory_read_index: memoryReadIndex,
  memory_read: memoryRead,
  memory_write: memoryWrite,
  memory_upsert: memoryUpsert,
  memory_search: memorySearch,
  memory_share: memoryShare,
  ...COREMEM_HANDLERS,
  ...INBOX_HANDLERS,
  ...CONVERSATION_HANDLERS,
  ...ALBUM_HANDLERS,
  ...FILE_HANDLERS,
  ...PROJECT_HANDLERS,
  ...MISC_HANDLERS,
};

// ── 公開 API ─────────────────────────────────────────────────────────

/** tools/list の tools（通常セッション用 38 本） */
export function listTools(): ToolDef[] {
  return TOOL_DEFS;
}

/** TS ネイティブで処理できるツールか */
export function isNativeTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

/**
 * tools/call のネイティブ処理。未移行ツールは null（呼び出し側が Python へ転送する）。
 * 戻り値は JSON-RPC の result（{ content: [...] }）。
 */
export async function callToolNative(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<Args | null> {
  if (!isNativeTool(name)) return null;
  const a: Args = args && typeof args === 'object' && !Array.isArray(args) ? (args as Args) : {};
  const raw = await HANDLERS[name](a, ctx);
  if (raw === FORWARD) return null; // ハンドラーが Python 転送を指定（LLM 依存の分岐など）
  // 画像等のマルチコンテンツ応答（album_read）: server_time は本文側に含めて返す
  if (raw && typeof raw === 'object' && '_mcp_content' in (raw as object)) {
    return { content: (raw as { _mcp_content: unknown })._mcp_content };
  }
  const result = injectServerTime(raw, ctx);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
