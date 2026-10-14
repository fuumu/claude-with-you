/**
 * TS-1 リング4 グループ6: file（Uploads）系 MCP ツール（main.py と同一契約）。
 * file_upload / file_read / file_list / file_delete をネイティブ化。
 *
 * file_upload は url（Content-Type ヘッダから MIME）と file_path（NAS ローカルパス。拡張子から
 * MIME 推定: mimetypes.ts が Python mimetypes の組み込みテーブル相当）の両方を処理する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './data.js';
import { safeId } from './inbox.js';
import { guessMimeType } from './mimetypes.js';
import { Handler, pyBasename } from './tool-types.js';
import { appendOplog, nowJst, writeJson } from './write.js';

const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');
const TEXT_EXTS = new Set([
  'txt', 'md', 'json', 'csv', 'log', 'yaml', 'yml', 'js', 'ts', 'py', 'sh',
  'html', 'css', 'xml', 'ini', 'toml', 'conf', 'jsonl',
]);

type Meta = Record<string, unknown>;

/** Python の s[:n]（コードポイント単位） */
function cpSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

function filePathFor(id: string, ext: string): string {
  return ext ? path.join(UPLOADS_DIR, `${id}.${ext}`) : path.join(UPLOADS_DIR, id);
}

/** メタデータは {id}.meta.json（実体 {id}.{ext} と ext=json でも衝突しない） */
function metaPathFor(id: string): string {
  return path.join(UPLOADS_DIR, `${id}.meta.json`);
}

function looksLikeMeta(file: string, id: string): boolean {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return typeof d === 'object' && d !== null && !Array.isArray(d)
      && (d as Meta).id === id && 'ext' in (d as Meta);
  } catch {
    return false;
  }
}

/**
 * 既存アップロードのメタデータパス（なければ null）。旧形式（メタが {id}.json）しかなければ
 * {id}.meta.json へ退避してから返す（main.py _upload_meta_path と同一）。
 * {id}.meta.json が既にある場合、{id}.json は ext=json の実体なので触らない
 */
function existingMetaPath(id: string): string | null {
  if (!safeId(id)) return null;
  const p = metaPathFor(id);
  if (fs.existsSync(p)) return p;
  const legacy = path.join(UPLOADS_DIR, `${id}.json`);
  if (fs.existsSync(legacy) && looksLikeMeta(legacy, id)) {
    fs.renameSync(legacy, p);
    return p;
  }
  return null;
}

/** file_list 等の前に旧形式メタを一括退避する（main.py _uploads_migrate_all と同一） */
function migrateAllMeta(): void {
  if (!fs.existsSync(UPLOADS_DIR) || !fs.statSync(UPLOADS_DIR).isDirectory()) return;
  for (const fname of fs.readdirSync(UPLOADS_DIR).sort()) {
    if (!fname.endsWith('.json') || fname.endsWith('.meta.json')) continue;
    const id = fname.slice(0, -'.json'.length);
    if (fs.existsSync(metaPathFor(id))) continue; // 新形式が既にある → この .json は実体
    existingMetaPath(id);
  }
}

function loadMeta(id: string): Meta | null {
  const p = existingMetaPath(id);
  if (!p) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Meta;
}

function idArg(args: Record<string, unknown>): string {
  const v = args.id;
  return v === undefined || v === null ? '' : String(v);
}

