/**
 * 新規環境の起動時シード（旧 main.py _seed_coremem_if_empty / _seed_welcome_inbox と同一）。
 * - CoreMem に ts/skeleton/coremem/<lang>/*.md を投入する。言語は MIO_SEED_LANG（既定 ja、無ければ ja）
 * - 既存環境（core_stable.md がある）には一切触れない。同名ファイルがあれば飛ばす（冪等）
 * - MIO_SEED_WELCOME=off で welcome.md と「困ったら聞いて」の常駐 inbox を入れない
 * スケルトンの置き場所は MIO_SKELETON_DIR、なければ ts/skeleton/coremem（Docker では /app/skeleton/coremem）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_DIR, artifactsSave } from './coremem.js';
import { findInboxFile, loadInboxMessages, postInboxMessage, writeMsg } from './inbox.js';
import { logInfo } from './llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function skeletonDir(lang: string): string | null {
  const bases = [process.env.MIO_SKELETON_DIR, path.join(here, '..', 'skeleton', 'coremem')].filter(
    (d): d is string => !!d,
  );
  for (const base of bases) {
    const d = path.join(base, lang);
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) return d;
  }
  return null;
}

const WELCOME: Record<string, { title: string; body: string }> = {
  ja: {
    title: '【ようこそ】mio-memory をセットアップしました',
    body:
      'この環境は初期化されたばかりです。\n' +
      '仕組みが分からないときは、ユーザーに『接続中の私（Claude）に「mio-memory の使い方を教えて」と聞いてください』と伝えてOKです。\n' +
      '使い方は CoreMem_read("protocol_guide.md")（全ツール）、全体像は CoreMem_read("welcome.md") を読めば案内できます。\n' +
      'まず core_stable.md と core_infra.md の <...> をユーザーと一緒に埋めましょう。',
  },
  en: {
    title: '[Welcome] mio-memory is set up',
    body:
      'This environment was just initialized.\n' +
      'If the user is unsure how anything works, tell them they can simply ask you ' +
      '(the connected Claude): "how do I use mio-memory?".\n' +
      'You can answer by reading CoreMem_read("protocol_guide.md") (all tools) and ' +
      'CoreMem_read("welcome.md") (overview).\n' +
      'First, help them fill in the <...> placeholders in core_stable.md and core_infra.md.',
  },
};

/** 「困ったら聞いて」の常駐メッセージ（ID 末尾 _welcome が冪等の目印） */
function seedWelcomeInbox(lang: string): void {
  if (loadInboxMessages('chat').some((m) => m.persistent && String(m.id).endsWith('_welcome'))) return;
  const { title, body } = WELCOME[lang] ?? WELCOME.ja;
  const msg = postInboxMessage({ to: 'chat', title, body, from: 'code', persistent: true });
  const oldPath = findInboxFile(msg.id);
  if (oldPath) {
    msg.id = `${msg.id}_welcome`;
    writeMsg(path.join(path.dirname(oldPath), `${msg.id}.json`), msg);
    fs.unlinkSync(oldPath);
  }
  logInfo(`welcome inbox seeded (lang=${lang})`);
}

/** 新規環境だけ CoreMem のスケルトンを入れる */
export function seedCoreMemIfEmpty(): void {
  if (fs.existsSync(path.join(ARTIFACTS_DIR, 'core_stable.md'))) return;
  const wanted = process.env.MIO_SEED_LANG ?? 'ja';
  const lang = skeletonDir(wanted) ? wanted : 'ja';
  const dir = skeletonDir(lang);
  if (!dir) return;
  const welcome = (process.env.MIO_SEED_WELCOME ?? 'on').toLowerCase() !== 'off';
  const seeded: string[] = [];
  for (const fname of fs.readdirSync(dir).sort()) {
    if (!fname.endsWith('.md')) continue;
    if (fname === 'welcome.md' && !welcome) continue;
    if (fs.existsSync(path.join(ARTIFACTS_DIR, fname))) continue;
    artifactsSave(fname, fs.readFileSync(path.join(dir, fname), 'utf-8'));
    seeded.push(fname);
  }
  if (seeded.length > 0) {
    logInfo(`CoreMem seeded (new environment, lang=${lang}): ${seeded.join(', ')}`);
    if (welcome) seedWelcomeInbox(lang);
  }
}
