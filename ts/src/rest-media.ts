/**
 * TS-FULL ステップ5: アルバム・アップロードの REST（main.py と同一契約）。admin.html の Album / Uploads タブが使う。
 *   GET    /api/album/                一覧（?tag= 複数可・include_adult）
 *   GET    /api/album/<id>            画像本体
 *   POST   /api/album/upload          multipart の file、または url。comment・tags（カンマ・読点・空白区切り）
 *   PATCH  /api/album/<id>            comment / tags / rating / guard_message
 *   DELETE /api/album/<id>            画像とメタを削除
 *   POST   /api/album/<id>/share      24 時間の共有 URL
 *   GET    /api/album/shared/<token>  共有された画像（認証不要・期限切れは 410）
 *   GET    /api/uploads               一覧（?tag= 複数可）　POST /api/uploads（multipart の file）
 *   GET    /api/uploads/<id>          ダウンロード（attachment）　DELETE /api/uploads/<id>
 * /api/album/shared/<token> 以外は Bearer 認証（画像は ?token= でも可）。
 *
 * main.py との差（意図的）:
 * - ブラウザから上げた画像の original_filename は実際のファイル名（main.py は一時ファイル名になっていた）
 * - 同じ秒に同じ名前のファイルを上げても上書きしない（ID に _2, _3 … を付ける）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { albumSave } from './album-save.js';
import { extractBearer, verifyToken } from './auth.js';
import { DATA_ROOT } from './data.js';
import { readBodyBuffer, readBodyText } from './http-body.js';
import { guessMimeType } from './mimetypes.js';
import { parseMultipart } from './multipart.js';
import { cpSlice, isDict, Json, pyTruthy } from './py-compat.js';
import { ALBUM_DIR, ALBUM_HANDLERS, loadMeta as loadAlbumMeta, metaPath as albumMetaPath, MIME_MAP } from './tools-album.js';
import { deleteUpload, filePathFor, listUploads, loadMeta as loadUploadMeta, metaPathFor, UPLOADS_DIR } from './tools-file.js';
import { VERSION } from './version.js';
import { appendOplog, nowJst, writeJson } from './write.js';

const SHARE_TOKENS_FILE = path.join(DATA_ROOT, 'share_tokens.json');
const TOOL_CTX = { serverVersion: VERSION };
const TAG_SPLIT = /[,、\s]+/;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendFile(res: http.ServerResponse, file: string, headers: Record<string, string | number>): void {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': data.length });
  res.end(data);
}

/** Werkzeug の send_file(as_attachment=True, download_name=...) と同じ形の Content-Disposition */
function attachmentHeader(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
  const quoted = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
  if (ascii === name) return `attachment; filename=${quoted(name)}`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename=${quoted(ascii)}; filename*=UTF-8''${encoded}`;
}

function splitTags(raw: string): string[] {
  return raw ? raw.split(TAG_SPLIT).map((t) => t.trim()).filter(Boolean) : [];
}

// ── album ─────────────────────────────────────────────────────────────

function albumImage(res: http.ServerResponse, id: string): void {
  const meta = loadAlbumMeta(id);
  if (!meta) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const ext = String(meta.ext ?? 'jpg');
  sendFile(res, path.join(ALBUM_DIR, `${id}.${ext}`), { 'Content-Type': MIME_MAP[ext] ?? 'image/jpeg' });
}

async function albumUpload(req: http.IncomingMessage): Promise<[number, unknown]> {
  const form = parseMultipart(await readBodyBuffer(req), req.headers['content-type']);
  const fields = form?.fields ?? {};
  const comment = fields.comment ?? '';
  const tags = splitTags(fields.tags ?? '');
  const url = (fields.url ?? '').trim();
  let result: Json;
  if (url) {
    result = await albumSave({ url, comment, tags }, VERSION);
  } else if (form?.files.file) {
    const f = form.files.file;
    if (!f.filename) return [400, { error: 'no file selected' }];
    // 一時ファイルは元の名前で置く（original_filename に実際のファイル名が残る）
    fs.mkdirSync(ALBUM_DIR, { recursive: true });
    const tmpDir = path.join(ALBUM_DIR, `_upload_tmp_${crypto.randomBytes(8).toString('hex')}`);
    let name = f.filename.replace(/[/\\\0]/g, '_');
    if (name === '.' || name === '..') name = 'image';
    fs.mkdirSync(tmpDir);
    try {
      const tmp = path.join(tmpDir, name);
      fs.writeFileSync(tmp, f.data);
      result = await albumSave({ file_path: tmp, comment, tags }, VERSION);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    return [400, { error: 'file or url is required' }];
  }
  return 'error' in result ? [400, result] : [201, result];
}

async function albumUpdate(req: http.IncomingMessage, id: string): Promise<[number, unknown]> {
  const meta = loadAlbumMeta(id);
  if (!meta) return [404, { error: 'not found' }];
  let data: unknown = {};
  try {
    data = JSON.parse(await readBodyText(req));
  } catch {
    data = {};
  }
  if (!isDict(data)) data = {};
  const d = data as Json;
  const before = { id, comment: meta.comment, tags: meta.tags };
  if ('comment' in d) meta.comment = d.comment;
  if ('tags' in d) meta.tags = pyTruthy(d.tags) ? d.tags : [];
  if ('rating' in d && [null, 'safe', 'mature', 'adult'].includes(d.rating as string | null)) {
    if (d.rating === null || d.rating === 'safe') delete meta.rating;
    else meta.rating = d.rating;
  }
  if ('guard_message' in d) {
    if (pyTruthy(d.guard_message)) meta.guard_message = d.guard_message;
    else delete meta.guard_message;
  }
  writeJson(albumMetaPath(id), meta);
  appendOplog('album_update', id, before, { id, comment: meta.comment, tags: meta.tags });
  return [200, meta];
}

function albumShared(res: http.ServerResponse, token: string): void {
  let tokens: Record<string, Json> = {};
  try {
    tokens = JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf-8')) as Record<string, Json>;
  } catch {
    tokens = {};
  }
  const info = tokens[token];
  if (!info || !('album_id' in info)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const exp = Date.parse(String(info.expires_at));
  if (Number.isFinite(exp) && Date.now() > exp) {
    sendJson(res, 410, { error: 'expired' });
    return;
  }
  albumImage(res, String(info.album_id));
}

// ── uploads ──────────────────────────────────────────────────────────

async function uploadPost(req: http.IncomingMessage): Promise<[number, unknown]> {
  const form = parseMultipart(await readBodyBuffer(req), req.headers['content-type']);
  const f = form?.files.file;
  if (!form || !f) return [400, { error: 'No file provided' }];
  if (!f.filename) return [400, { error: 'Empty filename' }];
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const stamp = nowJst().replace(/-/g, '').replace(/:/g, '').replace('T', '_').slice(0, 15);
  const safeFilename = f.filename.replace(/\//g, '_').replace(/\\/g, '_');
  const dot = safeFilename.lastIndexOf('.');
  const ext = dot >= 0 ? safeFilename.slice(dot + 1).toLowerCase() : '';
  const base = `${stamp}_${cpSlice(dot >= 0 ? safeFilename.slice(0, dot) : safeFilename, 30)}`;
  let id = base;
  for (let n = 2; fs.existsSync(metaPathFor(id)) || fs.existsSync(filePathFor(id, ext)); n++) id = `${base}_${n}`;
  fs.writeFileSync(filePathFor(id, ext), f.data);
  const meta: Json = {
    id,
    filename: safeFilename,
    mimetype: f.contentType || 'application/octet-stream',
    size: f.data.length,
    ext,
    comment: form.fields.comment ?? '',
    tags: splitTags(form.fields.tags ?? ''),
    uploaded_at: nowJst(),
  };
  writeJson(metaPathFor(id), meta);
  appendOplog('file_upload', id, null, { id, filename: safeFilename, size: f.data.length });
  return [201, meta];
}

function uploadDownload(res: http.ServerResponse, id: string): void {
  const meta = loadUploadMeta(id);
  if (!meta) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const ext = String(meta.ext ?? '');
  const fileName = ext ? `${id}.${ext}` : id;
  const downloadName = typeof meta.filename === 'string' && meta.filename ? meta.filename : fileName;
  sendFile(res, filePathFor(id, ext), {
    'Content-Type': guessMimeType(downloadName) ?? 'application/octet-stream',
    'Content-Disposition': attachmentHeader(downloadName),
  });
}

// ── ルーティング ─────────────────────────────────────────────────────

/** アルバム・アップロードの REST なら処理して true */
export async function handleMediaRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';
  const isAlbum = p === '/api/album' || p.startsWith('/api/album/');
  const isUploads = p === '/api/uploads' || p.startsWith('/api/uploads/');
  if (!isAlbum && !isUploads) return false;

  // 認証不要の共有画像
  const shared = /^\/api\/album\/shared\/([^/]+)$/.exec(p);
  if (shared && method === 'GET') {
    albumShared(res, decodeURIComponent(shared[1]));
    return true;
  }
  const one = isAlbum ? /^\/api\/album\/([^/]+)$/.exec(p) : /^\/api\/uploads\/([^/]+)$/.exec(p);
  const share = /^\/api\/album\/([^/]+)\/share$/.exec(p);
  const isList = p === '/api/album' || p === '/api/album/' || p === '/api/uploads' || p === '/api/uploads/';
  const known =
    (isList && (method === 'GET' || (isUploads && method === 'POST'))) ||
    (p === '/api/album/upload' && method === 'POST') ||
    (!!one && ['GET', 'PATCH', 'DELETE'].includes(method) && !(isUploads && method === 'PATCH')) ||
    (!!share && method === 'POST');
  if (!known) return false;
  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (isAlbum) {
    if (isList) {
      const tags = url.searchParams.getAll('tag');
      const includeAdult = (url.searchParams.get('include_adult') ?? 'false').toLowerCase() === 'true';
      sendJson(res, 200, await ALBUM_HANDLERS.album_list({ tags: tags.length > 0 ? tags : undefined,
        include_adult: includeAdult }, TOOL_CTX));
      return true;
    }
    if (p === '/api/album/upload') {
      const [status, body] = await albumUpload(req);
      sendJson(res, status, body);
      return true;
    }
    if (share) {
      const r = (await ALBUM_HANDLERS.album_share({ id: decodeURIComponent(share[1]) }, TOOL_CTX)) as Json;
      sendJson(res, 'error' in r ? 404 : 200, r);
      return true;
    }
    const id = decodeURIComponent(one![1]);
    if (method === 'GET') {
      albumImage(res, id);
    } else if (method === 'PATCH') {
      const [status, body] = await albumUpdate(req, id);
      sendJson(res, status, body);
    } else {
      if (!loadAlbumMeta(id)) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      sendJson(res, 200, await ALBUM_HANDLERS.album_delete({ id }, TOOL_CTX));
    }
    return true;
  }

  // uploads
  if (isList) {
    if (method === 'GET') {
      const tags = url.searchParams.getAll('tag');
      sendJson(res, 200, listUploads(tags.length > 0 ? tags : null));
    } else {
      const [status, body] = await uploadPost(req);
      sendJson(res, status, body);
    }
    return true;
  }
  const id = decodeURIComponent(one![1]);
  if (method === 'GET') {
    uploadDownload(res, id);
  } else {
    const r = deleteUpload(id);
    sendJson(res, 'error' in r ? 404 : 200, r);
  }
  return true;
}
