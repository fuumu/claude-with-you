/**
 * TS-1 リング5: 友達セッション（/mcp?token=<friend_token>）のネイティブ化。
 * main.py の _get_friend_by_token / _get_friend_instructions / _handle_friend_tool_call /
 * _FRIEND_MCP_TOOLS と同一契約（定義の正本は friend-defs.ts）。
 *
 * 友達セッションは通常の 38 ツールではなく 6 ツール（friend_memory_* / mio_self_note /
 * friend_inbox_*）だけを持つ。記憶ファイルは /data/friends/{seq_no:03d}/memory.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './data.js';
import { DEFAULT_FRIEND_CORE } from './friend-defs.js';
import {
  findInboxFile,
  inboxStanding,
  loadInboxMessages,
  normInboxModels,
  postInboxMessage,
  readMsg,
  writeMsg,
} from './inbox.js';
import { nowJst, writeJson } from './write.js';

const FRIENDS_DIR = path.join(DATA_ROOT, 'friends');
const FRIENDS_REGISTRY_FILE = path.join(FRIENDS_DIR, 'registry.json');
const FRIEND_CORE_FILE = path.join(DATA_ROOT, 'friend_core.md');

export interface Friend {
  seq_no: number;
  nickname: string;
  email?: string;
  status: string;
  token?: string;
  last_seen?: string;
  [key: string]: unknown;
}

type Registry = Record<string, Friend>;
type Json = Record<string, unknown>;

function loadRegistry(): Registry {
  try {
    return JSON.parse(fs.readFileSync(FRIENDS_REGISTRY_FILE, 'utf-8')) as Registry;
  } catch {
    return {};
  }
}

function saveRegistry(reg: Registry): void {
  fs.mkdirSync(FRIENDS_DIR, { recursive: true });
  writeJson(FRIENDS_REGISTRY_FILE, reg);
}

/** トークンが active な友達のものなら Friend（token 付き）を返す。last_seen を記録する */
export function activeFriendByToken(token: string): Friend | null {
  if (!token) return null;
  const reg = loadRegistry();
  const f = reg[token];
  if (!f || f.status !== 'active') return null;
  try {
    reg[token].last_seen = nowJst();
    saveRegistry(reg);
  } catch {
    /* 記録失敗は無視（Python 版と同じ） */
  }
  return { ...reg[token], token };
}

/** レジストリに存在するトークンか（status 不問） */
export function isRegisteredFriendToken(token: string): boolean {
  if (!token) return false;
  return token in loadRegistry();
}

const seqStr = (f: Friend): string => String(f.seq_no).padStart(3, '0');

/** initialize の instructions（core + 相手のニックネーム + この人との記憶） */
export function friendInstructions(friend: Friend): string {
  let core: string;
  if (fs.existsSync(FRIEND_CORE_FILE)) core = fs.readFileSync(FRIEND_CORE_FILE, 'utf-8');
  else core = DEFAULT_FRIEND_CORE;
  const memoryPath = path.join(FRIENDS_DIR, seqStr(friend), 'memory.md');
  const memory = fs.existsSync(memoryPath)
    ? fs.readFileSync(memoryPath, 'utf-8')
    : 'まだ何も記憶していません。';
  return `${core}\n---\n## あなたが話す相手\nニックネーム：${friend.nickname}\n\n## この人との記憶\n${memory}\n`;
}

const START = '## 覚えていること\n\n';
const END = '\n\n---\n\n## 澪からひとこと';
const HITO = '## 澪からひとこと\n\n';
const EMPTY_MARK = '（まだ何も記録していません）';

/** Python の (v or "").strip() */
function stripArg(v: unknown): string {
  if (v === undefined || v === null || v === false || v === 0) return '';
  return String(v).trim();
}

