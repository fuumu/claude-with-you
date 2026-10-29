/**
 * TS-1 リング3: UserCoreMemory REST（/api/coremem*）。
 * main.py の _artifacts_save / _artifacts_read / _artifacts_list /
 * _coremem_read_merged / api_coremem_delete と同一契約。
 *
 * 版管理: /data/artifacts/versions/{slug}/{NNN}{ext} に全版を保存し、
 * トップレベル /data/artifacts/{name} が最新版への symlink。symlink 非対応
 * 環境（特権なし Windows ローカル等）ではファイルコピーにフォールバックする
 * （main.py _link_or_copy_latest と同じ）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DATA_ROOT } from './data.js';
import { readBodyText as readRequestBody } from './http-body.js';
import { appendOplog, jstIsoFromMs } from './write.js';

export const ARTIFACTS_DIR = path.join(DATA_ROOT, 'artifacts');
const CONV_ARTIFACTS_DIR = path.join(DATA_ROOT, 'conv_artifacts');
export const PROJECTS_DIR = path.join(DATA_ROOT, 'projects');

interface ArtifactReadResult {
  name?: string;
  version?: number | null;
  content?: string;
  error?: string;
  [key: string]: unknown;
}

export function nameSlug(name: string): string {
  return name.replace(/\./g, '_').replace(/ /g, '_');
}

/** main.py _validate_artifact_name: パストラバーサルを弾く（本番 Linux 相当の posix 判定） */
export function validateArtifactName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith('/')) return false;
  const norm = path.posix.normalize(name);
  return !(norm.startsWith('..') || path.posix.isAbsolute(norm));
}

export function validateProjectTarget(target: string): boolean {
  if (!target) return false;
  const norm = path.posix.normalize(target);
  if (norm.startsWith('..') || path.posix.isAbsolute(norm) || target.includes('/') || target.includes('\\')) return false;
  if (target === '_template') return false;
  return true;
}

export function resolveArtifactsDir(target?: string): string {
  if (!target) return ARTIFACTS_DIR;
  return path.join(PROJECTS_DIR, target);
}

function loadMeta(baseDir?: string): Record<string, { source_conversation_uuid?: string }> {
  const metaFile = path.join(baseDir ?? ARTIFACTS_DIR, '_meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  } catch {
    return {};
  }
}

/** main.py _link_or_copy_latest: symlink を試み、不可ならコピー */
function linkOrCopyLatest(relTarget: string, symlinkPath: string): void {
  try {
    fs.symlinkSync(relTarget, symlinkPath, 'file');
  } catch {
    const src = path.isAbsolute(relTarget)
      ? relTarget
      : path.join(path.dirname(symlinkPath), relTarget);
    fs.copyFileSync(src, symlinkPath);
  }
}

/** versions/{slug}/ 内の既存版ファイル名（ext一致）を昇順で返す */
function listVersions(versionsDir: string, ext: string): string[] {
  try {
    return fs
      .readdirSync(versionsDir)
      .filter((f) => f.endsWith(ext))
      .sort();
  } catch {
    return [];
  }
}

export interface ArtifactSaveOptions {
  /** 'overwrite'（既定）/ 'append' / 'str_replace' */
  mode?: string;
  oldStr?: string | null;
  newStr?: string | null;
  sourceConversationUuid?: string | null;
}

export interface ArtifactSaveResult {
  name: string;
  version: number;
  version_str: string;
  source_conversation_uuid?: string;
}

/** Python の datetime.now().strftime('%Y-%m-%dT%H:%M')（サーバーローカル時刻） */
function localMinuteStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * main.py _artifacts_save と同一契約（overwrite / append / str_replace・
 * source_conversation_uuid のメタ保存）。エラー時は {error}。
 */
