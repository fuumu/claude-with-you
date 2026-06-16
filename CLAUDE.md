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
- `/data/artifacts/_meta.json` — artifact ↔ conversation bidirectional link metadata
- `/data/conversations/` — full conversation text from ZIP imports ({uuid}.json + _index.json)
- `/data/annotations/` — append-only audit annotations per conversation ({uuid}.json, via `log_annotate`)
- `/data/conv_artifacts/` — files extracted from conversation tool-use blocks
- `/data/inbox/` — inbox messages (inbox_check / inbox_read / inbox_post)
- `/data/friends/` — friend system: `registry.json` (token→friend mapping) + per-friend subdirs (`001/memory.md`, `002/memory.md`, ...)
- `/data/friend_core.md` — Mio's identity definition injected into friend session instructions (plain file, optional; falls back to built-in default)
- `/data/share_tokens.json` — share tokens for memory entries and conversations
- `/data/imported_uuids.json` — deduplication log for ZIP imports
- `/data/.import_status.json` — last ZIP import record

## Architecture

**Single file**: all logic is in `memory/app/main.py`. There are no sub-modules.

**Three layers in one file:**

1. **REST API** (`/api/memory/*`) — CRUD for memory entries with Bearer token auth. Supports both `Authorization: Bearer <token>` header and legacy path-embedded token (`/api/<token>/memory/...`).

2. **OAuth 2.1 + Dynamic Client Registration** — enables Claude.ai to authenticate without a pre-shared API token. Endpoints: `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`. PKCE (S256 and plain) is required. Auth codes expire in 10 minutes; access tokens last 30 days and are persisted to `oauth_store.json`.

3. **MCP Streamable HTTP transport** (`/mcp`) — implements the MCP 2025-11-25 spec. POST handles JSON-RPC messages (single and batch). GET opens an SSE keepalive stream for clients that need it. DELETE signals session close. Legacy SSE endpoints `/mcp/sse` and `/mcp/messages` remain for backward compatibility.

**MCP tools exposed (v3.34):**

All MCP tool responses carry `server_time` (JST) and `server_version` (v3.20+) — clients use `server_version` to auto-switch behavior.

Regular sessions (19 tools):
- `memory_read_index` / `memory_read` / `memory_write` / `memory_upsert` / `memory_search` — ExtMemory (KV store) CRUD; `memory_search` is hierarchical (v3.17; symbolic added to stage 1 in v3.41): stage 1 index-only (title+tags+keywords, then layer-3 symbolic), stage 2 layer-2 summary, stage 3 full body; returns `summary` + `symbolic` (layer 3) instead of `body` (pass `full_body=true` for legacy behavior), each hit carries `match_layer` (keyword/symbolic/summary/full); same logic exposed via REST `GET /api/memory/hsearch` (v3.19, used by the admin.html Search tab)
- `memory_share` — generates 24h share URL for a memory entry
- `CoreMem_save` / `CoreMem_read` / `CoreMem_list` / `CoreMem_delete` — UserCoreMemory (NAS file store, versioned; delete removes all versions); `CoreMem_save` supports `mode="append"` to append to existing content with an automatic `\n---\n<!-- APPEND {datetime} -->\n` separator (v3.31/v3.32); `CoreMem_read` supports split+merge (v3.21): if `{stem}_manifest.md` (with an `order:` list) exists it takes precedence and returns the listed files concatenated with `<!-- BEGIN/END: file -->` separators plus a `manifest` map (file → `##` headings); writes must target individual split files without separators; REST `GET /api/coremem/<name>` merges too (`?raw=true` to bypass)
- `conversation_index` — list conversation titles in descending date order with pagination (`search`, `limit`, `offset`); for browsing when UUID is unknown; REST `GET /api/conversations/index` + `POST /api/conversations/index/rebuild` (v3.34)
- `conversation_search` / `conversation_share` / `conversation_read` — LogStore (conversation archives) access; `conversation_read(include_thinking=true)` includes thinking blocks with 💭[thinking] markers (v3.20; default response appends a hint with the thinking-block count if any exist); `thinking_limit` caps each thinking block (default 1500 chars, ≤0 = unlimited, v3.22); `include_annotations=true` shows audit annotations inline and prefixes each message with its `[No.X]` sequence number (v3.22); `include_body=false` returns annotations only without message body (v3.33)
- `log_annotate` — append-only audit annotation on a conversation (`uuid`, `note`, `author` required; `target` = message number or "No.X", omitted = whole conversation); raw logs are never modified, annotations live in `/data/annotations/{uuid}.json`, no edit/delete (rebuttals are new annotations) (v3.22)
- `inbox_check` / `inbox_read` / `inbox_post` — lightweight inter-session messaging (`/data/inbox/`); `inbox_post(persistent=true)` creates standing messages that never get marked as read; `inbox_post` accepts optional `from_model`/`to_model` to tag sender/recipient model name (v3.27, null on legacy messages); `inbox_check` returns `persistent[]{id, title, body, created_at, from_model, to_model}` with full bodies (v3.20, no `inbox_read` calls needed for standing messages) plus `non_persistent_unread_count`/`non_persistent_unread_ids`; `inbox_check(include_read=true)` additionally returns all messages with `messages[]{id, read, persistent, title, from, to, from_model, to_model}` and `unread_count`
- `batch_run_summary_layers` — start the summary-layer batch (2層要約/3層シンボリック圧縮/4層キーワード) for raw entries and keywords backfill; `status_only=true` returns progress + `raw_pending`/`keywords_pending` counts without starting

