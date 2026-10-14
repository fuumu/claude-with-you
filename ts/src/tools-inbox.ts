/**
 * TS-1 リング4 グループ3: inbox 系 MCP ツール（main.py _handle_tool_call_raw と同一契約）。
 * inbox_check / inbox_read / inbox_post / inbox_update / inbox_delete
 * 実装は inbox.ts（REST と共有）に委譲する。
 *
 * 【生】を含む chat 宛の inbox_post（原文退避→非同期昇華）は inbox.ts の postInboxMessage 内で
 * 処理される（Ring 5。昇華ジョブ本体は llm-tasks.ts がフック登録）。
 */
import fs from 'node:fs';
import { sessionCheckinUpgrade } from './attendance.js';
import {
  findInboxFile,
  inboxStanding,
  loadInboxMessages,
  normInboxModels,
  postInboxMessage,
  readMsg,
  resolveExpiresAt,
  writeMsg,
} from './inbox.js';
import { Args, Handler, toInt, truthy } from './tool-types.js';
import { jstIsoFromMs } from './write.js';

/** main.py _inbox_model_match: stored（配列 or null）が query と OR 一致するか */
function modelMatch(stored: unknown, query: unknown): boolean {
  if (stored === null || stored === undefined) return false;
  const arr = typeof stored === 'string' ? [stored] : Array.isArray(stored) ? stored : [];
  return arr.includes(query as string);
}

function idArg(args: Args): string {
  const v = args.id;
  return v === undefined || v === null ? '' : String(v);
}

const inboxCheck: Handler = (args) => {
  const to = args.to === undefined || args.to === null ? null : String(args.to);
  const includeRead = truthy(args.include_read);
  // v3.85: mymodel による出席簿チェックイン（仮登録→本登録昇格）
  if (truthy(args.mymodel)) sessionCheckinUpgrade(String(args.mymodel));

  let msgs = loadInboxMessages(to, !includeRead);

  // v3.57: from_model / to_model / days フィルタ
  const filterFrom = args.from_model;
  const filterTo = args.to_model;
  let cutoff: string | null = null;
  if (args.days !== undefined && args.days !== null) {
    const days = toInt(args.days);
    if (!Number.isNaN(days)) cutoff = jstIsoFromMs(Date.now() - days * 86400 * 1000);
  }
  if (truthy(filterFrom) || truthy(filterTo) || cutoff) {
    const filtered = [];
    for (const m of msgs) {
      normInboxModels(m);
      const standing = inboxStanding(m);
      if (cutoff && !standing && String(m.created_at ?? '') < cutoff) continue;
      if (truthy(filterFrom) && !modelMatch(m.from_model, filterFrom) && !standing) continue;
      if (truthy(filterTo) && !modelMatch(m.to_model, filterTo) && !standing) continue;
      filtered.push(m);
    }
    msgs = filtered;
  }

  // v3.57: limit（常駐は制限対象外）
  const standingMsgs = msgs.filter((m) => inboxStanding(m));
  let nonStanding = msgs.filter((m) => !inboxStanding(m));
  if (args.limit !== undefined && args.limit !== null) {
    const limit = toInt(args.limit);
    if (!Number.isNaN(limit)) nonStanding = nonStanding.slice(0, limit);
  }
  msgs = [...standingMsgs, ...nonStanding];

  const unreadNonStanding = msgs.filter((m) => !inboxStanding(m) && !m.read);
  const result: Record<string, unknown> = {
    count: msgs.length,
    ids: msgs.map((m) => m.id),
    non_persistent_unread_count: unreadNonStanding.length,
    non_persistent_unread_ids: unreadNonStanding.map((m) => m.id),
    persistent: msgs
      .filter((m) => inboxStanding(m))
      .map((m) => ({
        id: m.id,
        title: m.title ?? '',
        body: m.body ?? '',
        created_at: m.created_at ?? '',
        from_model: m.from_model ?? null,
        to_model: m.to_model ?? null,
        expires_at: m.expires_at ?? null,
      })),
  };
  if (includeRead) {
    result.unread_count = msgs.filter((m) => !m.read || inboxStanding(m)).length;
    result.messages = msgs.map((m) => ({
      id: m.id,
      read: Boolean(m.read),
      persistent: Boolean(m.persistent),
      title: m.title ?? '',
      from: m.from ?? '',
      to: m.to ?? '',
      from_model: m.from_model ?? null,
      to_model: m.to_model ?? null,
      expires_at: m.expires_at ?? null,
    }));
  }
  return result;
};