export function artifactsSaveEx(
  name: string,
  content: string,
  baseDir?: string,
  opts: ArtifactSaveOptions = {},
): ArtifactSaveResult | { error: string } {
  const artifactsDir = baseDir ?? ARTIFACTS_DIR;
  const slug = nameSlug(name);
  const ext = path.extname(name);
  const versionsDir = path.join(artifactsDir, 'versions', slug);
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  const existing = listVersions(versionsDir, ext);
  const nextNum =
    existing.length > 0
      ? parseInt(path.basename(existing[existing.length - 1], ext), 10) + 1
      : 1;
  const versionFilename = `${String(nextNum).padStart(3, '0')}${ext}`;
  const symlinkPath = path.join(artifactsDir, name);
  const mode = opts.mode ?? 'overwrite';

  if (mode === 'str_replace') {
    if (!fs.existsSync(symlinkPath)) return { error: `file not found: ${name}` };
    if (!opts.oldStr) return { error: 'old_str is required for str_replace mode' };
    const existingContent = fs.readFileSync(symlinkPath, 'utf-8');
    const count = existingContent.split(opts.oldStr).length - 1;
    if (count === 0) return { error: 'old_str not found in file' };
    if (count > 1) return { error: `old_str matches ${count} times (must be unique)` };
    const i = existingContent.indexOf(opts.oldStr);
    content =
      existingContent.slice(0, i) + (opts.newStr ?? '') + existingContent.slice(i + opts.oldStr.length);
  } else if (mode === 'append' && existing.length > 0) {
    if (fs.existsSync(symlinkPath)) {
      const existingContent = fs.readFileSync(symlinkPath, 'utf-8');
      content = `${existingContent}\n---\n<!-- APPEND ${localMinuteStamp()} -->\n${content}`;
    }
  }

  fs.writeFileSync(path.join(versionsDir, versionFilename), content, 'utf-8');

  const relTarget = path.join('versions', slug, versionFilename);
  try {
    fs.rmSync(symlinkPath, { force: true });
  } catch {
    /* 消せなければ linkOrCopyLatest 側で失敗させる */
  }
  linkOrCopyLatest(relTarget, symlinkPath);

  if (opts.sourceConversationUuid) {
    const metaPath = path.join(artifactsDir, '_meta.json');
    const meta = loadMeta(artifactsDir) as Record<string, Record<string, unknown>>;
    meta[name] = { ...(meta[name] ?? {}), source_conversation_uuid: opts.sourceConversationUuid };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  const result: ArtifactSaveResult = {
    name,
    version: nextNum,
    version_str: `${String(nextNum).padStart(3, '0')}`,
  };
  if (opts.sourceConversationUuid) result.source_conversation_uuid = opts.sourceConversationUuid;
  return result;
}

/** main.py _artifacts_save（REST 経由は mode=overwrite 固定）と同一契約 */
export function artifactsSave(
  name: string,
  content: string,
  baseDir?: string,
): { name: string; version: number; version_str: string } {
  return artifactsSaveEx(name, content, baseDir) as ArtifactSaveResult;
}

/** main.py CoreMem_delete の rename（src → dst）。エラー時は {error} */
export function artifactsRename(
  src: string,
  dst: string,
  baseDir?: string,
): { renamed: true; src: string; dst: string } | { error: string } {
  const artifactsDir = baseDir ?? ARTIFACTS_DIR;
  const srcSym = path.join(artifactsDir, src);
  const dstSym = path.join(artifactsDir, dst);
  const isLink = (p: string): boolean => {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (!isLink(srcSym) && !fs.existsSync(srcSym)) return { error: `not found: ${src}` };
  if (fs.existsSync(dstSym)) return { error: `already exists: ${dst}` };

  const srcExt = path.extname(src);
  const dstExt = path.extname(dst);
  const srcVdir = path.join(artifactsDir, 'versions', nameSlug(src));
  const dstVdir = path.join(artifactsDir, 'versions', nameSlug(dst));
  if (fs.existsSync(srcVdir) && fs.statSync(srcVdir).isDirectory()) {
    fs.mkdirSync(path.dirname(dstVdir), { recursive: true });
    fs.renameSync(srcVdir, dstVdir);
    if (srcExt !== dstExt) {
      for (const fname of fs.readdirSync(dstVdir).sort()) {
        if (fname.endsWith(srcExt)) {
          fs.renameSync(
            path.join(dstVdir, fname),
            path.join(dstVdir, fname.slice(0, fname.length - srcExt.length) + dstExt),
          );
        }
      }
    }
  }
  if (isLink(srcSym) || fs.existsSync(srcSym)) fs.rmSync(srcSym, { force: true });
  if (fs.existsSync(dstVdir) && fs.statSync(dstVdir).isDirectory()) {
    const existing = listVersions(dstVdir, dstExt);
    if (existing.length > 0) linkOrCopyLatest(path.join(dstVdir, existing[existing.length - 1]), dstSym);
  }
  return { renamed: true, src, dst };
}

/** main.py _artifacts_read と同一契約（conv_artifacts フォールバック含む） */
export function artifactsRead(name: string, version: number | null, baseDir?: string): ArtifactReadResult {
  const artifactsDir = baseDir ?? ARTIFACTS_DIR;
  const meta = loadMeta(artifactsDir);
  const entryMeta = meta[name] ?? {};

  if (version === null) {
    const p = path.join(artifactsDir, name);
    if (fs.existsSync(p)) {
      const result: ArtifactReadResult = {
        name,
        version: null,
        content: fs.readFileSync(p, 'utf-8'),
      };
      if (entryMeta.source_conversation_uuid) {
        result.source_conversation_uuid = entryMeta.source_conversation_uuid;
      }
      return result;
    }
    // conv_artifacts へのフォールバック（家のみ）
    if (artifactsDir === ARTIFACTS_DIR && fs.existsSync(CONV_ARTIFACTS_DIR)) {
      for (const convUuid of fs.readdirSync(CONV_ARTIFACTS_DIR).sort()) {
        const convPath = path.join(CONV_ARTIFACTS_DIR, convUuid, name);
        if (fs.existsSync(convPath)) {
          return {
            name,
            version: null,
            content: fs.readFileSync(convPath, 'utf-8'),
            source_conv_uuid: convUuid,
            source: 'conv_artifact',
          };
        }
      }
    }
    return { error: 'not found' };
  }

  const p = path.join(
    artifactsDir,
    'versions',
    nameSlug(name),
    `${String(version).padStart(3, '0')}${path.extname(name)}`,
  );
  if (!fs.existsSync(p)) return { error: 'not found' };
  const result: ArtifactReadResult = { name, version, content: fs.readFileSync(p, 'utf-8') };
  if (entryMeta.source_conversation_uuid) {
    result.source_conversation_uuid = entryMeta.source_conversation_uuid;
  }
  return result;
}

/** main.py _coremem_read_merged（v3.21 分割+マージ読み）。対象外なら null */
export function coreMemReadMerged(name: string, baseDir?: string): ArtifactReadResult | null {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  if (ext !== '.md' || stem.endsWith('_manifest')) return null;
  const manifestName = `${stem}_manifest.md`;
  const mres = artifactsRead(manifestName, null, baseDir);
  if (mres.error) return null;
  let order = [...String(mres.content ?? '').matchAll(/^\s*-\s*(\S+)/gm)].map((m) => m[1]);
  order = order.filter((f) => validateArtifactName(f) && f !== name && f !== manifestName);
  if (order.length === 0) return null;
  const parts: string[] = [];
  const mapping: Record<string, string[]> = {};
  const missing: string[] = [];
  for (const fname of order) {
    const r = artifactsRead(fname, null, baseDir);
    if (r.error) {
      missing.push(fname);
      continue;
    }
    const content = String(r.content ?? '').trim();
    parts.push(`<!-- BEGIN: ${fname} -->\n${content}\n<!-- END: ${fname} -->`);
    mapping[fname] = content
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.slice(3).trim());
  }
  const result: ArtifactReadResult = {
    name,
    version: null,
    merged: true,
    files: order,
    content: parts.join('\n\n'),
    manifest: mapping,
  };
  if (missing.length > 0) result.missing = missing;
  return result;
}

/** main.py _artifacts_list と同一契約 */
export function artifactsList(baseDir?: string): Record<string, unknown>[] {
  const artifactsDir = baseDir ?? ARTIFACTS_DIR;
  if (!fs.existsSync(artifactsDir)) return [];
  const meta = loadMeta(artifactsDir);
  const items: Record<string, unknown>[] = [];
  for (const entry of fs.readdirSync(artifactsDir).sort()) {
    const fullPath = path.join(artifactsDir, entry);
    // versions/ ディレクトリ、files/ ディレクトリ、メタデータは対象外。壊れた symlink・__del__ もスキップ
    if (!fs.existsSync(fullPath)) continue;
    if (fs.statSync(fullPath).isDirectory() || entry === '_meta.json') continue;
    if (entry.startsWith('__del__')) continue;
    let versionStr: string;
    if (fs.lstatSync(fullPath).isSymbolicLink()) {
      const target = fs.readlinkSync(fullPath);
      versionStr = path.basename(target, path.extname(target));
    } else {
      const ext = path.extname(entry);
      const vs = listVersions(path.join(artifactsDir, 'versions', nameSlug(entry)), ext);
      versionStr = vs.length > 0 ? path.basename(vs[vs.length - 1], ext) : '';
    }
    const version = /^\d+$/.test(versionStr) ? parseInt(versionStr, 10) : null;
    const stat = fs.statSync(fullPath);
    const item: Record<string, unknown> = {
      name: entry,
      version,
      updated_at: jstIsoFromMs(stat.mtimeMs),
      size: stat.size,
    };
    if (meta[entry]?.source_conversation_uuid) {
      item.source_conversation_uuid = meta[entry].source_conversation_uuid;
    }
    items.push(item);
  }
  return items;
}

/** main.py api_coremem_delete: 全版削除。対象なしなら false（404） */
export function artifactsDelete(name: string, baseDir?: string): boolean {
  const artifactsDir = baseDir ?? ARTIFACTS_DIR;
  const symlinkPath = path.join(artifactsDir, name);
  let isLink = false;
  try {
    isLink = fs.lstatSync(symlinkPath).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (!isLink && !fs.existsSync(symlinkPath)) return false;
  fs.rmSync(symlinkPath, { force: true });
  const versionsDir = path.join(artifactsDir, 'versions', nameSlug(name));
  if (fs.existsSync(versionsDir)) {
    fs.rmSync(versionsDir, { recursive: true, force: true });
  }
  return true;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * /api/coremem* のルーティング。認証は呼び出し元（index.ts）で済んでいる前提。
 * 担当したら true、担当外（該当メソッドなし等）は false = 次のハンドラへ。
 */
export async function handleCoremem(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';

  // target クエリパラメータでプロジェクト内ファイルにアクセス（v3.90）
  const targetParam = url.searchParams.get('target') ?? '';
  let baseDir: string | undefined;
  if (targetParam) {
    if (!validateProjectTarget(targetParam)) {
      sendJson(res, 400, { error: `invalid target: ${targetParam}` });
      return true;
    }
    baseDir = resolveArtifactsDir(targetParam);
    if (!fs.existsSync(baseDir)) {
      sendJson(res, 404, { error: `project not found: ${targetParam}` });
      return true;
    }
  }

  if (p === '/api/coremem') {
    if (method !== 'GET') return false;
    sendJson(res, 200, artifactsList(baseDir));
    return true;
  }

  const m = /^\/api\/coremem\/(.+)$/.exec(p);
  if (!m) return false;
  const name = decodeURIComponent(m[1]);

  if (method === 'GET') {
    if (!validateArtifactName(name)) {
      sendJson(res, 400, { error: 'Bad Request', code: 400 });
      return true;
    }
    const versionParam = url.searchParams.get('version');
    const version = versionParam !== null ? parseInt(versionParam, 10) : null;
    if (version === null && url.searchParams.get('raw')?.toLowerCase() !== 'true') {
      const merged = coreMemReadMerged(name, baseDir);
      if (merged !== null) {
        sendJson(res, 200, merged);
        return true;
      }
    }
    const result = artifactsRead(name, version, baseDir);
    if (result.error) {
      sendJson(res, 404, { error: 'not found' });
    } else {
      sendJson(res, 200, result);
    }
    return true;
  }

  if (method === 'POST') {
    if (!validateArtifactName(name)) {
      sendJson(res, 400, { error: 'Bad Request', code: 400 });
      return true;
    }
    // v3.96 manifest ガード: {stem}_manifest.md があるファイルは分割管理なので直接保存させない（409）
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    if (ext === '.md' && !stem.endsWith('_manifest')) {
      const manifestPath = path.join(baseDir ?? ARTIFACTS_DIR, `${stem}_manifest.md`);
      let hasManifest = fs.existsSync(manifestPath);
      try {
        hasManifest = hasManifest || fs.lstatSync(manifestPath).isSymbolicLink();
      } catch {
        /* 無い */
      }
      if (hasManifest) {
        sendJson(res, 409, { error: `${name} は分割管理されています` });
        return true;
      }
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(await readRequestBody(req));
    } catch {
      data = null;
    }
    if (!data || !('content' in data)) {
      sendJson(res, 400, { error: 'Bad Request', code: 400 });
      return true;
    }
    const result = artifactsSave(name, String(data.content ?? ''), baseDir);
    appendOplog('coremem_save', name, null, { name, version: result.version });
    sendJson(res, 201, result);
    return true;
  }

  if (method === 'DELETE') {
    if (!validateArtifactName(name)) {
      sendJson(res, 400, { error: 'Bad Request', code: 400 });
      return true;
    }
    if (artifactsDelete(name, baseDir)) {
      appendOplog('coremem_delete', name, { name }, null);
      sendJson(res, 200, { deleted: name });
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
    return true;
  }

  return false;
}
