/**
 * TS-FULL ステップ7: 夜間バッチ（main.py _nightly_batch_loop と同一）。
 * 毎日 MIO_NIGHTLY_BATCH_HOUR 時（JST・既定 3）に、要約レイヤー待ち（raw・キーワード未生成）と
 * レーティング待ちの会話を数え、あればバッチを起動する。バックエンドは MIO_NIGHTLY_BATCH_BACKEND
 * （既定 lmstudio = ローカル LLM）。MIO_NIGHTLY_BATCH_HOUR=off で無効。
 */
import { logError, logInfo } from './llm.js';
import { countPendingEntries, countPendingRatings, startRatingBatch, startSummaryBatch } from './llm-tasks.js';

const HOUR_MS = 3600 * 1000;
const JST_MS = 9 * HOUR_MS;

/** 次の hour:00（JST）までのミリ秒。今がちょうどその時刻以降なら翌日 */
export function msUntilNextJstHour(hour: number, now = Date.now()): number {
  const jst = new Date(now + JST_MS);
  let next = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hour) - JST_MS;
  if (next <= now) next += 24 * HOUR_MS;
  return next - now;
}

function runNightly(): void {
  const backend = process.env.MIO_NIGHTLY_BATCH_BACKEND || 'lmstudio';
  const { raw, kw } = countPendingEntries();
  if ((raw ?? 0) + (kw ?? 0) > 0) {
    const r = startSummaryBatch(backend);
    logInfo(`nightly batch: raw_pending=${raw} keywords_pending=${kw} started=${r.ok} backend=${r.info.backend}`);
  } else {
    logInfo('nightly batch: no pending summary entries, skipped');
  }
  const pending = countPendingRatings();
  if ((pending ?? 0) > 0) {
    const r = startRatingBatch(backend);
    logInfo(`nightly rating batch: pending=${pending} started=${r.ok} backend=${r.info.backend}`);
  } else {
    logInfo('nightly rating batch: no pending conversations, skipped');
  }
}

/** 夜間バッチのタイマーを始める（プロセスを生かし続けないよう unref） */
export function startNightlyScheduler(): void {
  const schedule = (ms: number, fn: () => void) => setTimeout(fn, ms).unref();
  const tick = (): void => {
    const hourS = (process.env.MIO_NIGHTLY_BATCH_HOUR ?? '3').trim().toLowerCase();
    if (['', 'off', 'none'].includes(hourS)) {
      schedule(HOUR_MS, tick);
      return;
    }
    if (!/^[+-]?\d+$/.test(hourS)) {
      logError(`nightly batch loop error: invalid MIO_NIGHTLY_BATCH_HOUR: ${hourS}`);
      schedule(HOUR_MS, tick);
      return;
    }
    const hour = Math.max(0, Math.min(23, parseInt(hourS, 10)));
    schedule(msUntilNextJstHour(hour), () => {
      try {
        runNightly();
      } catch (e) {
        logError(`nightly batch loop error: ${(e as Error).message}`);
      }
      tick();
    });
  };
  tick();
}
