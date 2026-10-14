/** MCP ツールハンドラー共通の型・ヘルパー（tools*.ts で共有） */

export type Args = Record<string, unknown>;

export interface ToolContext {
  /** Python 側 VERSION（/health の version。server_version に載せる） */
  serverVersion: string;
}

/** ハンドラーが返すと、その呼び出しは TS では処理せず Python へ転送される（LLM 依存の分岐など） */
export const FORWARD = Symbol('forward-to-python');

/** ハンドラーは同期・非同期どちらでもよい（URL ダウンロード等は Promise を返す） */
export type Handler = (args: Args, ctx: ToolContext) => unknown | Promise<unknown>;

/** Python の bool() 互換の真偽判定（空配列・空オブジェクト・空文字・0・None は偽） */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** Python の int() 相当。変換不能なら NaN */
export function toInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return NaN;
}

/** Python の dict.get(key, default) 互換（キーがあれば null でもその値を返す） */
export function argOr(args: Args, key: string, dflt: unknown): unknown {
  return key in args ? args[key] : dflt;
}

/** Python os.path.basename 互換（末尾が区切りなら空文字。Windows ではバックスラッシュも区切り） */
export function pyBasename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), process.platform === 'win32' ? p.lastIndexOf('\\') : -1);
  return p.slice(i + 1);
}
