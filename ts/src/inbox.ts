/**
 * TS-1 リング3（inbox スライス）: /api/inbox* REST。
 * main.py の api_inbox_* / _post_inbox_message / _mark_inbox_read /
 * _norm_inbox_models と同一契約（ID採番・正規化・persistent の既読保護・
 * friend サブディレクトリ検索・物理削除）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DATA_ROOT } from './data.js';
import { nowJst } from './write.js';

const INBOX_DIR = path.join(DATA_ROOT, 'inbox');

interface InboxMessage {
  id: string;
  to?: string;
  from?: string;
  title?: string;
  body?: string;
  from_model?: string | string[] | null;
  to_model?: string | string[] | null;
  reply_to_id?: string | null;
  created_at?: string;
  read?: boolean;
  persistent?: boolean;
  [key: string]: unknown;
}

function inboxDir(to?: string | null): string {
  if (to && to.startsWith('friend:')) {
    return path.join(INBOX_DIR, 'friend', to.slice('friend:'.length));
  }
  return INBOX_DIR;
}

function safeId(id: string): boolean {
  return !!id && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

function inboxPath(msgId: string, to?: string | null): string {
  return path.join(inboxDir(to), `${msgId}.json`);
}

/** フラット + friend サブディレクトリから msg_id のファイルを探す */
function findInboxFile(msgId: string): string | null {
  if (!safeId(msgId)) return null;
  const flat = path.join(INBOX_DIR, `${msgId}.json`);
  if (fs.existsSync(flat)) return flat;
  const friendRoot = path.join(INBOX_DIR, 'friend');
  if (fs.existsSync(friendRoot) && fs.statSync(friendRoot).isDirectory()) {
    for (const sub of fs.readdirSync(friendRoot)) {
      const p = path.join(friendRoot, sub, `${msgId}.json`);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function readMsg(p: string): InboxMessage {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as InboxMessage;
}

function writeMsg(p: string, msg: InboxMessage): void {
  fs.writeFileSync(p, JSON.stringify(msg, null, 2), 'utf-8');
}

/** _norm_model_field: 文字列→配列、空/None→null（後方互換） */
function normModelField(val: unknown): string[] | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val ? [val] : null;
  if (Array.isArray(val)) return val.length > 0 ? (val as string[]) : null;
  return null;
}

/** _norm_inbox_models: from_model/to_model/reply_to_id キーを補完（配列は素通し） */
function normInboxModels(msg: InboxMessage): InboxMessage {
  const fm = msg.from_model;
  if (typeof fm === 'string') msg.from_model = fm ? [fm] : null;
  else if (fm === undefined || fm === null) msg.from_model = null;
  const tm = msg.to_model;
  if (typeof tm === 'string') msg.to_model = tm ? [tm] : null;
  else if (tm === undefined || tm === null) msg.to_model = null;
  if (!('reply_to_id' in msg)) msg.reply_to_id = null;
  return msg;
}

function loadInboxMessages(to?: string | null, unreadOnly = false): InboxMessage[] {
  const dir = inboxDir(to);
  fs.mkdirSync(dir, { recursive: true });
  const msgs: InboxMessage[] = [];
  for (const fname of fs.readdirSync(dir).sort()) {
    if (!fname.endsWith('.json')) continue;
    let msg: InboxMessage;
    try {
      msg = readMsg(path.join(dir, fname));
    } catch {
      continue;
    }
    if (to && msg.to !== to) continue;
    if (unreadOnly && msg.read && !msg.persistent) continue;
    msgs.push(msg);
  }
  return msgs;
}

/** _post_inbox_message と同一の ID 採番・メッセージ形状 */
function postInboxMessage(data: Record<string, unknown>): InboxMessage {
  const to = String(data.to);
  const dir = inboxDir(to);
  fs.mkdirSync(dir, { recursive: true });
  const now = nowJst();
  const stamp = now.replace(/:/g, '').replace(/-/g, '').replace('T', '_').slice(0, 15);
  const msgId = `inbox_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
  const msg: InboxMessage = {
    id: msgId,
    to,
    from: typeof data.from === 'string' ? data.from : 'code',
    title: String(data.title ?? ''),
    body: String(data.body ?? ''),
    from_model: normModelField(data.from_model),
    to_model: normModelField(data.to_model),
    reply_to_id: null, // REST POST は reply_to_id を受けない（main.py と同じ）
    created_at: now,
    read: false,
    persistent: Boolean(data.persistent ?? false),
  };
  writeMsg(path.join(dir, `${msgId}.json`), msg);
  return msg;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** /api/inbox* をネイティブ処理。担当ルートなら true（認証は呼び出し側で済み） */
export async function handleInbox(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';

  // GET /api/inbox（一覧）・POST /api/inbox（投稿）
  if (p === '/api/inbox') {
    if (method === 'GET') {
      const to = url.searchParams.get('to');
      const full = (url.searchParams.get('full') ?? 'false').toLowerCase() === 'true';
      const unreadOnly = url.searchParams.get('status') === 'new';
      const msgs = loadInboxMessages(to, unreadOnly);
      if (full) {
        sendJson(res, 200, msgs);
      } else {
        sendJson(res, 200, { count: msgs.length, ids: msgs.map((m) => m.id) });
      }
      return true;
    }
    if (method === 'POST') {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (!data.to || !data.title) {
        sendJson(res, 400, { error: 'to and title are required' });
        return true;
      }
      sendJson(res, 201, postInboxMessage(data));
      return true;
    }
    return false;
  }

  // /api/inbox/<msg_id> と /api/inbox/<msg_id>/{read,unread,persistent}
  const m = /^\/api\/inbox\/([^/]+)(?:\/(read|unread|persistent))?$/.exec(p);
  if (!m) return false;
  const msgId = decodeURIComponent(m[1]);
  const action = m[2];

  if (action === 'read' && method === 'PATCH') {
    const file = findInboxFile(msgId);
    if (!file) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    const msg = readMsg(file);
    if (!msg.persistent) {
      msg.read = true;
      writeMsg(file, msg);
    }
    sendJson(res, 200, normInboxModels(msg));
    return true;
  }

  if (action === 'unread' && method === 'PATCH') {
    // main.py は _inbox_path（フラットのみ・friend 非検索）
    const file = safeId(msgId) ? inboxPath(msgId) : '';
    if (!file || !fs.existsSync(file)) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    const msg = readMsg(file);
    msg.read = false;
    writeMsg(file, msg);
    sendJson(res, 200, msg);
    return true;
  }

  if (action === 'persistent' && method === 'PATCH') {
    const file = safeId(msgId) ? inboxPath(msgId) : '';
    if (!file || !fs.existsSync(file)) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    const value = (url.searchParams.get('value') ?? 'true').toLowerCase() !== 'false';
    const msg = readMsg(file);
    msg.persistent = value;
    writeMsg(file, msg);
    sendJson(res, 200, msg);
    return true;
  }

  if (action) return false;

  if (method === 'GET') {
    const file = findInboxFile(msgId);
    if (!file) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    sendJson(res, 200, normInboxModels(readMsg(file)));
    return true;
  }

  if (method === 'PATCH') {
    const file = findInboxFile(msgId);
    if (!file) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      data = {};
    }
    const msg = readMsg(file);
    for (const key of ['persistent', 'title', 'body']) {
      if (key in data) msg[key] = data[key];
    }
    writeMsg(file, msg);
    sendJson(res, 200, normInboxModels(msg));
    return true;
  }

  if (method === 'DELETE') {
    const file = findInboxFile(msgId);
    if (!file) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    fs.unlinkSync(file);
    sendJson(res, 200, { deleted: msgId });
    return true;
  }

  return false;
}