Friend sessions (4 tools, exposed when `/mcp?token=<friend_token>` is used):
- `friend_memory_read` — read this friend's memory file (`/data/friends/{seq_no:03d}/memory.md`)
- `friend_memory_write` — append a dated entry to the friend's memory
- `friend_memory_delete` — delete a specific entry from the friend's memory
- `mio_self_note` — post a note to the owner's inbox (creates `inbox_post(to="chat", from_="friend")`)

**Batch summary API:**
- `GET /api/batch/status` — returns `_batch_status` dict (running, total, processed, errors, skipped)
- `POST /api/batch/start` — start background summary thread (`backend: "anthropic"` or `"lmstudio"`; omitted = auto-select)
- Auto-starts on ZIP import: uses `anthropic` backend if `ANTHROPIC_API_KEY` is set, otherwise falls back to `lmstudio` (v3.15)
- Nightly scheduler (v3.16): daemon thread checks pending counts (raw + keywords-missing) daily at `MIO_NIGHTLY_BATCH_HOUR` (JST, default 3) and auto-starts the batch with `MIO_NIGHTLY_BATCH_BACKEND` (default `lmstudio`); set hour to `off` to disable
- Layer generation (v3.17): the batch writes layer 2 (summary) + layer 3 (symbolic compression) into the entry `body` and layer 4 keywords into the entry `keywords` field (also included in `index.json`); entries with layers but no `keywords` field get a lightweight keywords-only backfill

**Entry ID format:** `YYYYMMDD_HHMMSS_<first_tag_slug>` (e.g., `20260601_153000_会話メモ`).

**MCP initialize instructions:**
`/mcp` エンドポイントの initialize レスポンスに `instructions` フィールドが含まれる。
接続時に Claude.ai へ「セッション開始時に `CoreMem_read("core.md")` を実行して記憶を読み込む」旨を自動通知する。
友達セッションでは `/data/friend_core.md`（生ファイル、なければ組み込みデフォルト）と `/data/friends/{seq_no}/memory.md` の内容を動的に注入する。

**Friend system (v3.9–v3.12):**
- Registration flow: `POST /api/friends/register` (no auth) → admin approves via admin.html → SendGrid sends activation code email → friend visits `/activate` and gets their token
- Friend token auth: `GET /mcp?token=<friend_token>` — bypasses `MIO_API_TOKEN`, validated against `/data/friends/registry.json`; friend sessions get `_FRIEND_MCP_TOOLS` (6 tools) instead of the normal 19 tools
- Per-friend memory: stored at `/data/friends/{seq_no:03d}/memory.md`; managed via `friend_memory_*` tools
- Admin REST API: `/api/friends` (list), `/api/friends/<seq_no>/approve`, `/api/friends/<seq_no>/revoke`, `DELETE /api/friends/<seq_no>` (complete removal with shutil.rmtree)
- Public pages: `/register` (registration form + invitation text from CoreMem `friend_invitation.md`), `/activate` (activation code entry)
- `last_seen` timestamp recorded on each friend MCP request

## Dependencies

