/**
 * TS-1 ストラングラー・リング0: TypeScript リバースプロキシ
 *
 * 全リクエストを Python 実装（main.py）へ透過転送する。/health のみ TS 側で
 * ネイティブ実装（形状互換・served_by: "ts" を追加）。以降のリング（TS-1 本移行）では
 * エンドポイントを1つずつ NATIVE_ROUTES に移し、特性テスト（tests/）が全パスする
 * ことを合格判定として進める。
 *
 * 依存ゼロ（node:http のみ）。SSE / チャンク転送は pipe でそのまま通す。
 *
 * 環境変数:
 *   MIO_PORT          このプロキシのリッスンポート（デフォルト 5003）
 *   MIO_UPSTREAM_HOST Python 側ホスト（デフォルト 127.0.0.1）
 *   MIO_UPSTREAM_PORT Python 側ポート（デフォルト 5002）
 */
import http from 'node:http';

const PORT = parseInt(process.env.MIO_PORT ?? '5003', 10);
const UPSTREAM_HOST = process.env.MIO_UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.MIO_UPSTREAM_PORT ?? '5002', 10);

interface HealthShape {
  status: string;
  version: string;
  mcp_tool_count: number;
  [key: string]: unknown;
}

let healthCache: HealthShape | null = null;

/** アップストリームの /health を取得（バージョン等の形状互換のため） */
function fetchUpstreamHealth(): Promise<HealthShape> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: '/health', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as HealthShape);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream health timeout')));
  });
}

/** /health のネイティブ実装（リング0で唯一 TS が直接応えるエンドポイント） */
async function handleHealth(res: http.ServerResponse): Promise<void> {
  try {
    if (!healthCache) {
      healthCache = await fetchUpstreamHealth();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...healthCache, served_by: 'ts' }));
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'upstream unavailable' }));
  }
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/health' || url.startsWith('/health?')) {
    void handleHealth(res);
    return;
  }

  // 透過プロキシ（ヘッダ・ボディ・ステータスをそのまま中継。SSE も pipe で流れる）
  const proxyReq = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: url,
      method: req.method,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'upstream unavailable' }));
  });
  req.pipe(proxyReq);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mio-memory-ts ring0 proxy: 127.0.0.1:${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
  );
});