const inboxRead: Handler = (args) => {
  const msgId = idArg(args);
  const file = findInboxFile(msgId);
  if (!file) return { error: `message not found: ${msgId}` };
  const msg = readMsg(file);
  // 常駐（persistent / 期限内の期間常駐）は既読にしない。peek=true は既読フラグを変更しない
  if (!truthy(args.peek) && !inboxStanding(msg)) {
    msg.read = true;
    writeMsg(file, msg);
  }
  return normInboxModels(msg);
};

const inboxPost: Handler = (args) => {
  const to = args.to === undefined || args.to === null ? '' : String(args.to);
  const title = args.title === undefined || args.title === null ? '' : String(args.title);
  const body = args.body === undefined || args.body === null ? '' : String(args.body);
  if (!to || !title) return { error: 'to and title are required' };
  // 【生】宛の退避→非同期昇華は postInboxMessage 内で処理される（llm-tasks.ts のフック）

  const persistent = truthy(args.persistent);
  const exp = resolveExpiresAt(args);
  if (exp.error) return { error: exp.error };
  if (persistent && exp.value) return { error: 'persistent and expires_at/ttl_days are exclusive' };
  const replyToId = args.reply_to_id ? String(args.reply_to_id) : null;
  const msg = postInboxMessage(
    {
      to,
      title,
      body,
      from: 'from' in args ? args.from : 'code',
      persistent,
      from_model: args.from_model,
      to_model: args.to_model,
    },
    exp.value,
    replyToId,
  );
  return {
    id: msg.id,
    created_at: msg.created_at,
    persistent,
    from_model: msg.from_model ?? null,
    to_model: msg.to_model ?? null,
    reply_to_id: msg.reply_to_id ?? null,
    expires_at: msg.expires_at ?? null,
  };
};

const inboxUpdate: Handler = (args) => {
  const msgId = idArg(args);
  if (!msgId) return { error: 'id is required' };
  const file = findInboxFile(msgId);
  if (!file) return { error: `message not found: ${msgId}` };
  const msg = readMsg(file);
  if ('expires_at' in args || 'ttl_days' in args) {
    const exp = resolveExpiresAt(args);
    if (exp.error) return { error: exp.error };
    msg.expires_at = exp.value; // null で期限解除
    if (exp.value) {
      msg.persistent = false; // 排他: 期限付きは persistent にしない
      msg.read = false; // 降格済みでも常駐に復帰させる
    }
  }
  for (const key of ['persistent', 'title', 'body']) {
    if (key in args) msg[key] = args[key];
  }
  if (msg.persistent && msg.expires_at) msg.expires_at = null; // 排他: persistent 指定が優先
  if ('read' in args) msg.read = truthy(args.read);
  writeMsg(file, msg);
  return normInboxModels(msg);
};

const inboxDelete: Handler = (args) => {
  const msgId = idArg(args);
  if (!msgId) return { error: 'id is required' };
  const file = findInboxFile(msgId);
  if (!file) return { error: `message not found: ${msgId}` };
  fs.unlinkSync(file);
  return { deleted: msgId };
};

export const INBOX_HANDLERS: Record<string, Handler> = {
  inbox_check: inboxCheck,
  inbox_read: inboxRead,
  inbox_post: inboxPost,
  inbox_update: inboxUpdate,
  inbox_delete: inboxDelete,
};
