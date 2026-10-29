/**
 * TS-FULL ステップ6: 友達 REST（main.py と同一契約）。友達の MCP セッション自体は friend.ts。
 *   POST   /api/friends/register          登録申請（認証不要・register.html）
 *   POST   /api/friends/activate          接続コードの確認（認証不要・activate.html）
 *   GET    /api/friends/invitation        招待文 friend_invitation.md（認証不要）
 *   GET    /api/friends                   一覧（admin.html）
 *   POST   /api/friends/<seq>/approve     承認（pending → active）
 *   POST   /api/friends/<seq>/send_email  接続コードのメール（SendGrid。SENDGRID_API_KEY / SENDGRID_FROM_EMAIL）
 *   POST   /api/friends/direct_register   管理者が直接登録（active で作る）
 *   POST   /api/friends/<seq>/revoke      取り消し
 *   DELETE /api/friends/<seq>             完全削除（/data/friends/{seq:03d}/ ごと）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { extractBearer, verifyToken } from './auth.js';
import { artifactsRead } from './coremem.js';
import { Friend, FRIENDS_DIR, loadRegistry, saveRegistry } from './friend.js';
import { readBodyText } from './http-body.js';
import { logError, logInfo } from './llm.js';
import { pyGet, pyStr, pyStrip, pyTruthy } from './py-compat.js';
import { nowJst } from './write.js';

const BASE_URL = process.env.MIO_BASE_URL ?? 'http://localhost:5002';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const registerBase = () => process.env.MIO_REGISTER_URL || BASE_URL;
const activationUrl = (token: string) => `${registerBase().replace(/\/+$/, '')}/activate?token=${token}`;
const sendgridConfigured = () => !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);
const seqDir = (seq: number) => path.join(FRIENDS_DIR, String(seq).padStart(3, '0'));

/** JSON ボディ（main.py の request.get_json() or {}）。読めなければ null */
async function jsonBody(req: http.IncomingMessage): Promise<unknown | null> {
  try {
    const d = JSON.parse(await readBodyText(req)) as unknown;
    return pyTruthy(d) ? d : {};
  } catch {
    return null;
  }
}

const field = (d: unknown, key: string) => {
  const v = pyGet(d, key, '');
  return pyStrip(pyTruthy(v) ? pyStr(v) : '');
};

function tokenBySeq(reg: Record<string, Friend>, seq: number): string | null {
  return Object.keys(reg).find((t) => reg[t].seq_no === seq) ?? null;
}

function nextSeqNo(reg: Record<string, Friend>): number {
  const nums = Object.values(reg).map((v) => Number(v.seq_no));
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

/** memory.md の「- **」で始まる行数（覚えていることの件数） */
function countMemories(seq: number): number {
  try {
    return fs.readFileSync(path.join(seqDir(seq), 'memory.md'), 'utf-8').split('\n').filter((l) => l.startsWith('- **')).length;
  } catch {
    return 0;
  }
}

function emailTaken(reg: Record<string, Friend>, email: string): boolean {
  return Object.values(reg).some((v) => v.email === email && v.status !== 'revoked');
}

async function sendApprovalEmail(nickname: string, email: string, token: string): Promise<boolean> {
  const key = process.env.SENDGRID_API_KEY ?? '';
  const from = process.env.SENDGRID_FROM_EMAIL ?? '';
  if (!key || !from) {
    logError('SendGrid not configured (SENDGRID_API_KEY or SENDGRID_FROM_EMAIL missing)');
    return false;
  }
  const activate = `${registerBase()}/activate`;
  const payload = {
    personalizations: [{ to: [{ email, name: nickname }] }],
    from: { email: from, name: '澪' },
    subject: '澪への接続コードをお送りします',
    content: [{
      type: 'text/plain',
      value: `こんにちは、${nickname}さん。\n\n澪への接続コードをお送りします。\n\nコード：${token}\n\n` +
        `以下のページを開いて、コードを入力してください。\n${activate}\n\nご不明な点は淳さんまで。`,
    }],
  };
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return [200, 201, 202].includes(r.status);
  } catch (e) {
    logError(`SendGrid error: ${(e as Error).message}`);
    return false;
  }
}

