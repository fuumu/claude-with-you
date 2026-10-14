/**
 * TS-1 リング5: LLM クライアント（main.py の _llm_endpoints / _llm_discover_models / _lm_client /
 * _llm_extract_text 相当）。外部依存なし（node:fetch のみ）。
 *
 * プロトコル: main.py は Anthropic SDK を base_url 差し替えで使っているため、ローカル LLM
 * （LM Studio / FreeToken 等）にも Anthropic Messages 互換の `POST {base}/v1/messages` を投げている。
 * ここでも同一プロトコルで叩く（挙動を変えない）。backend='anthropic' は api.anthropic.com。
 *
 * 接続先は Python 側と同じ環境変数: LLM_ENDPOINTS / LM_STUDIO_HOST / LM_STUDIO_PORT /
 * LLM_OK_MODELS / MIO_LM_MODEL。
 */
import { nowJst } from './write.js';

const CONNECT_TIMEOUT_MS = 5000;
const LM_TIMEOUT_MS = 300_000;
const ANTHROPIC_TIMEOUT_MS = 600_000;
const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_BATCH_MODEL = 'claude-haiku-4-5-20251001';

// ── ログ（標準出力 + 直近 100 件のリングバッファ。llm_status が返す）──────────────

const llmLogBuffer: string[] = [];

export function logInfo(msg: string): void {
  if ((process.env.MIO_LOG_LEVEL ?? 'info') === 'off') return;
  console.log(`[mio] ${msg}`);
}

export function logError(msg: string): void {
  if ((process.env.MIO_LOG_LEVEL ?? 'info') === 'off') return;
  console.error(`[mio] ERROR ${msg}`);
}

export function logLlm(msg: string): void {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  llmLogBuffer.push(`[${ts}] ${msg}`);
  while (llmLogBuffer.length > 100) llmLogBuffer.shift();
  logInfo(msg);
}

export function recentLlmLogs(): string[] {
  return [...llmLogBuffer];
}

// ── 設定 ─────────────────────────────────────────────────────────────

export function llmEndpoints(): string[] {
  const epStr = process.env.LLM_ENDPOINTS ?? '';
  if (epStr) {
    const eps = epStr.split(',').map((e) => e.trim()).filter((e) => e);
    if (eps.length > 0) return eps.map((e) => (e.startsWith('http') ? e : `http://${e}`));
  }
  const host = process.env.LM_STUDIO_HOST ?? '192.168.10.32';
  const port = process.env.LM_STUDIO_PORT ?? '1234';
  return [`http://${host}:${port}`];
}

export function llmOkModels(): string[] {
  const okStr = process.env.LLM_OK_MODELS ?? '';
  if (okStr) {
    const models = okStr.split(',').map((m) => m.trim()).filter((m) => m);
    if (models.length > 0) return models;
  }
  return [process.env.MIO_LM_MODEL ?? 'google/gemma-4-26b-a4b'];
}

/** モデルIDを OK リストと照合する（インスタンス接尾辞 :N を考慮）。不一致は null */
export function matchOkModel(mid: string, okModels: string[]): string | null {
  if (okModels.includes(mid)) return mid;
  const base = mid.replace(/:\d+$/, '');
  if (base !== mid && okModels.includes(base)) return base;
  return null;
}

// ── HTTP ヘルパー ─────────────────────────────────────────────────────

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as unknown;
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<void> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  await resp.arrayBuffer();
}

type ModelRow = Record<string, unknown>;

function modelRows(data: unknown): ModelRow[] {
  const d = data as { data?: unknown; models?: unknown } | null;
  const rows = d?.data ?? d?.models ?? [];
  return Array.isArray(rows) ? (rows as ModelRow[]) : [];
}

// ── 探索・ロード ──────────────────────────────────────────────────────