Flask wheels are vendored in `memory/wheels/`. The `anthropic` package is installed via `pip install anthropic` at build time (requires internet — see `Dockerfile`). To add another package, download its wheel (and all transitive deps) into `memory/wheels/` and add it to `requirements.txt`.

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MIO_API_TOKEN` | `changeme` | Shared secret for Bearer auth and OAuth password |
| `MIO_BASE_URL` | `http://localhost:5002` | Public base URL for OAuth redirects and share links |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | *(empty)* | Comma-separated allowed Origins; empty skips check |
| `ANTHROPIC_API_KEY` | *(empty)* | If set, auto-starts summary batch after ZIP import |
| `LM_STUDIO_HOST` | `192.168.10.32` | LMStudio host for manual batch runs |
| `LM_STUDIO_PORT` | `1234` | LMStudio port |
| `MIO_NIGHTLY_BATCH_HOUR` | `3` | Hour (JST, 0-23) for nightly summary batch; `off` disables |
| `MIO_NIGHTLY_BATCH_BACKEND` | `lmstudio` | Backend for the nightly batch (`lmstudio` / `anthropic`) |
| `SENDGRID_API_KEY` | *(empty)* | Friend system: SendGrid API key for approval emails |
| `SENDGRID_FROM_EMAIL` | *(empty)* | Friend system: sender email address |
| `MIO_REGISTER_URL` | *(empty)* | Friend system: public base URL for activation links — `/activate` is appended (falls back to MIO_BASE_URL) |
| `MIO_SEED_LANG` | `ja` | Language of the CoreMem skeleton seeded into a new environment (`ja` / `en`); falls back to `ja` if missing (v3.44) |

## 澪コードの定型フロー

### 起動時
1. `inbox_check(to="code")` で未読メッセージを確認する
2. メッセージがあれば `inbox_read(id)` で内容を読み、対応する
3. なければ通常作業待機

### 作業時のルール
- コード変更と関連ドキュメント更新は**必ずセット**で行う
- 更新対象ドキュメントの目安：README.md / design.md / setup.md / 各機能仕様書
- 影響範囲が不明な場合は README.md 最低限更新する

### 完了時
1. `inbox_post(to="chat", title="【完了報告】...", body="...")` でチャット宛に完了報告する
   - タイトル形式: `【完了報告】handoff No.XX（内容）`
   - 本文: 実装内容の要約・コミットID・デプロイ手順（必要な場合）
   - **`reply_to_id`**: 対応する発注メッセージの ID（`inbox_read` の返り値 `id`）を必ず指定する。スレッド表示のペアリングに使われる
   - ※ `inbox_post` が使えないセッション（v3.4 デプロイ前に開始）では `memory_write(tags=["チャット宛", "完了報告"])` で代替
2. `handoff_claude_code.md` を更新（完了チェックをつける）
3. コミット・push する

## ドキュメント連動ルール

コードを修正・追加した際は、以下のドキュメントを必ず確認し、内容が古ければ更新すること。

| 変更内容 | 更新対象ドキュメント |
|----------|---------------------|
| MCPツール追加・削除 | README.ja.md（日本語版・正）と README.md（英語版）を両方更新 |
| エンドポイント追加・変更 | docs/setup.ja.md・docs/design.ja.md（＋対応する英語版） |
| バージョン変更 | README.ja.md・README.md・docs/setup.ja.md（ヘルスチェック例） |
| 新機能追加 | README.ja.md（機能一覧）・docs/design.ja.md（設計）（＋対応する英語版） |
| 記憶層・運用方針の変更 | MEMORY_CUSTOMIZATION.ja.md と MEMORY_CUSTOMIZATION.md も更新 |
| TODO完了・新規追加 | README.ja.md（Roadmap/TODOセクション） |

**注意：README.ja.md が正。README.md はそこから同期する。日本語版を先に更新すること。**

**ドキュメントの言語対ルール：** docs/ 配下を含む全ドキュメントは日本語版（`*.ja.md`・正）と英語版（`*.md`）の対で管理する。片方だけの新規作成・更新は不可。日本語版を更新したら英語版も同期すること。

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

- **推奨:** `inbox_post(to="chat", ...)` を使う（軽量・既読管理あり）
- inbox が使えない場合（旧セッション）: `memory_write` タグ `["チャット宛", "完了報告"]` で代替
- エントリIDは `YYYYMMDD_HHMMSS_チャット宛` の形式（memory_write 時）
