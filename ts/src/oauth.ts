/**
 * TS-1 トランスポート前倒し: OAuth 2.1 + Dynamic Client Registration。
 * main.py の oauth_metadata / oauth_register / oauth_authorize / oauth_token と
 * 同一契約（レスポンス形状・ステータス・oauth_store.json 永続化形式）。
 *
 * MCP 2026-07-28 仕様の認可強化（実装済み・main.py には触れない）:
 *   - RFC 9207: 認可応答リダイレクトに iss パラメータを付与（クライアントが検証）
 *   - DCR で application_type を受理・永続化（OIDC リダイレクトURI競合回避）
 *   - リフレッシュトークン発行＋grant_type=refresh_token（使用ごとにローテーション、
 *     scope パラメータによる縮小可）。oauth_store.json に refresh_tokens キーを追加
 *     （Python 実装は clients/tokens しか読まないため互換。Python 側が store を
 *     書き戻すと refresh_tokens は落ちるが、本番 Python 単体運用では未発行なので実害なし）
 *   - ディスカバリ: RFC 8414 のパスサフィックス形式
 *     （/.well-known/oauth-authorization-server/<path>）も受理
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { OAUTH_STORE } from './data.js';
import { API_TOKEN } from './auth.js';

const BASE_URL = process.env.MIO_BASE_URL ?? 'http://localhost:5002';

interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  application_type: string;
  created_at: number;
}

interface OAuthTokenInfo {
  client_id: string;
  scope: string;
  exp: number;
}

interface OAuthRefreshInfo {
  client_id: string;
  scope: string;
  exp: number;
}

interface OAuthStoreShape {
  clients: Record<string, OAuthClient>;
  tokens: Record<string, OAuthTokenInfo>;
  refresh_tokens: Record<string, OAuthRefreshInfo>;
  [key: string]: unknown;
}

const ACCESS_TOKEN_TTL = 3600 * 24 * 30; // 30日（main.py と同一）
const REFRESH_TOKEN_TTL = 3600 * 24 * 90; // 90日

/** 認証コードは短命（10分失効）なので Python 同様にメモリ保持のみ */
const authCodes = new Map<
  string,
  {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string;
    exp: number;
  }
>();

function loadStore(): OAuthStoreShape {
  try {
    const d = JSON.parse(fs.readFileSync(OAUTH_STORE, 'utf-8')) as Partial<OAuthStoreShape>;
    return {
      ...d,
      clients: d.clients ?? {},
      tokens: d.tokens ?? {},
      refresh_tokens: d.refresh_tokens ?? {},
    };
  } catch {
    return { clients: {}, tokens: {}, refresh_tokens: {} };
  }
}

function saveStore(store: OAuthStoreShape): void {
  fs.writeFileSync(OAUTH_STORE, JSON.stringify(store), 'utf-8');
}

