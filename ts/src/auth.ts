/**
 * 認証: main.py の _extract_bearer / _verify_token と同一契約。
 * - Authorization: Bearer <token> ヘッダ or ?token= クエリ
 * - 有効トークン = MIO_API_TOKEN or oauth_store.json の未失効アクセストークン
 */
import fs from 'node:fs';
import type http from 'node:http';
import { OAUTH_STORE } from './data.js';

const API_TOKEN = process.env.MIO_API_TOKEN ?? 'changeme';

interface OAuthStore {
  clients?: Record<string, unknown>;
  tokens?: Record<string, { exp?: number; client_id?: string }>;
}

function loadOAuthTokens(): NonNullable<OAuthStore['tokens']> {
  try {
    const d = JSON.parse(fs.readFileSync(OAUTH_STORE, 'utf-8')) as OAuthStore;
    return d.tokens ?? {};
  } catch {
    return {};
  }
}

export function extractBearer(req: http.IncomingMessage, url: URL): string {
  const auth = req.headers['authorization'] ?? '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }
  return url.searchParams.get('token') ?? '';
}

export function verifyToken(token: string): boolean {
  if (!token) return false;
  if (token === API_TOKEN) return true;
  const info = loadOAuthTokens()[token];
  return !!info && (info.exp ?? 0) > Date.now() / 1000;
}
