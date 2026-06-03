# claude-with-you

[日本語](#claude-with-you) | [English](#claude-with-you-english)

Claude用の外部記憶MCPサーバー。Synology NAS上のDockerで稼働し、Claude.aiおよびClaude CodeからMCPプロトコルで読み書きできる。

---

## 機能一覧（v3.2）

**記憶操作（5ツール）**
- `memory_read_index` — インデックス一覧取得
- `memory_read` — エントリ取得（ID指定）
- `memory_write` — 新規エントリ書き込み
- `memory_upsert` — 固定IDで上書き（存在しない場合は新規作成）
- `memory_search` — キーワード全文検索

**記憶シェア（1ツール）**
- `memory_share` — 記憶エントリの24時間有効な共有URLを生成（`/admin.html?token=...&id=...`）

**アーティファクト管理（3ツール）**
- `artifacts_save` — バージョン管理付きファイル保存
- `artifacts_read` — 最新または指定バージョンの読み込み
- `artifacts_list` — 保存済みアーティファクト一覧

**会話ログ検索・シェア（2ツール）**
- `conversation_search` — 過去の会話ログをキーワードで検索（タイトル一致）
- `conversation_share` — 特定の会話の24時間有効な共有URLを生成（`/logs.html?token=...`）

**インポート**
- `POST /import` — Claude.ai エクスポートZIPをバッチインポート（重複スキップ）
  - `conversations.json` — チャット一覧を記憶エントリとして取り込み、かつ `/data/conversations/` にも全文保存
  - `memories.json` — userMemoriesの内容を `core_memories_YYYYMMDD.md` としてartifactsに保存
  - `projects/*.json` — スタータープロジェクトを除くプロジェクト情報をエントリとして記録

**会話ログビューア（logs.html）**
- admin.html の **Logs** タブから閲覧、または `https://your-nas-domain/logs.html` で直接アクセス
- ZIPインポート済みの会話をサーバーから自動読み込み（`GET /api/conversations/`）
- キーワード・日付範囲・最小メッセージ数でフィルタ
- メッセージをマークダウンレンダリング（marked.js + DOMPurify）
- thinking / tool_use / tool_result ブロックを折り畳み表示、「思考を表示」トグル
- 関連記憶パネル：`source_thread` UUID 一致 → タイトルキーワード検索のフォールバック
- フォントサイズ切り替え（小/中/大）、設定は localStorage に保存
- `?token=` 共有URLで認証なし閲覧可能

---

## アーキテクチャ

```
Claude.ai / Claude Code
       │  MCP over HTTPS (OAuth 2.1 or Bearer)
       ▼
  Synology NAS
  ┌─────────────────────────────────┐
  │  Docker: memory コンテナ         │
  │  Flask (port 5002)              │
  │  memory/app/main.py（単一ファイル）│
  │                                 │
  │  /mcp          MCP Streamable   │
  │  /api/memory/* REST API         │
  │  /api/artifacts/* REST API      │
  │  /api/conversations/* REST API  │
  │  /import       ZIPインポート     │
  │  /admin.html   管理UI           │
  │  /logs.html    会話ログビューア  │
  │  /oauth/*      OAuth 2.1        │
  └──────────────┬──────────────────┘
                 │ volume mount
  ┌──────────────▼──────────────────┐
  │  memory/data/                   │
  │  ├── memory/*.json       記憶エントリ    │
  │  ├── artifacts/          ファイル管理    │
  │  ├── conversations/      会話ログ全文    │
  │  ├── index.json          インデックス   │
  │  └── oplog.json          操作ログ      │
  └─────────────────────────────────┘
```

- 実装は `memory/app/main.py` 1ファイルに集約
- 記憶エントリはJSONファイル（1エントリ1ファイル）
- アーティファクトはシンボリックリンク＋世代管理ディレクトリ
- Python依存はすべて `memory/wheels/` にベンダリング済み（ビルド時インターネット不要）

---

## クイックスタート

### 1. `.env` を作成

`.env_sample` をコピーして `MIO_API_TOKEN` を書き換える。

```bash
cp .env_sample .env
# MIO_API_TOKEN を自分のトークンに変更する
```

### 2. 起動

```bash
docker-compose up -d
```

### 3. ヘルスチェック

```bash
curl https://your-nas-domain/health
# {"status": "ok", "version": "3.2", ...}
```

### 4. Claude Codeへの登録（WS側）

```powershell
claude mcp add --transport http mio-memory https://your-nas-domain/mcp
```

OAuth認証画面が開くので `MIO_API_TOKEN` の値を入力して接続を許可。

### コード変更後の再デプロイ

```bash
docker-compose up -d --build memory
```

---

## MCPツール一覧（計11ツール）

| ツール名 | 用途 | 主な引数 |
|---------|------|---------|
| `memory_read_index` | インデックス一覧取得 | なし |
| `memory_read` | エントリ取得 | `id` |
| `memory_write` | 新規エントリ作成 | `title`, `body`, `tags`, `importance` |
| `memory_upsert` | 固定IDで上書き | `id`, `title`, `body`, `tags`, `importance` |
| `memory_search` | キーワード検索 | `q` |
| `memory_share` | 記憶エントリの24h共有URL生成 | `id` |
| `artifacts_save` | ファイル保存（バージョン管理） | `name`, `content` |
| `artifacts_read` | ファイル読み込み | `name`, `version`（省略時は最新） |
| `artifacts_list` | アーティファクト一覧 | なし |
| `conversation_search` | 会話ログをキーワード検索 | `q`, `limit`（省略時5） |
| `conversation_share` | 会話の24h共有URL生成 | `uuid` |

**memory_share の使用例：**

```
澪「あの記憶エントリを淳さんに見せたい」
→ memory_share(id="20260603_...") でURLを生成
→ 淳さんにURLを送る → ログイン不要で admin.html の記憶詳細を閲覧できる
```

**conversation_search / conversation_share の使用例：**

```
澪「あの〇〇の会話を見たい」
→ conversation_search(q="〇〇") でuuidを特定
→ conversation_share(uuid="...") で logs.html?token=... URLを取得
→ 淳さんにURLを送る → ログイン不要で会話を閲覧できる
```

**アーティファクトのディレクトリ構造：**
```
data/artifacts/
├── core.md          → versions/core_md/003.md  （シンボリックリンク）
└── versions/
    └── core_md/
        ├── 001.md
        ├── 002.md
        └── 003.md
```

---

## 設定（環境変数）

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `MIO_API_TOKEN` | `changeme` | Bearer認証トークン兼OAuthパスワード |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | （空） | 許可Origin（カンマ区切り）。空の場合はOrigin検証スキップ |

---

## ドキュメント

| ファイル | 内容 |
|---------|------|
| [docs/design.md](docs/design.md) | MCPサーバー拡張設計仕様。memory_upsert・artifacts管理・ZIPインポート・MCP initialize instructions・4階層検索アーキテクチャ・バッチ処理の設計を記載 |
| [docs/setup.md](docs/setup.md) | NAS→GitHub→WS の初回セットアップ手順（SSH鍵・git初期化・Claude Code登録） |
| [docs/talk-and-build.md](docs/talk-and-build.md) | claude.ai chat（設計・議論）と Claude Code（実装・git操作）を役割分担する開発ワークフローの説明 |

---

## プロジェクト構成

```
claude-with-you/
├── CLAUDE.md               Claude Code向けアーキテクチャ文書
├── README.md
├── docker-compose.yml
├── .env_sample             環境変数サンプル（これをコピーして .env を作る）
├── .env                    (gitignored) 環境変数
├── docs/
│   ├── design.md           MCPサーバー拡張設計仕様（8セクション）
│   ├── setup.md            NAS→GitHub→WSセットアップ手順
│   └── talk-and-build.md   chat×Claude Code 役割分担ワークフロー
├── scripts/
│   └── generate_summary_layers.py  rawエントリの2層・3層要約生成バッチ
└── memory/
    ├── Dockerfile
    ├── app/
    │   ├── main.py         サーバー本体（全機能を1ファイルに集約）
    │   ├── admin.html      管理UI（Memory/Artifacts/Import/Oplog/Logsタブ）
    │   ├── logs.html       会話ログビューア（サーバーから自動読み込み）
    │   └── requirements.txt
    ├── wheels/             Pythonホイール（ベンダリング済み）
    └── data/               (gitignored) 実行時データ
        ├── memory/         記憶エントリJSON（1エントリ1ファイル）
        ├── artifacts/      アーティファクト＋バージョン管理
        ├── index.json      再構築可能なインデックス
        ├── oplog.json      操作ログ（append-only）
        ├── oauth_store.json OAuthクライアント・トークン永続化
        ├── conversations/      ZIPインポートした会話全文（{uuid}.json + _index.json）
        ├── share_tokens.json   シェアトークン（記憶エントリ・会話の共有URL）
        ├── imported_uuids.json ZIPインポート済みUUID管理
        └── .import_status.json 最終ZIPインポート記録
```

---

## Roadmap / TODO

**機能追加（低優先）**
- artifacts削除のUI（test_v31.txt が Artifacts タブに残存中）
- Import タブのレスポンスに `conversations_saved` 件数を表示

**構想・設計フェーズ**
- お友達システム（v0.1仕様・プライバシー設計済み）
- 起動オーバーヘッド計測と軽量化（遅延ロード設計）

**継続タスク（低優先）**
- mio-memory Claude Code直接認証
- Remote Control 設定
- userMemoriesダンプの世代管理対応

---

# claude-with-you (English)

External memory MCP server for Claude. Runs on Synology NAS in Docker. Accessible from Claude.ai and Claude Code via the MCP protocol.

## Features (v3.2)

**Memory tools (5)**
`memory_read_index` · `memory_read` · `memory_write` · `memory_upsert` · `memory_search`

**Memory share (1)**
`memory_share(id)` — generates a 24h share URL for a memory entry (`/admin.html?token=...&id=...`)

**Artifact tools (3)**
`artifacts_save` · `artifacts_read` · `artifacts_list` — versioned file storage with symlink-based latest pointer

**Conversation tools (2)**
`conversation_search(q, limit)` · `conversation_share(uuid)` — search past conversations and generate 24h share URLs pointing to `/logs.html?token=...`

**Import**
`POST /import` — batch-import Claude.ai export ZIPs (deduplication via UUID log)
- `conversations.json` — imports chat list as memory entries AND saves full data to `/data/conversations/`
- `memories.json` — saves userMemories content as `core_memories_YYYYMMDD.md` artifact
- `projects/*.json` — records non-starter projects as memory entries

**Conversation log viewer (`logs.html`)**
Auto-loads conversation list from the server. Renders markdown with marked.js + DOMPurify. Collapsible thinking/tool_use blocks, font size controls, related memory panel. Shareable via `?token=` URL (no login required).

## Architecture

Single-file Flask app (`memory/app/main.py`) running in Docker on a Synology NAS. Three layers in one file: REST API, OAuth 2.1 + Dynamic Client Registration, and MCP Streamable HTTP transport (spec 2025-11-25). Memory entries are individual JSON files; artifacts use a versioned directory with top-level symlinks.

## Quick Start

```bash
# 1. Create .env from sample
cp .env_sample .env
# Edit MIO_API_TOKEN in .env

# 2. Start
docker-compose up -d

# 3. Register in Claude Code (Windows)
claude mcp add --transport http mio-memory https://your-nas-domain/mcp
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MIO_API_TOKEN` | `changeme` | Shared secret for Bearer auth and OAuth login |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | *(empty)* | Comma-separated allowed Origins; empty skips check |