function tokenUrlsafe(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
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

/** JSON body → だめなら form-urlencoded（main.py: get_json(silent=True) or request.form） */
function parseBodyLoose(raw: string): Record<string, string> {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(d)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
      return out;
    }
  } catch {
    /* fallthrough to form */
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function authorizeFormHtml(p: Record<string, string>): string {
  const v = (k: string) => escapeHtmlAttr(p[k] ?? '');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>澪の記憶サーバー — 認証</title>
  <style>
    body {font-family:'Helvetica Neue',sans-serif;background:#0f0f1a;color:#c8d8e8;
          display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card {background:#1a1a2e;border:1px solid #2a3a5a;border-radius:12px;
            padding:2rem 2.5rem;width:340px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
    h1 {font-size:1.2rem;margin:0 0 .4rem;color:#7ec8e3}
    p.sub {font-size:.85rem;color:#7a8a9a;margin:0 0 1.6rem}
    label {display:block;font-size:.85rem;margin-bottom:.4rem}
    input[type=password] {width:100%;box-sizing:border-box;padding:.55rem .75rem;
      background:#0f0f1a;border:1px solid #3a4a6a;border-radius:6px;
      color:#c8d8e8;font-size:.95rem}
    button {margin-top:1.2rem;width:100%;padding:.65rem;background:#2a5298;
             border:none;border-radius:6px;color:#fff;font-size:1rem;cursor:pointer}
    button:hover {background:#3a62a8}
    .hint {font-size:.78rem;color:#5a6a7a;margin-top:1rem}
  </style>
</head>
<body>
  <div class="card">
    <h1>澪の記憶サーバー</h1>
    <p class="sub">Claude.ai からのアクセス認証</p>
    <form method="POST">
      <input type="hidden" name="client_id" value="${v('client_id')}">
      <input type="hidden" name="redirect_uri" value="${v('redirect_uri')}">
      <input type="hidden" name="state" value="${v('state')}">
      <input type="hidden" name="code_challenge" value="${v('code_challenge')}">
      <input type="hidden" name="code_challenge_method" value="${v('code_challenge_method')}">
      <input type="hidden" name="scope" value="${v('scope')}">
      <label for="password">APIトークン</label>
      <input type="password" id="password" name="password" placeholder="mio2026..." autocomplete="current-password">
      <button type="submit">接続を許可する</button>
    </form>
    <p class="hint">NAS上の澪の記憶サーバーに<br>Claude.aiからアクセスするための認証画面です。</p>
  </div>
</body>
</html>`;
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    return timingSafeEqual(expected, challenge);
  }
  return timingSafeEqual(verifier, challenge);
}

/** OAuth 系エンドポイントをネイティブ処理。担当ルートなら true を返す */
export async function handleOAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;

  // ── ディスカバリメタデータ ──────────────────────────────────────
  // RFC 8414 パスサフィックス形式（/.well-known/oauth-authorization-server/<path>）も受理
  if (
    (p === '/.well-known/oauth-authorization-server' ||
      p.startsWith('/.well-known/oauth-authorization-server/')) &&
    req.method === 'GET'
  ) {
    sendJson(res, 200, {
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    return true;
  }

  if (
    (p === '/.well-known/oauth-protected-resource' ||
      p.startsWith('/.well-known/oauth-protected-resource/')) &&
    req.method === 'GET'
  ) {
    sendJson(res, 200, {
      resource: BASE_URL,
      authorization_servers: [BASE_URL],
      bearer_methods_supported: ['header', 'query'],
    });
    return true;
  }

  // ── Dynamic Client Registration ────────────────────────────────
  if (p === '/oauth/register' && req.method === 'POST') {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      data = {};
    }
    const clientId = tokenUrlsafe(16);
    const client: OAuthClient = {
      client_id: clientId,
      client_name: typeof data.client_name === 'string' ? data.client_name : 'unknown',
      redirect_uris: Array.isArray(data.redirect_uris) ? (data.redirect_uris as string[]) : [],
      grant_types: Array.isArray(data.grant_types)
        ? (data.grant_types as string[])
        : ['authorization_code'],
      response_types: Array.isArray(data.response_types)
        ? (data.response_types as string[])
        : ['code'],
      token_endpoint_auth_method: 'none',
      // MCP 2026-07-28: クライアントは DCR で application_type を宣言する（OIDC 既定は web）
      application_type: typeof data.application_type === 'string' ? data.application_type : 'web',
      created_at: Date.now() / 1000,
    };
    const store = loadStore();
    store.clients[clientId] = client;
    saveStore(store);
    sendJson(res, 201, client);
    return true;
  }

  // ── 認可エンドポイント ─────────────────────────────────────────
  if (p === '/oauth/authorize' && req.method === 'GET') {
    const q: Record<string, string> = {
      client_id: url.searchParams.get('client_id') ?? '',
      redirect_uri: url.searchParams.get('redirect_uri') ?? '',
      state: url.searchParams.get('state') ?? '',
      code_challenge: url.searchParams.get('code_challenge') ?? '',
      code_challenge_method: url.searchParams.get('code_challenge_method') ?? 'plain',
      scope: url.searchParams.get('scope') ?? 'mcp',
    };
    const store = loadStore();
    if (!(q.client_id in store.clients)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('不明なクライアントです。');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(authorizeFormHtml(q));
    return true;
  }

  if (p === '/oauth/authorize' && req.method === 'POST') {
    const form = parseBodyLoose(await readBody(req));
    const password = (form.password ?? '').trim();
    if (!timingSafeEqual(password, API_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('認証に失敗しました。');
      return true;
    }
    const code = tokenUrlsafe(32);
    authCodes.set(code, {
      client_id: form.client_id ?? '',
      redirect_uri: form.redirect_uri ?? '',
      code_challenge: form.code_challenge ?? '',
      code_challenge_method: form.code_challenge_method ?? 'plain',
      scope: form.scope ?? 'mcp',
      exp: Date.now() / 1000 + 600,
    });
    const redirectUri = form.redirect_uri ?? '';
    const sep = redirectUri.includes('?') ? '&' : '?';
    let location = `${redirectUri}${sep}code=${code}`;
    if (form.state) location += `&state=${encodeURIComponent(form.state)}`;
    // RFC 9207: 認可応答に発行者を明示（クライアントは iss を検証する・MCP 2026-07-28）
    location += `&iss=${encodeURIComponent(BASE_URL)}`;
    res.writeHead(302, { Location: location });
    res.end();
    return true;
  }

  // ── トークンエンドポイント ─────────────────────────────────────
  if (p === '/oauth/token' && req.method === 'POST') {
    const data = parseBodyLoose(await readBody(req));
    const grantType = data.grant_type ?? '';

    if (grantType === 'authorization_code') {
      const codeInfo = authCodes.get(data.code ?? '');
      authCodes.delete(data.code ?? '');
      if (!codeInfo || codeInfo.exp < Date.now() / 1000) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return true;
      }
      if (codeInfo.redirect_uri && codeInfo.redirect_uri !== (data.redirect_uri ?? '')) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return true;
      }
      if (codeInfo.code_challenge) {
        const verifier = data.code_verifier ?? '';
        if (!verifier) {
          sendJson(res, 400, { error: 'invalid_grant', error_description: 'code_verifier required' });
          return true;
        }
        if (!verifyPkce(verifier, codeInfo.code_challenge, codeInfo.code_challenge_method)) {
          sendJson(res, 400, { error: 'invalid_grant', error_description: 'pkce failed' });
          return true;
        }
      }
      const accessToken = tokenUrlsafe(32);
      const refreshToken = tokenUrlsafe(32);
      const store = loadStore();
      store.tokens[accessToken] = {
        client_id: codeInfo.client_id,
        scope: codeInfo.scope,
        exp: Date.now() / 1000 + ACCESS_TOKEN_TTL,
      };
      store.refresh_tokens[refreshToken] = {
        client_id: codeInfo.client_id,
        scope: codeInfo.scope,
        exp: Date.now() / 1000 + REFRESH_TOKEN_TTL,
      };
      saveStore(store);
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL,
        refresh_token: refreshToken,
        scope: codeInfo.scope,
      });
      return true;
    }

    if (grantType === 'refresh_token') {
      // MCP 2026-07-28: リフレッシュトークン対応。使用ごとにローテーション（OAuth 2.1）
      const presented = data.refresh_token ?? '';
      const store = loadStore();
      const info = store.refresh_tokens[presented];
      if (!presented || !info || info.exp < Date.now() / 1000) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return true;
      }
      delete store.refresh_tokens[presented];
      // scope はステップアップ累積済みの付与範囲を上限に、要求があれば縮小のみ許可
      let scope = info.scope;
      if (data.scope) {
        const granted = new Set(info.scope.split(' ').filter(Boolean));
        const requested = data.scope.split(' ').filter(Boolean);
        if (!requested.every((s) => granted.has(s))) {
          saveStore(store);
          sendJson(res, 400, { error: 'invalid_scope' });
          return true;
        }
        scope = requested.join(' ');
      }
      const accessToken = tokenUrlsafe(32);
      const refreshToken = tokenUrlsafe(32);
      store.tokens[accessToken] = {
        client_id: info.client_id,
        scope,
        exp: Date.now() / 1000 + ACCESS_TOKEN_TTL,
      };
      store.refresh_tokens[refreshToken] = {
        client_id: info.client_id,
        scope: info.scope,
        exp: Date.now() / 1000 + REFRESH_TOKEN_TTL,
      };
      saveStore(store);
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL,
        refresh_token: refreshToken,
        scope,
      });
      return true;
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return true;
  }

  return false;
}
