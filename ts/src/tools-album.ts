/**
 * TS-1 リング4 グループ5: album 系 MCP ツール（main.py _handle_tool_call_raw と同一契約）。
 * album_save / album_read / album_list / album_share / album_delete をネイティブ化。
 *
 * album_save は Ring 5 で sharp（libvips）を導入してネイティブ化した（album-save.ts）。
 * Ring 4 では「外部依存なし」方針のため Python へ転送していた。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './data.js';
import { albumSave } from './album-save.js';
import { safeId } from './inbox.js';
import { Handler, truthy } from './tool-types.js';
import { appendOplog, jstIsoFromMs, nowJst, writeJson } from './write.js';

const ALBUM_DIR = path.join(DATA_ROOT, 'album');
const SHARE_TOKENS_FILE = path.join(DATA_ROOT, 'share_tokens.json');
const BASE_URL = process.env.MIO_BASE_URL ?? 'http://localhost:5002';
const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

type Meta = Record<string, unknown>;

function metaPath(id: string): string {
  return path.join(ALBUM_DIR, `${id}.json`);
}

function loadMeta(id: string): Meta | null {
  if (!safeId(id)) return null;
  const p = metaPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Meta;
}

function idArg(args: Record<string, unknown>): string {
  const v = args.id;
  return v === undefined || v === null ? '' : String(v);
}

const albumRead: Handler = (args, ctx) => {
  const id = idArg(args);
  if (!id) return { error: 'id is required' };
  const meta = loadMeta(id);
  if (!meta) return { error: `not found: ${id}` };

  const includeAdult = truthy(args.include_adult);
  const acknowledged = truthy(args.acknowledged);
  const isAdult = meta.rating === 'adult';
  if (isAdult && !includeAdult) {
    return {
      protected: true,
      rating: 'adult',
      id,
      message: 'この画像は adult レーティングです。include_adult=true で閲覧できます',
      server_time: nowJst(),
      server_version: ctx.serverVersion,
    };
  }
  const guard = meta.guard_message;
  if (isAdult && guard && !acknowledged) {
    return {
      protected: true,
      rating: 'adult',
      id,
      guard_message: guard,
      message: '画像の主からのメッセージです。読んだ上で閲覧する場合は acknowledged=true を指定してください',
      server_time: nowJst(),
      server_version: ctx.serverVersion,
    };
  }

  const ext = String(meta.ext ?? 'jpg');
  const imgPath = path.join(ALBUM_DIR, `${id}.${ext}`);
  if (!fs.existsSync(imgPath)) return { error: `image file missing: ${id}.${ext}` };
  const imgB64 = fs.readFileSync(imgPath).toString('base64');
  const mime = MIME_MAP[ext] ?? 'image/jpeg';

  if (isAdult && acknowledged) {
    const entry: Meta = { viewed_at: nowJst() };
    if (args.viewer) entry.viewer = args.viewer;
    const log = Array.isArray(meta.view_log) ? (meta.view_log as Meta[]) : [];
    log.push(entry);
    meta.view_log = log;
    writeJson(metaPath(id), meta);
  }

  const metaOut = { ...meta, server_time: nowJst(), server_version: ctx.serverVersion };
  return {
    _mcp_content: [
      { type: 'image', data: imgB64, mimeType: mime },
      { type: 'text', text: JSON.stringify(metaOut) },
    ],
  };
};

const albumList: Handler = (args) => {
  if (!fs.existsSync(ALBUM_DIR) || !fs.statSync(ALBUM_DIR).isDirectory()) {
    return { items: [], total: 0 };
  }
  const includeAdult = truthy(args.include_adult);
  const tags = Array.isArray(args.tags) && args.tags.length > 0 ? (args.tags as unknown[]) : null;
  const items: Meta[] = [];
  for (const fname of fs.readdirSync(ALBUM_DIR).sort()) {
    if (!fname.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(ALBUM_DIR, fname), 'utf-8')) as Meta;
      if (!includeAdult && meta.rating === 'adult') continue;
      if (tags) {
        const mt = (Array.isArray(meta.tags) ? meta.tags : []) as unknown[];
        if (!tags.some((t) => mt.includes(t))) continue;
      }
      items.push(meta);
    } catch {
      continue;
    }
  }
  items.sort((a, b) => {
    const ka = String(a.created_at ?? '');
    const kb = String(b.created_at ?? '');
    return kb < ka ? -1 : kb > ka ? 1 : 0;
  });
  return { items, total: items.length };
};

const albumShare: Handler = (args) => {
  const id = idArg(args);
  if (!id) return { error: 'id is required' };
  const meta = loadMeta(id);
  if (!meta) return { error: `not found: ${id}` };
  const ext = String(meta.ext ?? 'jpg');
  if (!fs.existsSync(path.join(ALBUM_DIR, `${id}.${ext}`))) return { error: 'image file missing' };
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = jstIsoFromMs(Date.now() + 86400 * 1000);
  let tokens: Meta = {};
  try {
    tokens = JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf-8')) as Meta;
  } catch {
    tokens = {};
  }
  tokens[token] = { album_id: id, expires_at: expiresAt };
  writeJson(SHARE_TOKENS_FILE, tokens);
  return { token, url: `${BASE_URL}/api/album/shared/${token}`, expires_at: expiresAt };
};

const albumDelete: Handler = (args) => {
  const id = idArg(args);
  if (!id) return { error: 'id is required' };
  const meta = loadMeta(id);
  if (!meta) return { error: `album entry not found: ${id}` };
  const ext = String(meta.ext ?? 'jpg');
  const imgPath = path.join(ALBUM_DIR, `${id}.${ext}`);
  if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  fs.unlinkSync(metaPath(id));
  appendOplog('album_delete', id, { id }, null);
  return { status: 'deleted', id };
};

const albumSaveTool: Handler = (args, ctx) =>
  albumSave(
    {
      url: args.url,
      file_path: args.file_path,
      comment: args.comment === undefined ? '' : args.comment,
      tags: args.tags,
      rating: args.rating,
      guard_message: args.guard_message,
    },
    ctx.serverVersion,
  );

export const ALBUM_HANDLERS: Record<string, Handler> = {
  album_save: albumSaveTool,
  album_read: albumRead,
  album_list: albumList,
  album_share: albumShare,
  album_delete: albumDelete,
};
