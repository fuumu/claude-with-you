/**
 * TS-FULL ステップ6: HTML ページの配信（main.py の send_from_directory と同じ 5 ページ）。
 *   /admin.html  /logs.html  /share.html  /register（.html）  /activate（.html）
 * 認証はページ側（API 呼び出し時）で行うので、ページ自体は誰でも取れる（main.py と同じ）。
 *
 * 置き場所は MIO_STATIC_DIR、なければ ts/public/（Docker イメージ）→ memory/app/（Python 退避前の
 * リポジトリ）の順に探す。どこにも無ければ false を返し、TS 前段構成では Python に任せる。
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES: Record<string, string> = {
  '/admin.html': 'admin.html',
  '/logs.html': 'logs.html',
  '/share.html': 'share.html',
  '/register': 'register.html',
  '/register.html': 'register.html',
  '/activate': 'activate.html',
  '/activate.html': 'activate.html',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  process.env.MIO_STATIC_DIR,
  path.join(here, '..', 'public'),
  path.join(here, '..', '..', 'memory', 'app'),
].filter((d): d is string => !!d);

function findPage(name: string): string | null {
  for (const dir of CANDIDATES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** HTML ページなら返して true。ファイルが見つからなければ false */
export function handleStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const name = PAGES[url.pathname];
  if (!name) return false;
  const file = findPage(name);
  if (!file) return false;
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}