async function register(req: http.IncomingMessage, direct: boolean): Promise<[number, unknown]> {
  const d = await jsonBody(req);
  if (d === null) return [400, { error: 'invalid JSON' }];
  const nickname = field(d, 'nickname');
  const email = field(d, 'email');
  if (!nickname || !email) return [400, { error: 'nickname と email は必須です' }];
  const reg = loadRegistry();
  if (emailTaken(reg, email)) return [409, { error: 'このメールアドレスはすでに登録されています' }];
  const token = crypto.randomUUID();
  const seqNo = nextSeqNo(reg);
  const now = nowJst();
  reg[token] = direct
    ? { seq_no: seqNo, nickname, email, status: 'active', created_at: now, approved_at: now }
    : { seq_no: seqNo, nickname, email, status: 'pending', created_at: now };
  saveRegistry(reg);
  logInfo(`friends: ${direct ? 'direct_register' : 'register'} seq_no=${seqNo} nickname=${nickname}`);
  if (direct) return [201, { ok: true, seq_no: seqNo, token, activation_url: activationUrl(token) }];
  return [201, { message: '登録申請を受け付けました。承認後にメールが届きます。' }];
}

/** 友達 REST なら処理して true */
export async function handleFriendsRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';
  if (p !== '/api/friends' && !p.startsWith('/api/friends/')) return false;

  // 認証不要の公開エンドポイント（register.html / activate.html）
  if (p === '/api/friends/register' && method === 'POST') {
    const [status, body] = await register(req, false);
    sendJson(res, status, body);
    return true;
  }
  if (p === '/api/friends/invitation' && method === 'GET') {
    const r = artifactsRead('friend_invitation.md', null);
    sendJson(res, 200, { content: typeof r.content === 'string' ? r.content : '' });
    return true;
  }
  if (p === '/api/friends/activate' && method === 'POST') {
    const d = await jsonBody(req);
    const token = d === null ? '' : field(d, 'token');
    const friend = token ? loadRegistry()[token] : undefined;
    if (!friend || friend.status !== 'active') {
      sendJson(res, 400, { error: '無効なコードです。' });
    } else {
      sendJson(res, 200, { nickname: friend.nickname, mcp_url: `${BASE_URL}/mcp?token=${token}` });
    }
    return true;
  }

  const bySeq = /^\/api\/friends\/(\d+)(?:\/(approve|send_email|revoke))?$/.exec(p);
  const known =
    (p === '/api/friends' && method === 'GET') ||
    (p === '/api/friends/direct_register' && method === 'POST') ||
    (!!bySeq && ((bySeq[2] && method === 'POST') || (!bySeq[2] && method === 'DELETE')));
  if (!known) return false;
  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (p === '/api/friends') {
    const reg = loadRegistry();
    const items = Object.entries(reg).map(([t, v]) => {
      const entry: Record<string, unknown> = { token: t, ...v };
      if (v.status === 'active') {
        entry.memory_count = countMemories(Number(v.seq_no));
        entry.activation_url = activationUrl(t);
      }
      return entry;
    });
    items.sort((a, b) => Number(a.seq_no) - Number(b.seq_no));
    sendJson(res, 200, { items, sendgrid_configured: sendgridConfigured() });
    return true;
  }
  if (p === '/api/friends/direct_register') {
    const [status, body] = await register(req, true);
    sendJson(res, status, body);
    return true;
  }

  const seq = parseInt(bySeq![1], 10);
  const action = bySeq![2];
  const reg = loadRegistry();
  const token = tokenBySeq(reg, seq);
  if (!token) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  const friend = reg[token];
  if (action === 'approve') {
    if (friend.status !== 'pending') {
      sendJson(res, 400, { error: `ステータスが pending ではありません（現在: ${friend.status}）` });
      return true;
    }
    friend.status = 'active';
    friend.approved_at = nowJst();
    saveRegistry(reg);
    logInfo(`friends: approve seq_no=${seq}`);
    sendJson(res, 200, { ok: true, friend: { ...friend, token, activation_url: activationUrl(token) } });
  } else if (action === 'send_email') {
    if (friend.status !== 'active') {
      sendJson(res, 400, { error: 'アクティブな友人のみメール送信できます' });
      return true;
    }
    const ok = await sendApprovalEmail(friend.nickname, String(friend.email ?? ''), token);
    logInfo(`friends: send_email seq_no=${seq} ok=${ok}`);
    if (ok) sendJson(res, 200, { ok: true });
    else sendJson(res, 500, { error: 'メール送信に失敗しました（SendGrid 未設定または送信エラー）' });
  } else if (action === 'revoke') {
    friend.status = 'revoked';
    friend.revoked_at = nowJst();
    saveRegistry(reg);
    logInfo(`friends: revoke seq_no=${seq}`);
    sendJson(res, 200, { ok: true });
  } else {
    const nickname = friend.nickname ?? '?';
    delete reg[token];
    saveRegistry(reg);
    fs.rmSync(seqDir(seq), { recursive: true, force: true });
    logInfo(`friends: delete seq_no=${seq} nickname=${nickname}`);
    sendJson(res, 200, { ok: true });
  }
  return true;
}
