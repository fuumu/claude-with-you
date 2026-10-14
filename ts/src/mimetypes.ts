/**
 * Python mimetypes.guess_type(filename)[0] の簡易移植（file_upload(file_path=...) の MIME 推定用）。
 * CPython 組み込みの types_map（/etc/mime.types 等のシステムファイルを読まない場合）に相当する
 * 主要拡張子のみ。未知の拡張子は null（呼び出し側が application/octet-stream にする）。
 * ※ Python は実行環境の /etc/mime.types があれば追加の対応を持つため、マイナー拡張子で差が出うる。
 */
const TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'text/xml',
  '.py': 'text/x-python',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.sh': 'application/x-sh',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.exe': 'application/octet-stream',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.rtf': 'application/rtf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/x-wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** 圧縮拡張子（Python は encoding として分離し、内側の拡張子で type を推定する） */
const ENCODINGS = new Set(['.gz', '.z', '.bz2', '.xz', '.br']);
const SUFFIX_MAP: Record<string, string> = { '.tgz': '.tar.gz', '.taz': '.tar.gz', '.tz': '.tar.gz' };

function lookup(ext: string): string | null {
  return TYPES[ext] ?? TYPES[ext.toLowerCase()] ?? null;
}

export function guessMimeType(filename: string): string | null {
  let base = filename.slice(filename.lastIndexOf('/') + 1);
  let dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  let ext = base.slice(dot);
  const mapped = SUFFIX_MAP[ext.toLowerCase()];
  if (mapped) {
    base = base.slice(0, dot) + mapped;
    dot = base.lastIndexOf('.');
    ext = base.slice(dot);
  }
  if (ENCODINGS.has(ext.toLowerCase())) {
    const inner = base.slice(0, dot);
    const idot = inner.lastIndexOf('.');
    if (idot < 0) return null;
    return lookup(inner.slice(idot));
  }
  return lookup(ext);
}
