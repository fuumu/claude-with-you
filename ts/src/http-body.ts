/**
 * リクエストボディの読み取り（全モジュール共通）。
 * チャンクは Buffer のまま集め、最後に一度だけ UTF-8 にデコードする。
 * `body += chunk` だと各チャンクを別々にデコードするため、マルチバイト文字が
 * チャンク境界で割れると U+FFFD に化ける（main.py は Werkzeug が全体を読んでからデコードする）。
 */
import type http from 'node:http';

export function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readBodyText(req: http.IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString('utf-8');
}
