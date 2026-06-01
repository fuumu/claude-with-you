# claude-with-you

[日本語](#claude-with-you) | [English](#claude-with-you-english)

Claude用の外部記憶MCPサーバー。Synology NAS上のDockerで稼働し、Claude.aiおよびClaude CodeからMCPプロトコルで読み書きできる。

---

## 機能一覧（v3.0）

**記憶操作（5ツール）**
- `memory_read_index` — インデックス一覧取得
- `memory_read` — エントリ取得（ID指定）
- `memory_write` — 新規エントリ書き込み
- `memory_upsert` — 固定IDで上書き（存在しない場合は新規作成）
- `memory_search` — キーワード全文検索

**アーティファクト管理（3ツール）**
- `artifacts_save` — バージョン管理付きファイル保存
- `artifacts_read` — 最新または指定バージョンの読み込み
- `artifacts_list` — 保存済みアーティファクト一覧

**インポート**
- `POST /import` — Claude.ai エクスポートZIPをバッチインポート（重複スキップ）
  - `conversations.json` — チャット一覧（タイトル・日時）を取り込み
  - `memories.json` — userMemoriesの内容を `core_memories_YYYYMMDD.md` としてartifactsに保存
  - `projects/*.json` — スタータープロジェクトを除くプロジェクト情報をエントリとして記録

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
  │  /import       ZIPインポート     │
  │  /oauth/*      OAuth 2.1        │
  └──────────────┬──────────────────┘
                 │ volume mount
  ┌──────────────▼──────────────────┐
  │  memory/data/                   │
  │  ├── memory/*.json  記憶エントリ │
  │  ├── artifacts/     ファイル管理 │
  │  ├── index.json     インデックス │
  │  └── oplog.json     操作ログ    │
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
# {"status": "ok", "version": "3.0", ...}
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

## MCPツール一覧

| ツール名 | 用途 | 主な引数 |
|---------|------|---------|
| `memory_read_index` | インデックス一覧取得 | なし |
| `memory_read` | エントリ取得 | `id` |
| `memory_write` | 新規エントリ作成 | `title`, `body`, `tags`, `importance` |
| `memory_upsert` | 固定IDで上書き | `id`, `title`, `body`, `tags`, `importance` |
| `memory_search` | キーワード検索 | `q` |
| `artifacts_save` | ファイル保存（バージョン管理） | `name`, `content` |
| `artifacts_read` | ファイル読み込み | `name`, `version`（省略時は最新） |
| `artifacts_list` | アーティファクト一覧 | なし |

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

## プロジェクト構成

```
claude-with-you/
├── CLAUDE.md               Claude Code向けアーキテクチャ文書
├── README.md
├── docker-compose.yml
├── .env_sample             環境変数サンプル（これをコピーして .env を作る）
├── .env                    (gitignored) 環境変数
├── docs/
│   ├── design.md           MCPサーバー拡張設計仕様
│   └── setup.md            NAS→GitHub→WSセットアップ手順
└── memory/
    ├── Dockerfile
    ├── app/
    │   ├── main.py         サーバー本体（全機能を1ファイルに集約）
    │   └── requirements.txt
    ├── wheels/             Pythonホイール（ベンダリング済み）
    └── data/               (gitignored) 実行時データ
        ├── memory/         記憶エントリJSON（1エントリ1ファイル）
        ├── artifacts/      アーティファクト＋バージョン管理
        ├── index.json      再構築可能なインデックス
        ├── oplog.json      操作ログ（append-only）
        ├── oauth_store.json OAuthクライアント・トークン永続化
        └── imported_uuids.json ZIPインポート済みUUID管理
```

---

# claude-with-you (English)

External memory MCP server for Claude. Runs on Synology NAS in Docker. Accessible from Claude.ai and Claude Code via the MCP protocol.

## Features (v3.0)

**Memory tools (5)**
`memory_read_index` · `memory_read` · `memory_write` · `memory_upsert` · `memory_search`

**Artifact tools (3)**
`artifacts_save` · `artifacts_read` · `artifacts_list` — versioned file storage with symlink-based latest pointer

**Import**
`POST /import` — batch-import Claude.ai export ZIPs (deduplication via UUID log)
- `conversations.json` — imports chat list (title, timestamp)
- `memories.json` — saves userMemories content as `core_memories_YYYYMMDD.md` artifact
- `projects/*.json` — records non-starter projects as memory entries

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