export function handleFriendToolCall(name: string, args: Json, friend: Friend): Json {
  const memoryDir = path.join(FRIENDS_DIR, seqStr(friend));
  const memoryPath = path.join(memoryDir, 'memory.md');
  const nickname = friend.nickname;
  const today = nowJst().slice(0, 10);

  const load = (): string | null =>
    fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : null;
  const save = (text: string): void => {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryPath, text, 'utf-8');
  };
  const template = (): string =>
    `# memory.md — ${nickname}との記憶\n\n*最終更新: ${today}*\n\n---\n\n` +
    `## 覚えていること\n\n${EMPTY_MARK}\n\n---\n\n## 澪からひとこと\n\n`;
  const updateDate = (text: string): string =>
    text.replace(/\*最終更新: [\d-]+\*/g, `*最終更新: ${today}*`);

  if (name === 'friend_memory_read') {
    const text = load();
    if (text === null) return { content: 'まだ何も記憶していません。' };
    return { content: text };
  }

  if (name === 'friend_memory_write') {
    const content = stripArg(args.content);
    const hitokoto = args.hitokoto;
    if (!content) return { error: 'content is required' };

    let text = load() || template();
    text = updateDate(text);

    const newEntry = `- **${today}** ｜ ${content}`;
    const si = text.indexOf(START);
    const ei = text.indexOf(END);
    if (si !== -1 && ei !== -1) {
      let section = text.slice(si + START.length, ei);
      if (section.includes(EMPTY_MARK)) section = newEntry;
      else section = section.replace(/\n+$/, '') + '\n' + newEntry;
      text = text.slice(0, si + START.length) + section + text.slice(ei);
    } else {
      text += `\n${newEntry}\n`;
    }

    if (hitokoto !== undefined && hitokoto !== null) {
      const h = String(hitokoto).trim();
      const hi = text.indexOf(HITO);
      if (hi !== -1) text = text.slice(0, hi + HITO.length) + h + '\n';
      else text += `\n${HITO}${h}\n`;
    }

    save(text);
    return { ok: true, updated: today };
  }

  if (name === 'friend_memory_delete') {
    const target = stripArg(args.target);
    if (!target) return { error: 'target is required' };

    let text = load();
    if (text === null) return { ok: true, deleted: 0 };

    text = updateDate(text);
    const si = text.indexOf(START);
    const ei = text.indexOf(END);

    if (target === 'all') {
      if (si !== -1 && ei !== -1) {
        text = text.slice(0, si + START.length) + EMPTY_MARK + text.slice(ei);
      }
      const hi = text.indexOf(HITO);
      if (hi !== -1) text = text.slice(0, hi + HITO.length);
      save(text);
      return { ok: true, deleted: 'all' };
    }
    if (si !== -1 && ei !== -1) {
      const section = text.slice(si + START.length, ei);
      let lines = section.split('\n');
      const before = lines.filter((l) => l.startsWith('- **')).length;
      lines = lines.filter((l) => !(l.startsWith('- **') && l.includes(target)));
      const after = lines.filter((l) => l.startsWith('- **')).length;
      let newSection = lines.join('\n');
      if (after === 0) newSection = EMPTY_MARK;
      text = text.slice(0, si + START.length) + newSection + text.slice(ei);
      save(text);
      return { ok: true, deleted: before - after };
    }
    return { ok: true, deleted: 0 };
  }

  if (name === 'mio_self_note') {
    const note = stripArg(args.note);
    if (!note) return { error: 'note is required' };
    const msg = postInboxMessage({ to: 'chat', title: '【澪メモ】', body: note, from: 'friend' });
    return { ok: true, id: msg.id };
  }

  if (name === 'friend_inbox_check') {
    const to = `friend:${friend.token}`;
    const msgs = loadInboxMessages(to, true);
    const unread = msgs.filter((m) => !m.read && !m.persistent);
    return {
      non_persistent_unread_count: unread.length,
      non_persistent_unread_ids: unread.map((m) => m.id),
      persistent: msgs
        .filter((m) => m.persistent)
        .map((m) => ({
          id: m.id,
          title: m.title,
          body: m.body,
          created_at: m.created_at,
          from_model: m.from_model ?? null,
          to_model: m.to_model ?? null,
        })),
      server_time: nowJst(),
    };
  }

  if (name === 'friend_inbox_read') {
    const msgId = args.id === undefined || args.id === null ? '' : String(args.id);
    const file = findInboxFile(msgId);
    if (!file) return { error: `message not found: ${msgId}` };
    const msg = readMsg(file);
    // 常駐（persistent / 期限内の期間常駐）は既読にしない
    if (!inboxStanding(msg)) {
      msg.read = true;
      writeMsg(file, msg);
    }
    return normInboxModels(msg) as Json;
  }

  return { error: `unknown friend tool: ${name}` };
}
