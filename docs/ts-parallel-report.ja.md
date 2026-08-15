# TS前段 本番スイッチ化 準備調査レポート

*作成: 2026-08-15 / しずく（Code側）*
*発注: 汐（2026-08-15）*

---

## ① 本番用TSサービス定義の有無確認・作成

### 棚卸し結果

| 項目 | 本番Python（既存） | TS前段（今回作成） |
|------|-------------------|-------------------|
| Dockerfile | `memory/Dockerfile` (python:3.11-slim) | **`ts/Dockerfile` — 新規作成** (node:22-slim) |
| compose定義 | `docker-compose.yml` → `memory` サービス | **`docker-compose.parallel.yml` — 新規作成** (オーバーレイ) |
| ポート | 5002（`MIO_PORT` デフォルト） | 5003（`MIO_PORT=5003` で上書き） |
| ネットワーク | `network_mode: host` | `network_mode: host`（同一） |
| データ | `./memory/data:/data` | `./memory/data:/data`（同一ボリューム共有） |

### 作成したファイル

**`ts/Dockerfile`**
```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src/ src/
RUN npx tsc
CMD ["node", "dist/index.js"]
```
- 依存ゼロ設計（node:http のみ）のため軽量。node:22-slim ベース
- ビルド時に `npm install` → `npx tsc` でコンパイル
- 外部パッケージなし（devDependencies の `@types/node` と `typescript` のみ）

**`docker-compose.parallel.yml`**（オーバーレイ）
```yaml
version: '3'
services:
  ts-proxy:
    build:
      context: ./ts
      network: host
    network_mode: host
    volumes:
      - ./memory/data:/data
    environment:
      - MIO_PORT=5003
      - MIO_UPSTREAM_HOST=127.0.0.1
      - MIO_UPSTREAM_PORT=5002
    env_file:
      - .env
    restart: unless-stopped
    depends_on:
      - memory
```
- `docker-compose.yml`（本番）は**一切編集していない**
- `.env` から `MIO_API_TOKEN` / `MIO_BASE_URL` / `MIO_ALLOWED_ORIGINS` を継承
- `environment:` セクションで `MIO_PORT=5003` を上書き（.env の値より優先）

---

## ② TS前段のエンドポイント棚卸し

### Claude.ai クライアントが使う経路

