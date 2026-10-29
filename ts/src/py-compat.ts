/**
 * main.py の挙動に合わせるための小さな互換関数（インポート系の移植で使う）。
 * Python の dict.get の既定値・or の真偽判定・コードポイント単位の文字数・
 * json.dumps の既定の区切り文字・datetime.isoformat の書式など。
 */

export type Json = Record<string, unknown>;

export function isDict(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Python の真偽判定（None / False / 0 / '' / 空リスト / 空 dict が偽） */
export function pyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return !!v;
}

/** Python の a or b or c（最初の真の値。なければ最後の値） */
export function pyOr(...vals: unknown[]): unknown {
  for (const v of vals) if (pyTruthy(v)) return v;
  return vals[vals.length - 1];
}

/** Python の d.get(key, default)（キーがあれば null でもその値） */
export function pyGet(d: unknown, key: string, dflt: unknown = null): unknown {
  return isDict(d) && key in d ? d[key] : dflt;
}

/** Python の str(v) / f-string（None → 'None'、True → 'True'） */
export function pyStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return typeof v === 'object' ? pyJsonDumps(v) : String(v);
}

// Python の str.isspace() が真になる文字（JS の \s とは \x1c-\x1f・\x85・﻿ が違う）
const PY_WS = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_STRIP_RE = new RegExp(`^${PY_WS}+|${PY_WS}+$`, 'g');
const PY_RSTRIP_RE = new RegExp(`${PY_WS}+$`);

/** Python の s.strip() */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, '');
}

/** Python の s.rstrip() */
export function pyRstrip(s: string): string {
  return s.replace(PY_RSTRIP_RE, '');
}

/** Python の len(s)（コードポイント単位） */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python の s[:n]（コードポイント単位。サロゲートペアを割らない） */
export function cpSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

/** Python の json.dumps(v, ensure_ascii=False)（区切りは ', ' と ': '） */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(', ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Json).map(([k, x]) => `${JSON.stringify(k)}: ${pyJsonDumps(x)}`).join(', ')}}`;
  }
  return JSON.stringify(String(v));
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Python の datetime.fromtimestamp(sec, tz=JST).isoformat()。
 * マイクロ秒が 0 なら小数部を付けない。年が 1〜9999 を外れると Python と同じく例外
 */
export function pyIsoFromEpochSec(sec: number): string {
  const micros = Math.round(sec * 1e6);
  const ms = Math.floor(micros / 1000);
  const d = new Date(ms + 9 * 3600 * 1000);
  const year = d.getUTCFullYear();
  if (!Number.isFinite(ms) || year < 1 || year > 9999) throw new Error('year is out of range');
  const frac = ((micros % 1e6) + 1e6) % 1e6;
  const base =
    `${pad(year, 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${base}${frac ? '.' + pad(frac, 6) : ''}+09:00`;
}

/** Python の datetime.now(JST).strftime('%Y%m%d') */
export function jstDateStamp(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** Python の os.path.splitext(os.path.basename(name))[0]（区切りは '/' と '\\'） */
export function fileStem(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // splitext は先頭のドット（.bashrc）を拡張子とみなさない
  return dot > 0 && base.slice(0, dot).replace(/^\.+/, '') !== '' ? base.slice(0, dot) : base;
}

/** UTF-8 として厳密にデコードする（不正なバイト列は例外。Python の open(encoding='utf-8') 相当） */
export function decodeUtf8Strict(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

/** Buffer を行ごとに返す（Python のテキストファイルの行反復。巨大ファイルでも1本の文字列にしない） */
export function* bufferLines(buf: Buffer): Generator<Buffer> {
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start);
    if (nl < 0) nl = buf.length;
    yield buf.subarray(start, nl);
    start = nl + 1;
  }
}

/** ID・UUID としてファイル名に使ってよいか（main.py の MCP 入口検証・TS safeId と同じ規則） */
export function safePathId(id: string): boolean {
  return !!id && !id.includes('/') && !id.includes('\\') && !id.includes('..') && !id.includes('\0');
}