/** エンドポイントでロード中のモデルID一覧。管理 API（LM Studio）→ OpenAI 形式 /v1/models の順。失敗は [] */
export async function discoverModels(baseUrl: string): Promise<string[]> {
  try {
    const data = await getJson(`${baseUrl}/api/v1/models`, CONNECT_TIMEOUT_MS);
    const models: string[] = [];
    for (const m of modelRows(data)) {
      const mid = String(m.id ?? m.key ?? '');
      const inst = m.loaded_instances;
      if (mid && Array.isArray(inst) && inst.length > 0) models.push(mid);
    }
    logLlm(`LLM discover (mgmt) ${baseUrl}: ${JSON.stringify(models)}`);
    return models;
  } catch {
    /* 管理 API 非対応 → /v1/models へ */
  }
  try {
    const data = await getJson(`${baseUrl}/v1/models`, CONNECT_TIMEOUT_MS);
    const models: string[] = [];
    for (const m of modelRows(data)) {
      const mid = String(m.id ?? m.key ?? '');
      if (mid) models.push(mid);
    }
    logLlm(`LLM discover (openai) ${baseUrl}: ${JSON.stringify(models)}`);
    return models;
  } catch (e) {
    logLlm(`LLM discover failed for ${baseUrl}: ${(e as Error).message}`);
    return [];
  }
}

/** LM Studio 管理 API の /api/v1/models（非対応・接続失敗は null） */
export async function discoverLmstudio(baseUrl: string): Promise<unknown | null> {
  try {
    return await getJson(`${baseUrl}/api/v1/models`, CONNECT_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export async function endpointSupportsManagement(
  baseUrl: string,
): Promise<{ supported: boolean; data: unknown | null }> {
  const data = await discoverLmstudio(baseUrl);
  return { supported: data !== null, data };
}

async function unloadInstance(baseUrl: string, instanceId: string, modelId: string): Promise<void> {
  try {
    await postJson(`${baseUrl}/api/v1/models/unload`, { instance_id: instanceId }, 30_000);
    logLlm(`LM unloaded: ${modelId} (instance: ${instanceId})`);
  } catch (e) {
    logLlm(`LM unload failed for ${instanceId}: ${(e as Error).message}`);
  }
}

async function loadModel(baseUrl: string, modelId: string): Promise<void> {
  await postJson(`${baseUrl}/api/v1/models/load`, { model: modelId }, 180_000);
  logLlm(`LM loaded: ${modelId}`);
}

// ── クライアント ──────────────────────────────────────────────────────

export interface LlmClient {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface MessageRequest {
  model: string;
  maxTokens: number;
  prompt: string;
  temperature?: number;
}

/** Anthropic SDK の既定（max_retries=2）に倣い、接続断・408/409/429/5xx のみ再試行する */
async function postMessages(client: LlmClient, body: Record<string, unknown>): Promise<unknown> {
  const url = `${client.baseUrl}/v1/messages`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': client.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(client.timeoutMs),
      });
      if (resp.ok) return (await resp.json()) as unknown;
      const text = await resp.text();
      lastErr = new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      if (![408, 409, 429].includes(resp.status) && resp.status < 500) throw lastErr;
    } catch (e) {
      lastErr = e as Error;
      if (lastErr.message.startsWith('HTTP ') && !/^HTTP (408|409|429|5\d\d)/.test(lastErr.message)) {
        throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error('LLM request failed');
}

/** Python _llm_extract_text 互換: 最初の text ブロックの本文（trim）。なければ content[0].text */
export function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown } | null)?.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  for (const block of content as Record<string, unknown>[]) {
    if (block && block.type === 'text') return String(block.text ?? '').trim();
  }
  const first = content[0] as Record<string, unknown> | undefined;
  return String(first?.text ?? '').trim();
}

/** messages.create 相当。返値はテキスト（_llm_extract_text 済み） */
export async function createMessage(client: LlmClient, req: MessageRequest): Promise<string> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: [{ role: 'user', content: req.prompt }],
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return extractText(await postMessages(client, body));
}

function lmStudioClient(baseUrl: string): LlmClient {
  return { baseUrl, apiKey: 'lmstudio', timeoutMs: LM_TIMEOUT_MS };
}

/** バッチ等の backend 指定でクライアントとモデルを得る（main.py の分岐と同じ） */
export async function clientForBackend(
  backend: string,
  apiKey: string,
): Promise<{ client: LlmClient; model: string }> {
  if (backend === 'lmstudio') return lmClient();
  return {
    client: { baseUrl: ANTHROPIC_BASE, apiKey, timeoutMs: ANTHROPIC_TIMEOUT_MS },
    model: ANTHROPIC_BATCH_MODEL,
  };
}

