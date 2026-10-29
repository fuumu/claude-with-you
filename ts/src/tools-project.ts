/**
 * TS-1 リング4 グループ7: project 系 MCP ツール（main.py _project_create / _project_list と同一契約）。
 * プロジェクトは projects/{name}/ 配下の独立した CoreMem 名前空間（v3.90）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { artifactsSave, PROJECTS_DIR, validateProjectTarget } from './coremem.js';
import { Handler } from './tool-types.js';
import { nowJst } from './write.js';

/** main.py _PROJECT_TEMPLATE_FILES と同一（キー順も同じ） */
const TEMPLATE_FILES: Record<string, string> = {
  'PROJECT.md': `# {project_name}

## 概要
（プロジェクトの目的・ゴールを記載）

## ファイル構成

| ファイル | 役割 |
|---------|------|
| PROJECT.md | このファイル。切り替え時にまず読む |
| todo.md | タスク管理。未完了のみ記載 |
| design.md | 設計書・仕様 |
| notes.md | メモ・調査・気づき |
| inbox.md | プロジェクト内の伝言・申し送り |
| conversations.md | 関連する会話ログUUID |
| log.md | 作業ログ・進捗 |
| files/ | 成果物 |

## ステータス
- 作成日: {date}
- 状態: 準備中
`,
  'todo.md': '# TODO\n\n（タスクをここに記載）\n',
  'design.md': '# 設計書\n\n（設計・仕様をここに記載）\n',
  'notes.md': '# メモ\n\n（調査・気づき・メモをここに記載）\n',
  'inbox.md': '# 伝言\n\n（プロジェクト内の申し送りをここに記載）\n',
  'conversations.md':
    '# 関連する会話ログ\n\n| UUID | タイトル | 日付 |\n|------|---------|------|\n',
  'log.md': '# 作業ログ\n\n（進捗をここに記録）\n',
};

const projectCreate: Handler = (args) => {
  const name = args.name === undefined || args.name === null ? '' : String(args.name);
  if (!name) return { error: 'name is required' };
  if (!validateProjectTarget(name)) return { error: `invalid project name: ${name}` };
  const projectDir = path.join(PROJECTS_DIR, name);
  if (fs.existsSync(projectDir)) return { error: `project already exists: ${name}` };
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'versions'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'files'), { recursive: true });
  const dateStr = nowJst().slice(0, 10); // JST の YYYY-MM-DD
  for (const [fname, template] of Object.entries(TEMPLATE_FILES)) {
    // Python の str.replace は全置換。function 形式で置換して $ の特殊解釈を避ける
    const content = template
      .replace(/\{project_name\}/g, () => name)
      .replace(/\{date\}/g, () => dateStr);
    artifactsSave(fname, content, projectDir);
  }
  return {
    created: name,
    path: `projects/${name}`,
    files: [...Object.keys(TEMPLATE_FILES), 'files/'],
  };
};

/** main.py _project_list（MCP project_list と REST GET /api/projects で共用） */
export function listProjects(): { projects: { name: string; summary: string }[] } {
  if (!fs.existsSync(PROJECTS_DIR)) return { projects: [] };
  const projects: { name: string; summary: string }[] = [];
  for (const entry of fs.readdirSync(PROJECTS_DIR).sort()) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const projectDir = path.join(PROJECTS_DIR, entry);
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    let summary = '';
    const projectMd = path.join(projectDir, 'PROJECT.md');
    if (fs.existsSync(projectMd)) {
      const lines = fs.readFileSync(projectMd, 'utf-8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## 概要')) {
          const next = (lines[i + 1] ?? '').trim();
          if (next && !next.startsWith('（')) summary = next;
          break;
        }
      }
    }
    projects.push({ name: entry, summary });
  }
  return { projects };
}

const projectList: Handler = () => listProjects();

export const PROJECT_HANDLERS: Record<string, Handler> = {
  project_create: projectCreate,
  project_list: projectList,
};
