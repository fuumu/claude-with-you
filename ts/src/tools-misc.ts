/**
 * TS-1 リング4 グループ8: その他の MCP ツール。
 * ネイティブ: oplog_list / attendance_view
 * （llm_status・batch_run_*・sublimate・conversation_digest は Ring 5 で tools-llm.ts に移した）
 */
import fs from 'node:fs';
import { attendanceView } from './attendance-view.js';
import { Handler, toInt } from './tool-types.js';
import { OPLOG_FILE } from './write.js';

const oplogList: Handler = (args) => {
  try {
    let oplog: Record<string, unknown>[] = [];
    if (fs.existsSync(OPLOG_FILE)) {
      oplog = JSON.parse(fs.readFileSync(OPLOG_FILE, 'utf-8')) as Record<string, unknown>[];
    }
    const opFilter = args.operation;
    const dFrom = String(args.date_from || '');
    const dTo = String(args.date_to || '');
    const limRaw = 'limit' in args ? toInt(args.limit) : 50;
    if (Number.isNaN(limRaw)) throw new Error('limit must be an integer');
    const lim = Math.min(limRaw, 500);
    if (opFilter) oplog = oplog.filter((e) => e.operation === opFilter);
    if (dFrom) oplog = oplog.filter((e) => String('timestamp' in e ? e.timestamp : '') >= dFrom);
    if (dTo) {
      const end = dTo.length <= 10 ? dTo + 'T23:59:59' : dTo;
      oplog = oplog.filter((e) => String('timestamp' in e ? e.timestamp : '') <= end);
    }
    const rows = [...oplog].reverse().map((e) => ({
      timestamp: e.timestamp ?? null,
      operation: e.operation ?? null,
      target_id: e.entry_id ?? null,
    }));
    return { total: rows.length, rows: rows.slice(0, lim) };
  } catch (e) {
    return { error: `oplog_list failed: ${(e as Error).message}` };
  }
};

const attendanceViewTool: Handler = (args) => {
  try {
    const kindStr = args.kind ? String(args.kind) : '';
    const kinds = kindStr
      ? new Set(kindStr.split(',').map((k) => k.trim()))
      : null;
    const limRaw = 'limit' in args ? toInt(args.limit) : 50;
    if (Number.isNaN(limRaw)) throw new Error('limit must be an integer');
    return attendanceView({
      individual: args.individual ? String(args.individual) : null,
      dateFrom: String(args.date_from || ''),
      dateTo: String(args.date_to || ''),
      limit: Math.min(limRaw, 500),
      kindFilter: kinds,
    });
  } catch (e) {
    return { error: `attendance_view failed: ${(e as Error).message}` };
  }
};

export const MISC_HANDLERS: Record<string, Handler> = {
  oplog_list: oplogList,
  attendance_view: attendanceViewTool,
};