/** file_upload(url=... | file_path=...)。url が優先（main.py _upload_save と同じ） */
const fileUpload: Handler = async (args) => {
  const url = args.url ? String(args.url) : '';
  const filePath = args.file_path ? String(args.file_path) : '';
  let uploadId = nowJst().replace(/-/g, '').replace(/:/g, '').replace('T', '_').slice(0, 15);

  let filename = args.filename ? String(args.filename) : '';
  let data: Buffer;
  let mime = 'application/octet-stream';
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  if (url) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'mio-memory/upload' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) return { error: `download failed: HTTP ${resp.status}` };
      mime = (resp.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      data = Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      return { error: `download failed: ${(e as Error).message}` };
    }
    if (!filename) {
      let pathname = '';
      try {
        pathname = new URL(url).pathname;
      } catch {
        pathname = '';
      }
      filename = pathname.slice(pathname.lastIndexOf('/') + 1) || `download_${uploadId}`;
    }
  } else if (filePath) {
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    data = fs.readFileSync(filePath);
    if (!filename) filename = pyBasename(filePath);
    mime = guessMimeType(filename) ?? 'application/octet-stream';
  } else {
    return { error: 'url or file_path is required' };
  }
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';

  const safeFilename = filename.replace(/\//g, '_').replace(/\\/g, '_');
  const dot = safeFilename.lastIndexOf('.');
  const stem = dot >= 0 ? safeFilename.slice(0, dot) : safeFilename;
  uploadId = `${uploadId}_${cpSlice(stem, 30)}`;

  fs.writeFileSync(filePathFor(uploadId, ext), data);
  const tags = (Array.isArray(args.tags) ? args.tags : [])
    .map((t) => String(t).trim())
    .filter((t) => t);
  const meta: Meta = {
    id: uploadId,
    filename: safeFilename,
    mimetype: mime,
    size: data.length,
    ext,
    comment: args.comment === undefined || args.comment === null ? '' : args.comment,
    tags,
    uploaded_at: nowJst(),
  };
  writeJson(metaPathFor(uploadId), meta);
  appendOplog('file_upload', uploadId, null, { id: uploadId, filename: safeFilename, size: data.length });
  return {
    id: uploadId,
    filename: safeFilename,
    mimetype: mime,
    size: data.length,
    server_time: nowJst(),
  };
};

const fileRead: Handler = (args) => {
  const id = idArg(args);
  if (!id) return { error: 'id is required' };
  const meta = loadMeta(id);
  if (!meta) return { error: `Upload not found: ${id}` };
  const ext = String(meta.ext ?? '');
  const fp = filePathFor(id, ext);
  if (!fs.existsSync(fp)) return { error: `File data missing: ${id}` };
  const mime = String(meta.mimetype ?? '');
  const fileExt = ext.toLowerCase();
  const isText =
    mime.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript'].includes(mime) ||
    TEXT_EXTS.has(fileExt);
  if (isText) {
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fp));
      const len = Array.from(content).length;
      meta.content =
        len > 50000
          ? cpSlice(content, 50000) + `\n... (truncated, total ${len} chars)`
          : content;
    } catch {
      /* UTF-8 として読めなければ content なし（Python と同じ） */
    }
  }
  return meta;
};

const fileList: Handler = (args) => {
  const wanted = Array.isArray(args.tags) && args.tags.length > 0 ? args.tags.map(String) : null;
  const items: Meta[] = [];
  migrateAllMeta();
  if (fs.existsSync(UPLOADS_DIR) && fs.statSync(UPLOADS_DIR).isDirectory()) {
    for (const fname of fs.readdirSync(UPLOADS_DIR).sort()) {
      if (!fname.endsWith('.meta.json')) continue; // {id}.json は実体（ext=json）の可能性
      let meta: Meta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, fname), 'utf-8')) as Meta;
      } catch {
        continue;
      }
      if (wanted) {
        const entryTags = ((meta.tags as unknown[] | undefined) ?? []).map((t) => String(t).toLowerCase());
        if (!wanted.some((t) => entryTags.includes(t.toLowerCase()))) continue;
      }
      items.push({
        id: 'id' in meta ? meta.id : fname.slice(0, -'.meta.json'.length),
        filename: 'filename' in meta ? meta.filename : '',
        mimetype: 'mimetype' in meta ? meta.mimetype : '',
        size: 'size' in meta ? meta.size : 0,
        comment: 'comment' in meta ? meta.comment : '',
        tags: 'tags' in meta ? meta.tags : [],
        uploaded_at: 'uploaded_at' in meta ? meta.uploaded_at : '',
      });
    }
  }
  return { items, count: items.length, server_time: nowJst() };
};

const fileDelete: Handler = (args) => {
  const id = idArg(args);
  if (!id) return { error: 'id is required' };
  const meta = loadMeta(id);
  if (!meta) return { error: `Upload not found: ${id}` };
  const fp = filePathFor(id, String(meta.ext ?? ''));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const metaFile = metaPathFor(id);
  if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
  appendOplog('file_delete', id, { id }, null);
  return { deleted: id, server_time: nowJst() };
};

export const FILE_HANDLERS: Record<string, Handler> = {
  file_upload: fileUpload,
  file_read: fileRead,
  file_list: fileList,
  file_delete: fileDelete,
};