/**
 * マルチエンドポイント対応のローカル LLM クライアント選択（main.py _lm_client と同一フロー）:
 * 1. 各エンドポイントのアクティブモデルを取得
 * 2. OK リストに合うアクティブモデルがあればそのまま使う（requested_model の直接一致が最優先）
 * 3. なければ管理 API 対応エンドポイントでロード試行
 * 4. どこにもなければエラー
 */
export async function lmClient(
  requestedModel?: string,
): Promise<{ client: LlmClient; model: string }> {
  const endpoints = llmEndpoints();
  const okModels = llmOkModels();

  const endpointModels = new Map<string, string[]>();
  for (const ep of endpoints) endpointModels.set(ep, await discoverModels(ep));

  if (requestedModel) {
    for (const ep of endpoints) {
      for (const active of endpointModels.get(ep) ?? []) {
        const matched = matchOkModel(active, [requestedModel]);
        if (matched) {
          logLlm(`LLM direct match: ${matched} at ${ep}`);
          return { client: lmStudioClient(ep), model: matched };
        }
      }
    }
  }

  let best: { ep: string; model: string } | null = null;
  let bestPriority = okModels.length;
  for (const ep of endpoints) {
    for (const active of endpointModels.get(ep) ?? []) {
      const matched = matchOkModel(active, okModels);
      if (matched) {
        const priority = okModels.indexOf(matched);
        logLlm(`LLM active OK candidate: ${matched} (priority ${priority}) at ${ep}`);
        if (priority < bestPriority) {
          bestPriority = priority;
          best = { ep, model: matched };
        }
      }
    }
  }
  if (best) {
    logLlm(`LLM using active OK model: ${best.model} at ${best.ep}`);
    return { client: lmStudioClient(best.ep), model: best.model };
  }

  logLlm('LLM no active OK model found, will attempt load');
  const loadTarget = requestedModel || okModels[0];
  for (const ep of endpoints) {
    const { supported, data } = await endpointSupportsManagement(ep);
    if (!supported) continue;
    try {
      if (data) {
        for (const m of modelRows(data)) {
          const instances = Array.isArray(m.loaded_instances)
            ? (m.loaded_instances as Record<string, unknown>[])
            : [];
          const mid = String(m.key ?? m.id ?? '');
          if (!matchOkModel(mid, okModels)) {
            for (const inst of instances) await unloadInstance(ep, String(inst.id), mid);
          }
        }
      }
      await loadModel(ep, loadTarget);
      logLlm(`LLM loaded ${loadTarget} at ${ep}`);
      return { client: lmStudioClient(ep), model: loadTarget };
    } catch (e) {
      logLlm(`LLM load failed at ${ep}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `No LLM endpoint available for model ${loadTarget}. Endpoints tried: ${JSON.stringify(endpoints)}`,
  );
}

// ── llm_status（REST /api/llm-status と同一データ）───────────────────────

export async function llmStatus(): Promise<Record<string, unknown>> {
  const endpoints = llmEndpoints();
  const okModels = llmOkModels();
  const endpointInfo: Record<string, unknown> = {};
  const okActiveByEp = new Map<string, { model: string; ok_name: string; priority: number }[]>();
  for (const ep of endpoints) {
    const models = await discoverModels(ep);
    const { supported } = await endpointSupportsManagement(ep);
    const okActive: { model: string; ok_name: string; priority: number }[] = [];
    for (const m of models) {
      const matched = matchOkModel(m, okModels);
      if (matched) okActive.push({ model: m, ok_name: matched, priority: okModels.indexOf(matched) });
    }
    okActiveByEp.set(ep, okActive);
    endpointInfo[ep] = { active_models: models, management_api: supported, ok_active: okActive };
  }
  let best: { endpoint: string; model: string; priority: number } | null = null;
  let bestPriority = okModels.length;
  for (const ep of endpoints) {
    for (const item of okActiveByEp.get(ep) ?? []) {
      if (item.priority < bestPriority) {
        bestPriority = item.priority;
        best = { endpoint: ep, model: item.ok_name, priority: item.priority };
      }
    }
  }
  const wouldLoad = best ? null : okModels[0] ?? null;
  return {
    endpoints: endpointInfo,
    ok_models: okModels,
    selection: best ?? { action: 'would_load', model: wouldLoad },
    recent_logs: recentLlmLogs(),
    server_time: nowJst(),
  };
}