| 経路 | 用途 | TS対応状況 | 分類 |
|------|------|-----------|------|
| `/.well-known/oauth-authorization-server` | OAuth ディスカバリ | **TS ネイティブ** | TS転送で通る |
| `/.well-known/oauth-protected-resource` | リソースメタデータ | **TS ネイティブ** | TS転送で通る |
| `/oauth/register` | DCR（動的クライアント登録） | **TS ネイティブ** | TS転送で通る |
| `/oauth/authorize` | 認可（GET=フォーム / POST=認証） | **TS ネイティブ** | TS転送で通る |
| `/oauth/token` | トークン発行・リフレッシュ | **TS ネイティブ** | TS転送で通る |
| `/mcp` POST | MCP JSON-RPC（tools/list, tools/call 等） | **TS ネイティブ**（トランスポート層）。tools/* は Python へ転送 | TS転送で通る |
| `/mcp` GET | SSE キープアライブ | **TS ネイティブ** | TS転送で通る |
| `/mcp` DELETE | セッション終了 | **TS ネイティブ** | TS転送で通る |

**結論: Claude.ai が使う全経路（OAuth + MCP）は TS 前段で完結する。**
MCP ツール実行（tools/call）はトランスポート層で受けて JSON-RPC のまま Python へ転送する構造のため、全35ツールが TS 経由で動作する。

### REST API 全経路の三分類

#### TS転送で通る（ネイティブ実装済み）

| 経路 | メソッド | 備考 |
|------|---------|------|
| `/health` | GET | `served_by: "ts"` 付加 |
| `/api/memory/index` | GET | random サンプリング含む |
| `/api/memory/tags` | GET | |
| `/api/memory/hsearch` | GET | 階層検索 |
| `/api/memory/<id>` | GET | |
| `/api/memory` | POST | ID採番・oplog |
| `/api/memory/<id>` | PATCH, DELETE | |
| `/api/memory/reindex` | POST | |
| `/api/inbox` | GET, POST | 全機能 |
| `/api/inbox/<id>` | GET, PATCH, DELETE | |
| `/api/inbox/<id>/read` | PATCH | |
| `/api/inbox/<id>/unread` | PATCH | |
| `/api/inbox/<id>/persistent` | PATCH | |
| `/api/coremem` | GET | 一覧 |
| `/api/coremem/<name>` | GET, POST, DELETE | マージ読み・symlink版管理含む |
| `/api/conversations/` | GET | 検索（body_search含む） |
| `/api/conversations/index` | GET | |
| `/api/conversations/index/rebuild` | POST | |
| `/api/conversations/<uuid>` | GET | |
| `/api/conversations/<uuid>/annotations` | GET | |
| `/api/conversations/share/<uuid>` | POST | |
| `/api/conversations/view` | GET | 認証不要の共有ビュー |
| `/api/conversations/<uuid>/rating` | PATCH | |
| OAuth 全4エンドポイント | GET, POST | RFC 8414 サフィックス形式含む |
| `/mcp` | GET, POST, DELETE | デュアル時代対応（レガシー＋2026-07-28） |

#### 素通し（透過プロキシで通る — TS は中継するだけ）

| 経路 | メソッド | 備考 |
|------|---------|------|
| `/admin.html` | GET | 静的HTML |
| `/logs.html` | GET | 静的HTML |
| `/share.html` | GET | 静的HTML |
| `/register`, `/activate` | GET | 友達登録ページ |
| `/api/import-status` | GET | |
| `/api/memories/symbolic` | GET | |
| `/api/export` | GET | バックアップZIP |
| `/api/import/backup` | POST | バックアップ復元 |
| `/api/import/compare` | POST | |
| `/api/import/claude-code` | POST | |
| `/api/import/openwebui` | POST | |
| `/import` | POST | ZIP一括インポート |
| `/api/memory/search` | GET | MCP用検索（hsearchとは別） |
| `/api/memory/dedup-scan` | POST | 重複スキャン |
| `/api/memory/cleanup-empty` | POST | 空エントリ掃除 |
| `/api/<path_token>/memory/*` | GET, POST | レガシーパストークン認証 |
| `/api/share-token` | POST | 共有トークン発行 |
| `/api/memory/share/<id>` | POST | 記憶共有 |
| `/api/share/<token>` | GET | 共有閲覧 |
| `/api/oplog` | GET | 操作ログ |
| `/api/oplog/<index>` | DELETE | 操作ログ個別削除 |
| `/api/friends/*` | 全メソッド | 友達システム全体 |
| `/api/conv-artifacts` | GET | |
| `/api/conv-artifacts/<uuid>/<file>` | GET | |
| `/api/conversations/cleanup-empty` | POST | |
| `/api/conversations/<uuid>/redact*` | POST, GET | リダクト全体 |
| `/api/conversations/redact-status` | GET | |
| `/api/batch/*` | GET, POST | 要約バッチ |
| `/api/rating-batch/*` | GET, POST | レーティングバッチ |
| `/api/attendance` | GET | 出席簿 |
| `/api/album/*` | 全メソッド | アルバム全体 |
| `/api/uploads/*` | 全メソッド | アップロード全体 |
| `/mcp/sse` | GET | レガシーSSE |
| `/mcp/messages` | POST | レガシーSSEメッセージ |
| `/mcp` (友達トークン) | POST | 友達セッション（TS が検出して透過転送） |

#### Python直のまま分離すべき（TS化の優先度が低い、または不要）

| 経路 | 理由 |
|------|------|
| `/api/conversations/<uuid>/digest` | ローカルLLM（LMStudio）連携が必要。TS化にはfetchベースのLLMクライアント実装が要る |
| `/api/batch/*`, `/api/rating-batch/*` | バックグラウンドスレッド＋LLM連携。TS化の利益が薄い |
| `/import` (ZIP) | multipart解析＋大量ファイル書き込み＋バッチ自動起動。複雑度が高い |
| `/api/import/backup`, `/api/import/compare` | 同上 |
| 友達セッション `/mcp` | ツール構成が動的（6ツール限定）。Python側で完結している |
| 静的HTML (`admin.html` 等) | Python の `send_file` で配信。TS化しても利益なし |

### 重要な所見

**OAuth系はTS転送で問題ない。** TS の OAuth 実装は Python 版と `oauth_store.json` を共有し、同一形式で永続化する。TS が発行したアクセストークンは Python 転送時に `API_TOKEN` に書き換えられるため、未移行エンドポイントでも TS 発行トークンが通る（`index.ts:238` のトークン書き換えロジック）。

**MCP 2026-07-28 はTSのみの実装。** Python側は 2025-11-25 のまま（`main.py` は旧仕様のみ）。モダン版の `server/discover` / `subscriptions/listen` / 必須ヘッダ検証はすべて TS が所有する。切り替え後も Python に手を入れる必要はない。

---

## ③ 並走構成の設計＋起動確認

### 構成図

```
                             ┌─────────────────────────┐
                             │  本番 Python (memory)    │
  Claude.ai (本番) ─────────►│  :5002  ← 変更なし      │
                             │  network_mode: host      │
                             └──────────┬──────────────┘
                                        │ upstream
                             ┌──────────┴──────────────┐
  検証用アクセス ───────────►│  TS前段 (ts-proxy)       │
                             │  :5003  ← 並走ポート     │
                             │  network_mode: host      │
                             │  /data 共有（読み書き）   │
                             └─────────────────────────┘
```

- 本番 Python（:5002）は完全に無風。再起動なし
- TS前段（:5003）は別ポートで独立稼働。上流に :5002 を指す
- `/data` ボリュームを共有（OAuth トークンや記憶データの一貫性のため）

### 起動手順（淳さん向けコピペ用）

```bash
# 1. 並走TSを起動（本番Pythonはそのまま）
docker-compose -f docker-compose.yml -f docker-compose.parallel.yml up -d --build ts-proxy

# 2. ヘルスチェック
curl http://127.0.0.1:5003/health
# → {"status":"ok","version":"3.89",...,"served_by":"ts"} が返れば成功

# 3. MCP レガシー経路の読み取り確認（memory_read_index 相当）
curl -H "Authorization: Bearer $MIO_API_TOKEN" http://127.0.0.1:5003/api/memory/index | head -c 200
# → JSON配列が返ればTS→Python転送が機能している

# 4. MCP JSON-RPC 疎通確認（tools/list）
curl -X POST http://127.0.0.1:5003/mcp \
  -H "Authorization: Bearer $MIO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# → initialize レスポンス（serverInfo に mio-memory）が返れば MCP 疎通OK
```

### 停止手順

```bash
# TS前段のみ停止（本番Pythonはそのまま）
docker-compose -f docker-compose.yml -f docker-compose.parallel.yml stop ts-proxy

# 完全に撤去する場合
docker-compose -f docker-compose.yml -f docker-compose.parallel.yml rm -f ts-proxy
```

### ロールバック手順

```bash
# TSコンテナを止めるだけ。本番Pythonは一切触っていないので即時復帰
docker-compose -f docker-compose.yml -f docker-compose.parallel.yml stop ts-proxy
# 本番は :5002 でそのまま稼働中。何も変わらない
```

---

## 第二便（切り替え本番）で必要になる作業の見積もり

### 「ポート付け替えだけで済む」のか

**ほぼ済む。ただし以下の確認・作業が追加で必要。**

| 作業 | 内容 | 規模 |
|------|------|------|
| **ポート付け替え** | `MIO_PORT=5003` → `5002`（または TS を :5002 に、Python を別ポートに退避） | 小 |
| **MIO_BASE_URL の確認** | TS 側の OAuth メタデータが `MIO_BASE_URL` を参照する。本番URL（HTTPS）と一致していることを確認 | 小 |
| **書き込み排他の確認** | 切り替え後は REST 書き込み（TS ネイティブ）と MCP tools/call（Python 転送）が同一 `/data` に書く。現行と同じ「最後に書いた者が勝つ」方式。テストで検証済みだが、本番ロード下での動作確認を推奨 | 中 |
| **友達セッションの確認** | 友達トークンは TS が検出して丸ごと Python に透過転送する。友達ユーザーがいる場合は切り替え後に疎通確認 | 小 |
| **compose構成の最終化** | オーバーレイではなく、`docker-compose.yml` 本体に `ts-proxy` を追加して `memory` の前段に据える。または `ts-proxy` を :5002 にして `memory` を内部ポートに変更 | 中 |
| **監視・ログ** | TS 側のアクセスログ（現在は console.log のみ）。本番運用で問題切り分けできるレベルのログが欲しいかは淳さん判断 | 任意 |

### 切り替え時に壊れる可能性がある点

1. **`/mcp/sse` と `/mcp/messages`（レガシーSSEエンドポイント）**: TS は `/mcp` の単一エンドポイントで処理する設計。`/mcp/sse` と `/mcp/messages` は Python に透過転送される。切り替え時に Python が別ポートに移ると、これらのレガシーエンドポイントのURLが変わる。ただし現在のClaude.aiクライアントは `/mcp` のみを使っており、レガシーSSE経路を使うクライアントがいなければ問題なし

2. **バッチ・ダイジェスト系のポート**: `/api/batch/start` 等はブラウザの admin.html から叩く。切り替え後は TS 経由になるが、透過プロキシで通るため機能上の問題はない。ただし admin.html 自体も TS 経由で Python から配信されることになる点に注意

3. **oauth_store.json の同時書き込み**: TS と Python が同一ファイルを read-modify-write する。OAuth トークン発行が集中しない限り競合リスクは極低だが、原理的にはレースコンディションの可能性がある。本番切り替え後は OAuth を TS に一本化し、Python 側の OAuth エンドポイントは使わない構成が理想

### 見積もり時間

- ポート付け替え＋compose最終化: **30分〜1時間**
- 疎通確認（MCP＋OAuth＋admin.html＋友達）: **30分**
- 問題発覚時のロールバック: **即時**（TS を止めて Python 直に戻すだけ）

**推奨**: 淳さん在宅日の日中に実施。ロールバックが即時なのでリスクは低い。

---

## 検収基準の確認

- [x] 現行本番（memoryコンテナ・Python直）に一切の変更・再起動が発生していない → **`docker-compose.yml` 未編集。memory サービスへの変更ゼロ**
- [ ] 並走TSが別ポートで起動し、少なくともMCPレガシー経路の読み取り1本が通ること → **淳さんのデプロイ後に確認**（上記手順のステップ2〜4で検証可能。ローカルではテスト済み: `MIO_TS1=1 pytest tests/` 105件全パス）
