/**
 * TS-1 リング4 グループ2: CoreMem 系 MCP ツール（main.py _handle_tool_call_raw と同一契約）。
 * CoreMem_save / CoreMem_read / CoreMem_list / CoreMem_delete
 * 版管理・分割マージ読みは coremem.ts（REST と共有）に委譲する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionCheckin } from './attendance.js';
import {
  ARTIFACTS_DIR,
  artifactsDelete,
  artifactsList,
  artifactsRead,
  artifactsRename,
  artifactsSaveEx,
  coreMemReadMerged,
  resolveArtifactsDir,
  validateArtifactName,
  validateProjectTarget,
} from './coremem.js';
import { Args, Handler, toInt, truthy } from './tool-types.js';
import { appendOplog, nowJst } from './write.js';

interface TargetResolved {
  baseDir?: string;
  error?: { error: string };
}

/** target（プロジェクト名）の検証と解決。未指定なら家（baseDir 未設定） */
function resolveTarget(target: string): TargetResolved {
  if (!target) return {};
  if (!validateProjectTarget(target)) return { error: { error: `invalid target: ${target}` } };
  const baseDir = resolveArtifactsDir(target);
  let isDir = false;
  try {
    isDir = fs.statSync(baseDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { error: { error: `project not found: ${target}` } };
  return { baseDir };
}

function strArg(args: Args, key: string, dflt = ''): string {
  const v = args[key];
  return v === undefined || v === null ? dflt : String(v);
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const coreMemSave: Handler = (args) => {
  const name = strArg(args, 'name');
  const mode = strArg(args, 'mode', 'overwrite');
  const target = strArg(args, 'target');
  if (!name) return { error: 'name is required' };
  if (!validateArtifactName(name)) return { error: 'invalid name' };
  const t = resolveTarget(target);
  if (t.error) return t.error;

  // v3.96: manifest が存在する名前への直接書き込みをガード
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  if (ext === '.md' && !stem.endsWith('_manifest')) {
    const manifestName = `${stem}_manifest.md`;
    if (lexists(path.join(t.baseDir ?? ARTIFACTS_DIR, manifestName))) {
      return {
        error:
          `${name} は分割管理されています（${manifestName} が存在）。` +
          '個別の分割ファイルに書き込むか、manifest を削除してから書き込んでください',
      };
    }
  }

  const sourceUuid = args.source_conversation_uuid ? String(args.source_conversation_uuid) : null;
  const result =
    mode === 'str_replace'
      ? artifactsSaveEx(name, '', t.baseDir, {
          mode: 'str_replace',
          oldStr: strArg(args, 'old_str'),
          newStr: args.new_str === undefined || args.new_str === null ? '' : String(args.new_str),
          sourceConversationUuid: sourceUuid,
        })
      : artifactsSaveEx(name, strArg(args, 'content'), t.baseDir, {
          mode,
          sourceConversationUuid: sourceUuid,
        });
  if ('error' in result) return result;
  const oplogId = target ? `${target}/${name}` : name;
  appendOplog('coremem_save', oplogId, null, {
    name,
    version: result.version,
    target: target || null,
  });
  return result;
};

const coreMemRead: Handler = (args) => {
  const name = strArg(args, 'name');
  const target = strArg(args, 'target');
  if (!validateArtifactName(name)) return { error: 'invalid name' };
  const t = resolveTarget(target);
  if (t.error) return t.error;

  // v3.85: 出席簿チェックイン（家の CoreMem のみ）
  if (!target) {
    const referOnly = truthy(args.refer_only);
    const currentModel = args.current_model;
    if (!referOnly) {
      if (truthy(currentModel)) sessionCheckin(String(currentModel), true);
      else sessionCheckin(null, false);
    }
  }

  const hasVersion = args.version !== undefined && args.version !== null;
  if (!hasVersion) {
    const merged = coreMemReadMerged(name, t.baseDir);
    if (merged !== null) return merged;
  }
  let version: number | null = null;
  if (hasVersion) {
    version = toInt(args.version);
    if (Number.isNaN(version)) return { error: `invalid version: ${String(args.version)}` };
  }
  return artifactsRead(name, version, t.baseDir);
};

const coreMemList: Handler = (args) => {
  const t = resolveTarget(strArg(args, 'target'));
  if (t.error) return t.error;
  return artifactsList(t.baseDir);
};

const coreMemDelete: Handler = (args) => {
  const src = strArg(args, 'src');
  const dst = strArg(args, 'dst');
  const name = strArg(args, 'name');
  const target = strArg(args, 'target');
  const t = resolveTarget(target);
  if (t.error) return t.error;

  if (src || dst) {
    if (!src || !dst) return { error: 'src と dst は両方必須です' };
    if (!validateArtifactName(src) || !validateArtifactName(dst)) return { error: 'invalid name' };
    const r = artifactsRename(src, dst, t.baseDir);
    if ('error' in r) return r;
    appendOplog('coremem_rename', src, { name: src }, { name: dst });
    return { renamed: true, src, dst, server_time: nowJst() };
  }

  if (!name) return { error: 'name は必須です（削除: name / リネーム: src+dst）' };
  if (!validateArtifactName(name)) return { error: 'invalid name' };
  if (!artifactsDelete(name, t.baseDir)) return { error: `not found: ${name}` };
  appendOplog('coremem_delete', name, { name }, null);
  return { deleted: name, server_time: nowJst() };
};

export const COREMEM_HANDLERS: Record<string, Handler> = {
  CoreMem_save: coreMemSave,
  CoreMem_read: coreMemRead,
  CoreMem_list: coreMemList,
  CoreMem_delete: coreMemDelete,
};
