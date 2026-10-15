/**
 * TS-1 リング5: LLM 依存 REST のネイティブ実装（main.py と同一契約）。
 *   POST /api/conversations/<uuid>/digest   （force / safe_mode / status_only クエリ）
 *   GET  /api/batch/status    POST /api/batch/start
 *   GET  /api/rating-batch/status    POST /api/rating-batch/start
 *   GET  /api/llm-status
 * 担当ルートなら true を返す（認証は本関数内）。
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { extractBearer, verifyToken } from './auth.js';
import { CONVERSATIONS_DIR } from './data.js';
import { llmStatus } from './llm.js';
import {
  batchStatus,
  conversationDigest,
  countPendingRatings,
  ratingBatchStatus,
  ratingIndexCounts,
  startRatingBatch,
  startSummaryBatch,
} from './llm-tasks.js';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const flag = (v: string | null): boolean => ['true', '1'].includes((v ?? '').toLowerCase());

async function startBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const d = JSON.parse(await readBody(req)) as unknown;
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function handleLlmRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? '';

  const digest = /^\/api\/conversations\/([^/]+)\/digest$/.exec(p);
  const isBatchStatus = p === '/api/batch/status' && method === 'GET';
  const isBatchStart = p === '/api/batch/start' && method === 'POST';
  const isRatingStatus = p === '/api/rating-batch/status' && method === 'GET';
  const isRatingStart = p === '/api/rating-batch/start' && method === 'POST';
  const isLlmStatus = p === '/api/llm-status' && method === 'GET';
  const isDigest = !!digest && method === 'POST';
  if (!(isDigest || isBatchStatus || isBatchStart || isRatingStatus || isRatingStart || isLlmStatus)) {
    return false;
  }

  if (!verifyToken(extractBearer(req, url))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (isLlmStatus) {
    sendJson(res, 200, await llmStatus());
    return true;
  }
  if (isBatchStatus) {
    sendJson(res, 200, batchStatus);
    return true;
  }
  if (isRatingStatus) {
    sendJson(res, 200, {
      ...ratingBatchStatus,
      pending: countPendingRatings(),
      index_counts: ratingIndexCounts(),
    });
    return true;
  }
  if (isBatchStart || isRatingStart) {
    const data = await startBody(req);
    const backend = data.backend ? String(data.backend) : null;
    const force = Boolean(data.force ?? false) && data.force !== 0 && data.force !== '';
    const apiKey = data.api_key ? String(data.api_key) : null;
    const { ok, info } = isBatchStart
      ? startSummaryBatch(backend, force, apiKey)
      : startRatingBatch(backend, force, apiKey);
    if (!ok) {
      sendJson(res, info.error === 'already running' ? 409 : 400, info);
    } else {
      sendJson(res, 200, info);
    }
    return true;
  }

  // POST /api/conversations/<uuid>/digest
  const uuid = decodeURIComponent(digest![1]);
  const force = flag(url.searchParams.get('force'));
  const safeMode = flag(url.searchParams.get('safe_mode'));
  const statusOnly = flag(url.searchParams.get('status_only'));
  const safe = !!uuid && !uuid.includes('/') && !uuid.includes('\\') &&!uuid.includes('..');
  if (statusOnly) {
    if (!safe || !fs.existsSync(path.join(CONVERSATIONS_DIR, `${uuid}.json`))) {
      sendJson(res, 404, { error: `conversation not found: ${uuid}` });
      return true;
    }
    sendJson(res, 200, {
      uuid,
      status_only: true,
      has_digest: fs.existsSync(path.join(CONVERSATIONS_DIR, `${uuid}_digest.json`)),
      has_safe_digest: fs.existsSync(path.join(CONVERSATIONS_DIR, `${uuid}_digest_safe.json`)),
    });
    return true;
  }
  if (!safe) {
    sendJson(res, 404, { error: `conversation not found: ${uuid}` });
    return true;
  }
  try {
    const result = await conversationDigest(uuid, force, safeMode);
    sendJson(res, 'error' in result ? 404 : 200, result);
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
  return true;
}
