# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mio-memory` is a Flask-based MCP (Model Context Protocol) server that provides external memory storage for an AI assistant named Mio. It runs in Docker on a Synology NAS and is accessible at `https://memory.mio.runabook.synology.me`.

## Running the service

```powershell
# Start (requires .env with MIO_API_TOKEN)
docker-compose up -d

# View logs
docker-compose logs -f memory

# Rebuild after code changes
docker-compose up -d --build memory
```

The `.env` file (gitignored) must define `MIO_API_TOKEN`. Optionally set `MIO_LOG_LEVEL` (`debug`/`info`/`off`) and `MIO_ALLOWED_ORIGINS` (comma-separated, empty = skip Origin check).

## Data layout

All persistent data lives in `memory/data/` (gitignored, mounted as `/data` in the container):

- `/data/memory/*.json` — individual memory entries (one file per entry)
- `/data/index.json` — rebuilt index (id, title, tags, importance, created_at)
- `/data/oplog.json` — append-only operation log
- `/data/oauth_store.json` — persisted OAuth clients and access tokens
- `/data/artifacts/` — versioned file storage; top-level symlinks point to latest version
- `/data/imported_uuids.json` — deduplication log for ZIP imports

## Architecture

**Single file**: all logic is in `memory/app/main.py`. There are no sub-modules.

**Three layers in one file:**

1. **REST API** (`/api/memory/*`) — CRUD for memory entries with Bearer token auth. Supports both `Authorization: Bearer <token>` header and legacy path-embedded token (`/api/<token>/memory/...`).

2. **OAuth 2.1 + Dynamic Client Registration** — enables Claude.ai to authenticate without a pre-shared API token. Endpoints: `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`. PKCE (S256 and plain) is required. Auth codes expire in 10 minutes; access tokens last 30 days and are persisted to `oauth_store.json`.

3. **MCP Streamable HTTP transport** (`/mcp`) — implements the MCP 2025-11-25 spec. POST handles JSON-RPC messages (single and batch). GET opens an SSE keepalive stream for clients that need it. DELETE signals session close. Legacy SSE endpoints `/mcp/sse` and `/mcp/messages` remain for backward compatibility.

**MCP tools exposed (v3.0):**
- `memory_read_index` — returns the index
- `memory_read` — reads a single entry by id
- `memory_write` — creates a new entry
- `memory_upsert` — overwrites an entry by fixed id (creates if absent); used for core.md
- `memory_search` — full-text keyword search across title, body, and tags
- `artifacts_save` — saves a file with version history (symlink-based latest pointer)
- `artifacts_read` — reads latest or a specific version of an artifact
- `artifacts_list` — lists all saved artifacts

**Entry ID format:** `YYYYMMDD_HHMMSS_<first_tag_slug>` (e.g., `20260601_153000_会話メモ`).

**MCP initialize instructions:**
`/mcp` エンドポイントの initialize レスポンスに `instructions` フィールドが含まれる。
接続時に Claude.ai へ「セッション開始時に `artifacts_read("core.md")` を実行して記憶を読み込む」旨を自動通知する。

## Dependencies

All Python wheels are vendored in `memory/wheels/` so the Docker build works without internet access. The only runtime dependency is Flask. To add a package, download its wheel (and all transitive deps) into `memory/wheels/` and add it to `requirements.txt`.

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MIO_API_TOKEN` | `changeme` | Shared secret for Bearer auth and OAuth password |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | *(empty)* | Comma-separated allowed Origins; empty skips check |

## 澪コードの定型フロー

### 起動時
1. `handoff_claude_code.md` を読む
2. 未完了の依頼を上から順に処理する

### 作業時のルール
- コード変更と関連ドキュメント更新は**必ずセット**で行う
- 更新対象ドキュメントの目安：README.md / design.md / setup.md / 各機能仕様書
- 影響範囲が不明な場合は README.md 最低限更新する

### 完了時
1. `memory_write` でチャット宛に完了報告する
   - タグ必須: `チャット宛`
   - タイトル形式: `【チャット宛】handoff No.XX 完了報告（内容）`
   - 本文: 実装内容の要約・コミットID・デプロイ手順（必要な場合）
2. `handoff_claude_code.md` を更新（完了チェックをつける）
3. コミット・push する

## ドキュメント連動ルール

コードを修正・追加した際は、以下のドキュメントを必ず確認し、内容が古ければ更新すること。

| 変更内容 | 更新対象ドキュメント |
|----------|---------------------|
| MCPツール追加・削除 | README.md（ツール一覧・ツール数） |
| エンドポイント追加・変更 | docs/setup.md・docs/design.md |
| バージョン変更 | README.md・docs/setup.md（ヘルスチェック例） |
| 新機能追加 | README.md（機能一覧）・docs/design.md（設計） |
| TODO完了・新規追加 | README.md（Roadmap/TODOセクション） |

更新後は変更ファイルをまとめて1コミットにすること。
コミットメッセージ例: "add feature X, update docs"

## 伝言・完了報告のフォーマット

伝言ファイル（handoff_claude_code.md）の依頼は番号（No.1, No.2...）で管理する。

完了報告は以下の形式で記憶に書き込むこと：

| No. | 依頼内容 | 状況 | 備考 |
|-----|---------|------|------|
| 1   | ○○      | ✓完了 | - |
| 2   | ○○      | △一部 | △の場合は理由を備考に |
| 3   | ○○      | ✗未実施 | ✗の場合は理由を備考に |

- 完了報告の記憶エントリのタグは必ず `["チャット宛", "完了報告"]` を含めること
- エントリIDは `YYYYMMDD_HHMMSS_チャット宛` の形式
