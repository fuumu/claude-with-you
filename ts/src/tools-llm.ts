/**
 * TS-1 リング5: LLM 依存の MCP ツール（main.py _handle_tool_call_raw と同一契約）。
 * conversation_digest / batch_run_summary_layers / batch_run_rating / sublimate / llm_status
 *
 * LLM 呼び出しは llm.ts、処理本体は llm-tasks.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONVERSATIONS_DIR } from './data.js';
import { safeId } from './inbox.js';
import { llmStatus } from './llm.js';
import {
  batchStatus,
  convTextForSublimation,
  conversationDigest,
  countPendingEntries,
  countPendingRatings,
  ratingBatchStatus,
  ratingIndexCounts,
  startRatingBatch,
  startSummaryBatch,
  sublimateText,
} from './llm-tasks.js';
import { Handler, truthy } from './tool-types.js';
import { nowJst } from './write.js';

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

const conversationDigestTool: Handler = async (args) => {
  const uid = str(args.uuid);
  if (!uid) return { error: 'uuid is required' };
  if (!safeId(uid)) return { error: `conversation not found: ${uid}` };
  if (truthy(args.status_only)) {
    if (!fs.existsSync(path.join(CONVERSATIONS_DIR, `${uid}.json`))) {
      return { error: `conversation not found: ${uid}` };
    }
    return {
      uuid: uid,
      status_only: true,
      has_digest: fs.existsSync(path.join(CONVERSATIONS_DIR, `${uid}_digest.json`)),
      has_safe_digest: fs.existsSync(path.join(CONVERSATIONS_DIR, `${uid}_digest_safe.json`)),
      server_time: nowJst(),
    };
  }
  return conversationDigest(uid, truthy(args.force), truthy(args.safe_mode));
};

const batchRunSummaryLayers: Handler = (args) => {
  if (truthy(args.status_only)) {
    const { raw, kw } = countPendingEntries();
    return { ...batchStatus, raw_pending: raw, keywords_pending: kw, server_time: nowJst() };
  }
  const { info } = startSummaryBatch(args.backend ? String(args.backend) : null, truthy(args.force));
  return { ...info, server_time: nowJst() };
};

const batchRunRating: Handler = (args) => {
  if (truthy(args.status_only)) {
    return {
      ...ratingBatchStatus,
      pending: countPendingRatings(),
      index_counts: ratingIndexCounts(),
      server_time: nowJst(),
    };
  }
  const { info } = startRatingBatch(args.backend ? String(args.backend) : null, truthy(args.force));
  return { ...info, server_time: nowJst() };
};

const sublimate: Handler = async (args) => {
  let text: unknown = args.text;
  const uid = args.uuid;
  if (!truthy(text) && !truthy(uid)) return { error: 'text or uuid is required' };
  if (truthy(text) && truthy(uid)) return { error: 'text and uuid are exclusive' };
  if (truthy(uid)) {
    const u = str(uid);
    if (!safeId(u)) return { error: `conversation not found: ${u}` };
    const r = convTextForSublimation(u, args.msg_from, args.msg_to);
    if (r.error) return r.error;
    text = r.text;
  }
  try {
    const result = await sublimateText(String(text));
    if (truthy(uid)) result.uuid = uid;
    return result;
  } catch (e) {
    return { error: `sublimation failed: ${(e as Error).message}` };
  }
};

const llmStatusTool: Handler = () => llmStatus();

export const LLM_HANDLERS: Record<string, Handler> = {
  conversation_digest: conversationDigestTool,
  batch_run_summary_layers: batchRunSummaryLayers,
  batch_run_rating: batchRunRating,
  sublimate,
  llm_status: llmStatusTool,
};
