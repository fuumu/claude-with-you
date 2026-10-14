/**
 * TS-1 リング5: album_save（main.py _album_save / _extract_images_from_html の移植）。
 * Pillow の代わりに sharp（libvips）を使う。
 *
 * 契約（Python 版と同一）:
 *  - url（HTML ページなら og:image / twitter:image → なければ <img src> を抽出して保存）または file_path
 *  - 長辺 1024px に縮小（拡大しない）、JPEG は quality=85、PNG/GIF/WEBP は形式維持、
 *    それ以外の形式（TIFF 等）は JPEG に変換。EXIF は保持しない・自動回転しない（Pillow と同じ）
 *  - ID は {YYYYMMDD_HHMMSS}_{tags[0] 先頭 20 字・空白は _}、メタデータは {id}.json
 *
 * 差異（Pillow との既知の違い）:
 *  - sharp で読めない形式（BMP・ICO・PPM 等）は "not a valid image" になる
 *  - SVG / HEIF は Pillow でも読めないため、sharp が読めても同様に "not a valid image" とする
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_ROOT } from './data.js';
import { logInfo } from './llm.js';
import { pyBasename } from './tool-types.js';
import { appendOplog, idSlug, jstStamp, nowJst, writeJson } from './write.js';

const ALBUM_DIR = path.join(DATA_ROOT, 'album');
const MAX_SIDE = 1024;
const EXT_MAP: Record<string, string> = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };
const READABLE = new Set(['jpeg', 'png', 'gif', 'webp', 'tiff']);

type Meta = Record<string, unknown>;

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function urljoin(base: string, ref: string): string {
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

/** HTML ページから og:image / twitter:image（なければ <img src>）の URL リストを返す */
export function extractImagesFromHtml(html: string, baseUrl: string): string[] {
  const og: string[] = [];
  const imgs: string[] = [];
  const tagRe = /<(meta|img)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[2])) !== null) {
      const name = a[1].toLowerCase();
      if (!(name in attrs)) attrs[name] = unescapeHtml(a[2] ?? a[3] ?? a[4] ?? '');
    }
    if (tag === 'meta') {
      const prop = attrs.property || attrs.name || '';
      if ((prop === 'og:image' || prop === 'twitter:image') && attrs.content) {
        og.push(urljoin(baseUrl, attrs.content));
      }
    } else if (tag === 'img') {
      const src = attrs.src || '';
      if (src && !src.startsWith('data:')) imgs.push(urljoin(baseUrl, src));
    }
  }
  return og.length > 0 ? og : imgs;
}

export interface AlbumSaveArgs {
  url?: unknown;
  file_path?: unknown;
  comment?: unknown;
  tags?: unknown;
  rating?: unknown;
  guard_message?: unknown;
}

export async function albumSave(
  args: AlbumSaveArgs,
  version: string,
  fromHtml = false,
): Promise<Meta> {
  const url = args.url ? String(args.url) : '';
  const filePath = args.file_path ? String(args.file_path) : '';
  if (!url && !filePath) return { error: 'url or file_path is required' };

  fs.mkdirSync(ALBUM_DIR, { recursive: true });

  let data: Buffer;
  let originalFilename: string;
  if (url) {
    let contentType = '';
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': `mio-memory/${version}` },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) return { error: `download failed: HTTP Error ${resp.status}: ${resp.statusText}` };
      contentType = resp.headers.get('content-type') ?? '';
      data = Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      return { error: `download failed: ${(e as Error).message}` };
    }

    if (!fromHtml && contentType.includes('text/html')) {
      const imgUrls = extractImagesFromHtml(data.toString('utf-8'), url);
      if (imgUrls.length === 0) return { error: 'HTML page contained no extractable images' };
      const results: Meta[] = [];
      for (const imgUrl of imgUrls) {
        const r = await albumSave({ ...args, url: imgUrl, file_path: undefined }, version, true);
        if (!('error' in r)) results.push(r);
      }
      if (results.length === 0) return { error: 'no valid images found in HTML page' };
      if (results.length === 1) return results[0];
      return { items: results, total: results.length };
    }
    originalFilename = url.slice(url.lastIndexOf('/') + 1).split('?')[0] || 'image';
  } else {
    if (!fs.existsSync(filePath)) return { error: `file not found: ${filePath}` };
    data = fs.readFileSync(filePath);
    originalFilename = pyBasename(filePath);
  }

  let fmt: string;
  let hasAlpha = false;
  try {
    const md = await sharp(data).metadata();
    fmt = md.format ?? '';
    hasAlpha = Boolean(md.hasAlpha);
    if (!READABLE.has(fmt)) throw new Error(`unsupported image format: ${fmt || 'unknown'}`);
  } catch (e) {
    return { error: `not a valid image: ${(e as Error).message}` };
  }

  const ext = EXT_MAP[fmt] ?? 'jpg';

  let img = sharp(data);
  if (ext === 'jpg' && hasAlpha) img = img.removeAlpha(); // Pillow の convert('RGB') 相当（合成しない）
  img = img.resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  let out: Buffer;
  try {
    if (ext === 'jpg') out = await img.jpeg({ quality: 85 }).toBuffer();
    else if (ext === 'png') out = await img.png().toBuffer();
    else if (ext === 'gif') out = await img.gif().toBuffer();
    else out = await img.webp().toBuffer();
  } catch (e) {
    return { error: `not a valid image: ${(e as Error).message}` };
  }
  const outMd = await sharp(out).metadata();
  const width = outMd.width ?? 0;
  const height = outMd.height ?? 0;

  const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : null;
  const tagSlug = idSlug(tags && tags.length > 0 ? tags[0] : 'photo');
  const albumId = `${jstStamp()}_${tagSlug}`;

  fs.writeFileSync(path.join(ALBUM_DIR, `${albumId}.${ext}`), out);

  const comment = args.comment ? String(args.comment) : '';
  const meta: Meta = {
    id: albumId,
    ext,
    comment,
    tags: tags ?? [],
    source_url: url || '',
    original_filename: originalFilename,
    created_at: nowJst(),
    width,
    height,
    size_bytes: out.length,
  };
  const rating = args.rating;
  if (rating && ['safe', 'mature', 'adult'].includes(String(rating))) meta.rating = rating;
  if (args.guard_message) meta.guard_message = args.guard_message;
  writeJson(path.join(ALBUM_DIR, `${albumId}.json`), meta);

  logInfo(`album_save: ${albumId} (${width}x${height}, ${out.length} bytes)`);
  appendOplog('album_save', albumId, null, { id: albumId, comment, tags: tags ?? [] });
  return meta;
}
