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
import { jstIsoFromMs } from './write.js';

const ARTIFACTS_DIR = path.join(DATA_ROOT, 'artifacts');
const CONV_ARTIFACTS_DIR = path.join(DATA_ROOT, 'conv_artifacts');
const META_FILE = path.join(ARTIFACTS_DIR, '_meta.json');

interface ArtifactReadResult {
  name?: string;
  version?: number | null;
  content?: string;
  error?: string;
  [key: string]: unknown;
}

function nameSlug(name: string): string {
  return name.replace(/\./g, '_').replace(/ /g, '_');
}

/** main.py _validate_artifact_name: パストラバーサルを弾く（本番 Linux 相当の posix 判定） */
function validateArtifactName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith('/')) return false;
  const norm = path.posix.normalize(name);
  return !(norm.startsWith('..') || path.posix.isAbsolute(norm));
}

function loadMeta(): Record<string, { source_conversation_uuid?: string }> {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
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

/** main.py _artifacts_save（REST 経由は mode=overwrite 固定）と同一契約 */
export function artifactsSave(
  name: string,
  content: string,
): { name: string; version: number; version_str: string } {
  const slug = nameSlug(name);
  const ext = path.extname(name);
  const versionsDir = path.join(ARTIFACTS_DIR, 'versions', slug);
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const existing = listVersions(versionsDir, ext);
  const nextNum =
    existing.length > 0
      ? parseInt(path.basename(existing[existing.length - 1], ext), 10) + 1
      : 1;
  const versionFilename = `${String(nextNum).padStart(3, '0')}${ext}`;
  fs.writeFileSync(path.join(versionsDir, versionFilename), content, 'utf-8');

  const symlinkPath = path.join(ARTIFACTS_DIR, name);
  const relTarget = path.join('versions', slug, versionFilename);
  try {
    fs.rmSync(symlinkPath, { force: true });
  } catch {
    /* 消せなければ linkOrCopyLatest 側で失敗させる */
  }
  linkOrCopyLatest(relTarget, symlinkPath);

  return { name, version: nextNum, version_str: `${String(nextNum).padStart(3, '0')}` };
}

/** main.py _artifacts_read と同一契約（conv_artifacts フォールバック含む） */
export function artifactsRead(name: string, version: number | null): ArtifactReadResult {
  const meta = loadMeta();
  const entryMeta = meta[name] ?? {};

  if (version === null) {
    const p = path.join(ARTIFACTS_DIR, name);
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
    // conv_artifacts へのフォールバック（孤立ファイル対応）
    if (fs.existsSync(CONV_ARTIFACTS_DIR)) {
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
    ARTIFACTS_DIR,
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
export function coreMemReadMerged(name: string): ArtifactReadResult | null {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  if (ext !== '.md' || stem.endsWith('_manifest')) return null;
  const manifestName = `${stem}_manifest.md`;
  const mres = artifactsRead(manifestName, null);
  if (mres.error) return null;
  let order = [...String(mres.content ?? '').matchAll(/^\s*-\s*(\S+)/gm)].map((m) => m[1]);
  order = order.filter((f) => validateArtifactName(f) && f !== name && f !== manifestName);
  if (order.length === 0) return null;
  const parts: string[] = [];
  const mapping: Record<string, string[]> = {};
  const missing: string[] = [];
  for (const fname of order) {
    const r = artifactsRead(fname, null);
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
export function artifactsList(): Record<string, unknown>[] {
  if (!fs.existsSync(ARTIFACTS_DIR)) return [];
  const meta = loadMeta();
  const items: Record<string, unknown>[] = [];
  for (const entry of fs.readdirSync(ARTIFACTS_DIR).sort()) {
    const fullPath = path.join(ARTIFACTS_DIR, entry);
    // versions/ ディレクトリとメタデータは対象外。壊れた symlink・__del__ もスキップ
    if (!fs.existsSync(fullPath)) continue;
    if (fs.statSync(fullPath).isDirectory() || entry === '_meta.json') continue;
    if (entry.startsWith('__del__')) continue;
    let versionStr: string;
    if (fs.lstatSync(fullPath).isSymbolicLink()) {
      const target = fs.readlinkSync(fullPath);
      versionStr = path.basename(target, path.extname(target));
    } else {
      // symlink 非対応環境（コピーフォールバック）: versions/ から最新番号を導出
      const ext = path.extname(entry);
      const vs = listVersions(path.join(ARTIFACTS_DIR, 'versions', nameSlug(entry)), ext);
      versionStr = vs.length > 0 ? path.basename(vs[vs.length - 1], ext) : '';
    }
    const version = /^\d+$/.test(versionStr) ? parseInt(versionStr, 10) : null;
    const stat = fs.statSync(fullPath);
    const item: Record<string, unknown> = {
      name: entry,
      version,
      updated_at: jstIsoFromMs(stat.mtimeMs),
    };
    if (meta[entry]?.source_conversation_uuid) {
      item.source_conversation_uuid = meta[entry].source_conversation_uuid;
    }
    items.push(item);
  }
  return items;
}

/** main.py api_coremem_delete: 全版削除。対象なしなら false（404） */
export function artifactsDelete(name: string): boolean {
  const symlinkPath = path.join(ARTIFACTS_DIR, name);
  let isLink = false;
  try {
    isLink = fs.lstatSync(symlinkPath).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (!isLink && !fs.existsSync(symlinkPath)) return false;
  fs.rmSync(symlinkPath, { force: true });
  const versionsDir = path.join(ARTIFACTS_DIR, 'versions', nameSlug(name));
  if (fs.existsSync(versionsDir)) {
    fs.rmSync(versionsDir, { recursive: true, force: true });
  }
  return true;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * /api/coremem* のルーティング。認証は呼び出し元（index.ts）で済んでいる前提。
 * 担当したら true、担当外（該当メソッドなし等）は false = プロキシへ。
 */
export async function handleCoremem(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';

  if (p === '/api/coremem') {
    if (method !== 'GET') return false;
    sendJson(res, 200, artifactsList());
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
      const merged = coreMemReadMerged(name);
      if (merged !== null) {
        sendJson(res, 200, merged);
        return true;
      }
    }
    const result = artifactsRead(name, version);
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
    sendJson(res, 201, artifactsSave(name, String(data.content ?? '')));
    return true;
  }

  if (method === 'DELETE') {
    if (!validateArtifactName(name)) {
      sendJson(res, 400, { error: 'Bad Request', code: 400 });
      return true;
    }
    if (artifactsDelete(name)) {
      sendJson(res, 200, { deleted: name });
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
    return true;
  }

  return false;
}
