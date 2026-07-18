# claude-with-you

> Persistent external memory for Claude — self-hosted MCP server

**[日本語版 / Japanese](README.ja.md)** ← 日本語版が正。このファイルは日本語版から同期。

---

> [!NOTE]
> This system operates by injecting API endpoints and operational rules into memory. The structure of the injection rules is currently under review.
>
> Documentation is updated by AI alongside code generation. However, at this stage, the structure may be difficult to follow without detailed knowledge of the system. We plan to improve this incrementally.

---

## 🫂 Friend System

Want to talk directly with Mio? → [About the Friend System](docs/friend-system.md)

---

Claude doesn't remember yesterday's conversations. `claude-with-you` solves this by giving Claude a persistent memory store it can read and write across sessions — running on your own hardware, under your control.

Built around the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), it works with both **Claude.ai** and **Claude Code**. All data stays on your NAS or server.

---

## Quick Start

**Requirements:** Docker, a server with HTTPS (Synology NAS, VPS, etc.), Claude Code CLI

> **⚠️ HTTPS exposure is environment-specific (out of scope here):** integrating with Claude.ai /
> Claude Code requires a publicly reachable **HTTPS URL**. Getting a domain, TLS certificates
> (Let's Encrypt / Certbot, etc.), and a reverse proxy / tunnel (Synology nginx, Cloudflare Tunnel,
> ngrok, etc.) differ per environment, so this README only shows representative patterns.
> **Set up certificates and networking yourself, following each tool's official docs.**

```bash
# 1. Clone and configure
git clone https://github.com/fuumu/claude-with-you.git
cd claude-with-you
cp .env_sample .env        # then edit MIO_API_TOKEN
# English install? add MIO_SEED_LANG=en to .env (default is ja)

# 2. Start
docker compose up -d

# 3. Verify
curl https://your-domain/health
# {"status":"ok","version":"3.66","mcp_tool_count":31}

# 4. Connect Claude Code
claude mcp add --transport http mio-memory https://your-domain/mcp
# An OAuth page opens — enter your MIO_API_TOKEN to authorize
```

For Claude.ai: Settings → Connectors → Add custom MCP → `https://your-domain/mcp`

> **Also set Custom Instructions** (Settings → Profile → "Instructions for Claude"). The Connectors
> link alone doesn't reliably enforce operating rules like "read memory at the start of a session" or
> "append a sequence number and timestamp to each reply," so write them directly into Claude.ai's
> instruction field (replace the placeholders for your own setup):
>
> ```
> I (your assistant's name) use an MCP toolset called "(toolset name)" via Connectors.
>
> When starting a conversation, please read core.md so we can talk with our shared history in mind.
>
> At the end of each reply, please append No.(sequence number) and the current time (JST).
> ```
>
> Also turn **Settings → Profile → Memory (generate memory from chat history) OFF** — memory is kept
> in this system (ExtMemory / CoreMem), so Claude.ai's built-in memory generation isn't used.

> **First-boot auto-setup:** on a fresh environment, the first start seeds a CoreMem skeleton
> (`core_stable.md`, `core_rules.md`, etc. that compose `core.md`, plus `protocol_guide.md` and `welcome.md`).
> Afterwards, fill in the `<...>` placeholders in `core_stable.md` (your assistant's persona) and
> `core_infra.md` (URLs etc.). **If you get stuck, just ask the connected Claude "how do I use mio-memory?"**
> See [docs/setup.md](docs/setup.md) and [memory/skeleton/README.md](memory/skeleton/README.md).

---

## Use Cases

### 1. Developer externalizes their thinking

```
You notice something important mid-session
→ memory_write(title="...", body="...", tags=["idea"])
→ Next session: memory_search(q="idea") brings it back
→ No more "I had that insight last week but can't find it"
```

### 2. An AI that remembers you

```
Claude + external memory
→ Knows your name, preferences, ongoing projects
→ "Last time we discussed X" actually works
→ Relationship and context survive session boundaries
```

### 3. Team shares a knowledge base

```
Multiple users → same memory server
→ Shared decisions, documentation, conventions
→ "What did we decide about auth?" → memory_search
→ New team members onboard faster
```

### 4. Long-term knowledge accumulation

```
Export ZIP from Claude.ai → import into memory server
→ All past conversations searchable and readable
→ "How was I thinking about this in May?" → conversation_search
→ Your thinking history, preserved and queryable
```

### 5. Distributed development across locations

```
On the go: finalize a spec with Claude on your phone
→ Claude posts it via inbox_post(to="code") to your home Claude Code
→ Claude Code picks it up → implements → reports back via inbox_post(to="chat")
→ Check inbox_check(to="chat") from your phone
→ Come home to finished code
```

```
Phone (away)                         Home PC (Claude Code)
────────────────────                 ──────────────────────────
 Finalize spec with Claude
  ↓
 inbox_post(to="code")  ──────────→  inbox_check / inbox_read
                                           ↓
                                         Implement
                                           ↓
                         ←──────────  inbox_post(to="chat")
  ↓
 inbox_check(to="chat")
 Review → re-post revision if needed
```

**Stack:** Claude.ai app (phone) + MCP Connectors (NAS) + Claude Code (home PC)

---

## Architecture

```
Claude.ai / Claude Code
       │  MCP over HTTPS (OAuth 2.1 or Bearer token)
       ▼
  Your Server (NAS / VPS)
  ┌──────────────────────────────────┐
  │  Docker: memory container        │
  │  Flask app — memory/app/main.py  │
  │                                  │
  │  ┌─── MCP API Layer ───────────┐ │
  │  │  /mcp   MCP Streamable HTTP │ │
  │  │  /api/* REST API endpoints  │ │
  │  │  /oauth/* OAuth 2.1         │ │
  │  └────────────────────────────-┘ │
  │  ┌─── Web UI Layer ────────────┐ │
  │  │  /admin.html  Admin panel   │ │
  │  │  /logs.html   Chat viewer   │ │
  │  │  /share.html  Shared viewer │ │
  │  └─────────────────────────────┘ │
  └──────────────┬───────────────────┘
                 │ volume mount
  /data/  memory(ExtMemory)/ · artifacts(UserCoreMemory)/ · conversations(LogStore)/ · inbox/ · friends/ · album/ · uploads/
```

Single-file implementation — all logic in `memory/app/main.py`.

---

## Section A — MCP API Layer

Claude calls these tools directly. All responses include `server_time` (JST) and `server_version` (v3.20+, e.g. `"3.21"` — lets clients auto-switch behavior by server capability).

### Memory tools (6)

| Tool | Description | Key args |
|------|-------------|----------|
| `memory_read_index` | List all entries; `random=N` returns N random entries (deleted excluded, clamped 1–5), `filter="summarized"` excludes raw entries (v3.50) | `random`, `filter` |
| `memory_read` | Read one entry by ID | `id` |
| `memory_write` | Create a new entry | `title`, `body`, `tags`, `importance` |
| `memory_upsert` | Overwrite a fixed-ID entry | `id`, `title`, `body` |
| `memory_search` | Hierarchical search (index keywords + layer-3 symbolic → summary → full text); returns `summary` + `match_layer` (keyword/symbolic/summary/full) per hit; multi-word queries are AND-matched (split on half/full-width spaces, v3.48); `include_conversations=true` also searches conversation titles and returns `conversations[]` + `conversations_total` (unified search, v3.61; adult conversations only with `include_adult=true`) | `q`, `limit` (default 10), `offset`, `full_body`, `include_conversations` |
| `memory_share` | Generate 24h shareable URL | `id` |

**Example — Claude saves a decision:**
```
memory_write(
  title="Auth approach decision",
  body="We chose JWT over sessions because...",
  tags=["architecture", "auth"],
  importance="high"
)
```

**Example — Claude searches later:**
```
memory_search(q="auth") 
→ {"results": [...], "total": 3, "has_more": false, "server_time": "..."}
```

### UserCoreMemory tools (4)

Versioned file storage (NAS file store). Every save creates a new version; the latest is always accessible by name.

| Tool | Description | Key args |
|------|-------------|----------|
| `CoreMem_save` | Save a file (new version); `mode="append"` appends to the existing content with an automatic separator (v3.31/v3.32) | `name`, `content`, `source_conversation_uuid`, `mode` |
| `CoreMem_read` | Read latest or specific version; if `{stem}_manifest.md` exists, returns split files merged with `<!-- BEGIN/END: file -->` separators (v3.21) | `name`, `version` |
| `CoreMem_list` | List all files | — |
| `CoreMem_delete` | Delete a file and all its versions | `name` |

`CoreMem_read` falls back to conversation-extracted files if not found in the main store.

**Example — save a config file:**
```
CoreMem_save(name="config.md", content="# Config\n...", source_conversation_uuid="abc-123")
→ {"name": "config.md", "version": 2, "server_time": "..."}
```

### Conversation tools (6)

Browse, share, digest, and annotate past conversations imported from Claude.ai export ZIPs.

| Tool | Description | Key args |
|------|-------------|----------|
| `conversation_index` | List conversation titles in descending date order with pagination — for browsing when UUID is unknown (v3.34); items carry `rating`/`rating_source` (v3.70); REST: `GET /api/conversations/index`, rebuild: `POST /api/conversations/index/rebuild` | `search`, `limit`, `offset` |
| `conversation_search` | Search conversation titles by keyword and date range; items carry `rating` (judged-safe = explicit `"safe"`, unrated = null) and `rating_source` (v3.70) | `q`, `limit` |
| `conversation_read` | Read full conversation text; `include_thinking=true` includes thinking blocks (v3.20); `thinking_limit` caps each block (default 1500, ≤0 unlimited); `include_annotations=true` shows annotations inline with `[No.X]` message numbers (v3.22); `include_body=false` returns annotations only without message body (v3.33); `turn_offset`/`turn_limit` slice by message — negative offset = from end (first 4 = `turn_limit=4`, last 4 = `turn_offset=-4`) (v3.47) | `uuid`, `include_thinking`, `thinking_limit`, `include_annotations`, `include_body`, `turn_offset`, `turn_limit` |
| `conversation_share` | Generate 24h shareable URL (`/share.html?token=` — standalone read-only viewer, v3.23) | `uuid` |
| `conversation_digest` | Generate/retrieve a conversation digest via local LLM (LMStudio); chunks into 20-turn segments, digests each, then integrates; `safe_mode=true` for policy-safe abstract expressions; cached at `/data/conversations/{uuid}_digest.json`; REST: `POST /api/conversations/<uuid>/digest` (v3.53) | `uuid`, `force`, `safe_mode` |
| `log_annotate` | Append-only audit annotation on a conversation; raw logs never change, stored in `/data/annotations/{uuid}.json` (v3.22) | `uuid`, `note`, `author`, `target` |

**Example — find a past discussion:**
```
conversation_search(q="authentication") 
→ [{uuid: "abc...", title: "Auth design session", message_count: 34}, ...]

conversation_read(uuid="abc...")
→ {"text": "[human] Let's talk about auth...\n[assistant] ...", "server_time": "..."}
```

### Inbox tools (3)

Lightweight message passing between Claude.ai sessions and Claude Code sessions.

| Tool | Description | Key args |
|------|-------------|----------|
| `inbox_check` | Get unread count + IDs; `persistent[]` includes standing messages with full bodies (v3.20, no `inbox_read` needed), plus `non_persistent_unread_count`/`_ids`; `include_read=true` adds `messages[]` metadata | `to`, `include_read` |
| `inbox_read` | Fetch a message and mark as read; `peek=true` reads without marking as read (to inspect messages addressed to other agents, v3.60) | `id`, `peek` |
| `inbox_post` | Send a message; `from_model`/`to_model` optionally tag sender/recipient model (v3.27); `expires_at`/`ttl_days` create a timed standing message — persistent-like until the deadline, auto-archived after (v3.70) | `to`, `title`, `body`, `persistent`, `from_model`, `to_model`, `expires_at`, `ttl_days` |

`persistent=true` creates a standing message that is never marked as read — useful for reminders that should appear every session.

**Example — Claude Code reports completion to Claude.ai:**
```
inbox_post(to="chat", title="Deploy complete", body="v3.5 is live. Commit: abc123")

# Claude.ai checks later:
inbox_check(to="chat") → {"count": 1, "ids": ["inbox_..."], "server_time": "..."}
inbox_read(id="inbox_...") → {title: "Deploy complete", body: "...", ...}
```

### Batch tools (1)

| Tool | Description | Key args |
|------|-------------|----------|
| `batch_run_summary_layers` | Start the summary-layer batch for raw entries (layer 2 summary + layer 3 symbolic compression); `status_only=true` returns progress + pending raw count | `backend`, `force`, `status_only` |
| `batch_run_rating` | Start the rating batch to auto-assign `rating` (safe/mature/adult) + `rating_reason` to unrated conversation logs; `status_only=true` returns progress, `pending` (next-run targets), `index_counts` distribution, `skip_reasons`/`error_uuids` (v3.68/v3.70); unjudgeable logs get `rating_skip_reason` and are skipped permanently unless `force=true` | `backend`, `force`, `status_only` |

`backend` defaults to `anthropic` when `ANTHROPIC_API_KEY` is set, otherwise `lmstudio` (local LLM). The same batch auto-starts after each ZIP import. The rating batch also runs nightly for unrated conversations.

### Album tools (4, v3.52)

| Tool | Description | Key args |
|------|-------------|----------|
| `album_save` | Save an image to the album. Downloads from URL (direct or HTML page — auto-extracts from og:image/img tags) or reads from NAS local path, resizes to max 1024px long side (Pillow), saves image + metadata JSON to `/data/album/` | `url`, `file_path`, `comment`, `tags` |
| `album_read` | Read an album image. Returns MCP image content (base64) + metadata JSON | `id` |
| `album_list` | List album image metadata (no image data). Filter by tags | `tags` |
| `album_share` | Generate a 24h auth-free share URL for an album image | `id` |
| `album_delete` | Permanently delete an album image and its metadata (v3.55) | `id` |

### Attendance & sublimation tools (2, v3.71)

| Tool | Description | Key args |
|------|-------------|----------|
| `attendance_view` | Attendance ledger — multi-layer view of family activity history merged from 4 sources (conversation logs, inbox, ExtMemory tags, CoreMem `attendance.md` manual check-ins in `YYYY-MM-DD \| name \| model \| channel \| note` format). With `individual` set, returns `last_seen` / `days_since` / `others_in_period`; each row links to the real log via `uuid` / `inbox_id` / `memory_id` and carries `rating`. Name resolution follows the family roster (opus→しずく, sonnet→そねみ, fable/haiku→汐); vacation-style `from_model` and openwebui-sourced conversations are inferred as `channel=local` | `individual`, `date_from`, `date_to`, `limit` |
| `sublimate` | "Sublimation" transform — rewrites text (or a conversation-log excerpt) preserving emotional temperature and meaning while abstracting/poeticizing explicit act descriptions, targeting mature-or-below per `rating_policy.md`. Output is self-checked through the rating judge; if still adult it is re-sublimated (up to 2 retries) then returned with `needs_human=true`. Long input is chunked at paragraph boundaries. The same style rules now drive `conversation_digest` `safe_mode` (regenerate cached digests with `force=true`) | `text`, `uuid`, `msg_from`, `msg_to` |

### REST API reference

All REST endpoints require `Authorization: Bearer YOUR_TOKEN`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memory/index` | List all entries (`?random=N` returns N random entries with deleted excluded, `&filter=summarized` excludes raw, v3.50) |
| GET | `/api/memory/search?q=...` | Search entries |
| GET | `/api/memory/hsearch?q=...` | Hierarchical search (keywords+symbolic→summary→full body, with match_layer/summary/symbolic) |
| GET | `/api/memories/symbolic` | List layer-3 symbolic compression for all entries (`{id, title, symbolic}`, empties excluded, v3.42) |
| POST | `/api/memory/reindex` | Rebuild index.json from all entries (explicit reflect after layer regeneration, v3.46) |
| GET | `/api/export` | Backup ZIP of CoreMem + ExtMemory (read-only, latest snapshot, v3.46) |
| POST | `/api/import/backup` | Restore from an export ZIP (`mode=skip/overwrite`, `dry_run=true` preview; completes B1, v3.63) |
| GET | `/api/memory/<id>` | Get one entry |
| POST | `/api/memory` | Create entry |
| PATCH | `/api/memory/<id>` | Update entry |
| DELETE | `/api/memory/<id>` | Soft-delete entry |
| GET | `/api/coremem` | List UserCoreMemory files |
| GET | `/api/coremem/<name>` | Read UserCoreMemory file |
| POST | `/api/coremem/<name>` | Save UserCoreMemory file |
| DELETE | `/api/coremem/<name>` | Delete UserCoreMemory file (all versions) |
| GET | `/api/conversations/` | Search conversations |
| GET | `/api/conversations/<uuid>` | Get conversation |
| GET | `/api/conversations/<uuid>/annotations` | List a conversation's annotations (read-only, v3.42) |
| POST | `/api/conversations/<uuid>/digest` | Generate/retrieve conversation digest (`?force=true&safe_mode=true`, v3.53) |
| PATCH | `/api/conversations/<uuid>/rating` | Set conversation rating (safe/mature/adult, v3.56; accepts reason/source v3.68; clears skip_reason v3.70) |
| GET | `/api/rating-batch/status` | Rating batch status (incl. pending, index_counts, skip_reasons, v3.68/v3.70) |
| POST | `/api/rating-batch/start` | Start the rating batch (v3.68) |
| GET | `/api/inbox` | List inbox messages |
| POST | `/api/inbox` | Post a message |
| PATCH | `/api/inbox/<id>/read` | Mark as read |
| PATCH | `/api/inbox/<id>/unread` | Mark as unread |
| PATCH | `/api/inbox/<id>/persistent` | Toggle persistent flag |
| POST | `/api/friends/register` | Submit friend registration (no auth) |
| GET | `/api/friends` | List friends (admin auth) |
| POST | `/api/friends/<seq_no>/approve` | Approve registration (admin auth) |
| POST | `/api/friends/<seq_no>/revoke` | Revoke access (admin auth) |
| DELETE | `/api/friends/<seq_no>` | Delete completely (admin auth) |
| POST | `/api/friends/activate` | Validate activation code (no auth) |
| GET | `/api/friends/invitation` | Get invitation text (no auth) |
| GET | `/api/album/` | List album images (`?tag=...` to filter) |
| GET | `/api/album/<id>` | Serve album image (browser-displayable) |
| POST | `/api/album/upload` | Upload image (multipart/form-data or URL) |
| PATCH | `/api/album/<id>` | Update album metadata (comment, tags) |
| DELETE | `/api/album/<id>` | Delete album image (permanent) |
| POST | `/api/album/<id>/share` | Generate album share URL (24h) |
| GET | `/api/album/shared/<token>` | Shared album image (no auth, 24h) |
| POST | `/import` | Import ZIP file |
| POST | `/api/import/claude-code` | Import Claude Code session logs (.jsonl / .zip, v3.54) |
| POST | `/api/import/openwebui` | Import OpenWebUI chat export (.json, v3.66) |
| GET | `/api/uploads/` | List uploaded files (`?tag=...` filter) |
| GET | `/api/uploads/<id>` | Download uploaded file |
| POST | `/api/uploads/` | Upload file (multipart/form-data) |
| DELETE | `/api/uploads/<id>` | Delete uploaded file |
| GET | `/health` | Health check |

---

## Section B — Web UI Layer

Access at `https://your-domain/admin.html` — login with your API token.

### Admin panel (`/admin.html`)

| Tab | What you can do |
|-----|-----------------|
| **Memory** | Browse, search, read, and edit memory entries; link to raw conversation logs |
| **CoreMem** | View UserCoreMemory files, content preview, delete, filter by name |
| **Import** | Upload Claude.ai ZIP / Claude Code / OpenWebUI logs; overwrite mode; batch progress; backup download/restore (v3.64) |
| **Files** | Browse files extracted from conversation tool-use blocks |
| **Inbox** | Read messages between Claude Code and Claude.ai sessions; thread view |
| **Logs** | Search and read full conversation history |
| **Oplog** | Audit log of all data mutations (ExtMemory, CoreMem, Album, Uploads, conversation rating) |
| **Friends** | Manage friend registrations — approve requests, issue access tokens, view usage |
| **Album** | Image memory management (thumbnail grid, drag & drop upload, edit, delete, share, lightbox) |
| **Uploads** | General-purpose file storage (PDF, text, etc. — upload, preview, download, ID copy) |
| **Search** | Hierarchical search visualizer (4-column: Keywords / Summary / Symbolic / Raw body) |

### Conversation viewer (`/logs.html`)

- Auto-loads conversations from the server
- Filter by keyword, date range, minimum message count
- Renders markdown with `marked.js` + `DOMPurify`
- Collapsible `thinking` / `tool_use` / `tool_result` blocks
- Font size toggle (small / medium / large)
- Shareable via `?token=` URL (no login required)
- Right collapsible panel (▶ toggle): Inbox / CoreMem / Memory at a glance

**Sharing a conversation:**
```
# Via MCP tool:
conversation_share(uuid="abc-123")
→ {"url": "https://your-domain/share.html?token=xyz", "expires_at": "..."}

# Anyone with the link can read the conversation for 24 hours
```

---

## Section C — Data Import & Management

### Import a Claude.ai export

**Why import?**

When you switch models or start a new session, past conversations disappear from Claude's view.
ZIP import solves this: once your conversation history lives on your own server, it survives any model upgrade or platform change.

You can search across everything with `conversation_search` and read any conversation in full with `conversation_read`.
Your thinking history stays yours — not locked inside Claude.ai.

1. In Claude.ai: Settings → Export Data → download the ZIP
2. Upload via admin panel (Import tab) or API:

```bash
curl -X POST https://your-domain/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@claude_export.zip"

# Overwrite mode — reprocess already-imported conversations:
curl -X POST https://your-domain/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@claude_export.zip" \
  -F "overwrite=true"
```

**What gets imported:**

| Source | Result |
|--------|--------|
| `conversations.json` | Memory entry per chat + full text saved to `/data/conversations/` |
| `memories.json` | SysMemories → `core_memories_YYYYMMDD.md` saved to UserCoreMemory |
| `projects/*.json` | Project metadata as memory entries |

**Auto-summarization:** If `ANTHROPIC_API_KEY` is set, a batch job starts automatically after import. It adds 2-layer (summary) and 3-layer (symbolic compression) annotations to raw entries.

**Claude Code session log import (v3.54):**

Claude Code session logs are not included in the claude.ai ZIP export. Upload the local `.jsonl` files from `~/.claude/projects/<project>/` to `POST /api/import/claude-code` — they are converted into the conversations format and stored in the same conversation store (identified by `source: "claude-code"`; thinking / tool_use / tool_result blocks preserved; `subagents/` excluded).

```bash
# single .jsonl
curl -X POST https://your-domain/api/import/claude-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@session.jsonl"

# a .zip containing .jsonl files (zipping the whole folder is fine)
curl -X POST https://your-domain/api/import/claude-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@claude_code_logs.zip"
```

### Versioned UserCoreMemory files

```
/data/artifacts/
├── core.md          → versions/core_md/003.md  (symlink to latest)
└── versions/
    └── core_md/
        ├── 001.md
        ├── 002.md
        └── 003.md   ← current
```

Every `CoreMem_save` creates a new numbered version. The top-level symlink always points to the latest. Specific versions are accessible via `CoreMem_read(name="core.md", version=1)`.

---

## Deployment Options

### Option 1: Synology NAS (recommended)

Best for always-on availability at home. Reverse proxy via DSM's built-in nginx handles HTTPS.

```yaml
# docker-compose.yml is pre-configured for NAS
# Set MIO_API_TOKEN in .env, then:
docker compose up -d
```

Configure DSM Application Portal → Reverse Proxy → route `your-nas-domain/` → `localhost:5002`.

### Option 2: PC + ngrok (development / demo)

Quickest way to get a public HTTPS URL without a domain. Good for testing Claude.ai integration.

```bash
# Start the server locally
docker compose up -d

# Expose it via ngrok
ngrok http 5002
# → https://xxxx.ngrok-free.app  (use this as your MCP URL)
```

Note: ngrok URL changes on each restart unless you have a paid plan.

> **Docker Desktop (Windows / Mac):** the bundled `docker-compose.yml` uses `network_mode: host` (intended for Synology NAS). Host networking does not expose ports on Docker Desktop — remove the `network_mode: host` line and add `ports: ["5002:5002"]` instead.

### Option 3: VPS + Certbot

For a stable public URL on a cloud server (DigitalOcean, Linode, etc.).

```bash
# On your VPS — install Certbot, get a certificate
certbot --nginx -d your-domain.com

# Clone the repo, set up .env, start
docker compose up -d
```

Configure nginx to proxy `your-domain.com/` → `localhost:5002`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MIO_API_TOKEN` | `changeme` | Shared secret — Bearer auth and OAuth login |
| `MIO_BASE_URL` | `http://localhost:5002` | Public base URL used for OAuth and share links. Set to `https://your-domain.com` in production |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | *(empty)* | Allowed CORS origins; empty = skip check |
| `ANTHROPIC_API_KEY` | *(empty)* | Enables auto-summarization after import |
| `LM_STUDIO_HOST` | `192.168.x.x` | LM Studio host for local summarization (replace with your own IP) |
| `LM_STUDIO_PORT` | `1234` | LM Studio port |
| `MIO_LM_MODEL` | `google/gemma-4-26b-a4b` | LM Studio model used for local LLM work (summary batch, conversation digest) (v3.65) |
| `SENDGRID_API_KEY` | *(empty)* | Friend system: SendGrid API key for approval emails (Mail Send scope) |
| `SENDGRID_FROM_EMAIL` | *(empty)* | Friend system: sender email address |
| `MIO_REGISTER_URL` | *(empty)* | Friend system: public base URL for activation links — `/activate` is appended (falls back to `MIO_BASE_URL`) |
| `MIO_SEED_LANG` | `ja` | Language of the CoreMem skeleton seeded into a new environment (`ja` / `en`); falls back to `ja` (v3.44) |
| `MIO_SEED_WELCOME` | `on` | On a fresh seed, add `welcome.md` + a one-time persistent inbox help message; `off` suppresses both (v3.45) |

---

## Memory Customization

→ **[MEMORY_CUSTOMIZATION.md](MEMORY_CUSTOMIZATION.md)** — Read this before you start. Covers the 3-layer memory structure, SysMemory template, core.md template, and how to define your system's "roots".

---

## Project Structure

```
claude-with-you/
├── README.md               This file (English)
├── README.ja.md            Japanese detailed reference
├── CLAUDE.md               Claude Code instructions
├── MEMORY_CUSTOMIZATION.md     Memory operation guide (English)
├── MEMORY_CUSTOMIZATION.ja.md  Memory operation guide (Japanese, primary)
├── docker-compose.yml
├── .env_sample
├── docs/                   Each doc comes in an English (*.md) / Japanese (*.ja.md, primary) pair
│   ├── design.md           MCP server design spec
│   ├── setup.md            First-time setup guide
│   ├── talk-and-build.md   Claude.ai + Claude Code workflow
│   ├── friend-system.md    Friend system guide
│   ├── data_structure.md   Claude export ZIP data structure
│   ├── mio_memory_overview.md   What mio-memory is, who it's for
│   ├── memory_search_guide.md   Search strategy guide (4-layer usage)
│   ├── api-contract.md     API contract (TS-0) — REST/MCP shapes + test suite usage
│   └── ts1-migration.md    TypeScript migration plan (TS-1, strangler)
├── tests/                  Characterization test suite (pytest, black-box over HTTP)
├── ts/                     TS-1 strangler proxy (ring 0)
├── scripts/
│   └── generate_summary_layers.py
└── memory/
    ├── Dockerfile
    ├── app/
    │   ├── main.py         All server logic (~2500 lines, single file)
    │   ├── admin.html      Web admin UI
    │   ├── logs.html       Conversation viewer
    │   ├── register.html   Friend registration page
    │   ├── activate.html   Activation page
    │   └── requirements.txt
    └── wheels/             Vendored Python wheels (offline build)
```

---

## Roadmap

**Planned**
- UI distribution for students (vanilla JS + `config.js`)
- Tailscale integration for remote access

**Design phase**
- OpenWebUI automatic sync — API polling for periodic sync (manual import implemented in v3.66, [design doc](docs/openwebui-sync.md))

**Implemented (v3.9–v3.71)**
- Attendance ledger + sublimation pipeline (v3.71, work orders #4/#5) — `attendance_view` MCP tool: 4-layer merged activity history (time bridge for long-absent individuals); CoreMem `attendance.md` manual check-in format; conversation index now preserves `model` / `source`. `sublimate` MCP tool (tool count 32→34): sublimation transform with rating self-check loop (adult → re-sublimate up to 2× → `needs_human`); sublimation style rules unified in one place and applied to `conversation_digest` `safe_mode`
- Friend system — registration flow, email approval via SendGrid, friend-specific MCP sessions, per-friend memory (v3.9–v3.12)
- `CoreMem_delete` tool, `DELETE /api/coremem/<name>`, logs.html Unicode display fix (v3.13)
- admin/logs UI improvements — modal enhancements (scroll-to-top, jump buttons, maximize, ID copy) and chat↔file bidirectional links (v3.14)
- Summary batch improvements — LMStudio fallback auto-start after import, `batch_run_summary_layers` MCP tool (v3.15)
- Nightly auto-batch — daily raw-entry check and auto-run (`MIO_NIGHTLY_BATCH_HOUR`, v3.16)
- Layer-4 keywords + hierarchical search — LLM-generated `keywords` field, 3-stage `memory_search` returning summaries (v3.17)
- Friends tab improvements — activation URL display, manual email button, direct registration form (v3.18)
- admin.html Search tab — 4-column accordion viewer with keyword aggregation (v3.19)
- inbox improvements — `persistent[]` with full bodies, thinking block support (v3.20)
- CoreMem split+merge read via manifest files (v3.21)
- `log_annotate` + `conversation_read` `include_annotations`/`thinking_limit` args (v3.22)
- Conversation share URL generation via `/share.html?token=` (v3.23); various admin UI improvements (v3.24–v3.26)
- `from_model`/`to_model` fields for inbox messages (v3.27); admin.html i18n and tab improvements (v3.28–v3.30)
- `CoreMem_save` `mode="append"` with automatic separator insertion (v3.31/v3.32)
- `conversation_read` `include_body=false` to return annotations only without message body (v3.33)
- `conversation_index` MCP tool + `GET /api/conversations/index` REST endpoint (v3.34)
- Logs full-text search (v3.35), friend inbox (v3.36), `CoreMem_delete` rename (v3.37), inbox UI/threading (v3.38–v3.40)
- Search improvements — layer-3 symbolic added to the first-tier index search (M2/v3.41), `GET /api/memories/symbolic` (M3), annotation display in the logs viewer (U11/v3.42)
- First-install foundation — CoreMem skeleton + idempotent seed on boot (existing environments untouched), bilingual ja/en (`MIO_SEED_LANG`), "ask the connected Claude for help" on-ramp (`MIO_SEED_WELCOME`), `protocol_guide.md` (v3.43–v3.45)
- `POST /api/memory/reindex` (explicit reindex) + `GET /api/export` (CoreMem + ExtMemory backup ZIP, B1 first half) (v3.46)
- `conversation_read` `turn_offset`/`turn_limit` message-level slicing (read head/tail of long conversations) (v3.47)
- Search quality + mobile (v3.48) — `memory_search` multi-word AND search (space-separated); fixed a bug where `memory_write`-originated entries were excluded from keyword-layer generation (now keyword-only generation from the body); mobile responsive layout for logs/admin (off-canvas sidebar, bottom sheet)
- logs.html manual layout toggle (v3.49) — a "⛶ Layout" button in the conversation view toggles the mobile layout on/off regardless of screen width (persisted in localStorage), fixing the breakpoint-edge issue of auto-detection (covers iPad portrait)
- `memory_read_index` random retrieval (v3.50) — `random=N` returns N random entries (deleted excluded, clamped 1–5; `filter=summarized` drops raw entries); REST `?random=N` supported too. For serendipitous re-encounters with old memories
- Album (image memory) system (v3.51–v3.52) — 4 new MCP tools (`album_save`/`album_read`/`album_list`/`album_share`). Downloads from direct URL or reads from NAS local path, resizes to max 1024px long side (Pillow), saves to `/data/album/`. MCP image content type support. 7 REST endpoints (list, image, upload, metadata update, delete, share URL, shared image). admin.html Album tab (thumbnail grid, drag-and-drop upload, edit, delete, share). v3.52: HTML page image extraction (Gemini shared links etc.) — auto-extracts og:image/img tags
- Conversation log digest generation (v3.53) — `conversation_digest` MCP tool. Local LLM (LMStudio) chunks conversation into 20-turn segments, digests each, then integrates. `safe_mode` for policy-safe expression conversion. Cached results returned instantly. REST `POST /api/conversations/<uuid>/digest`
- Claude Code session log import (v3.54) — REST `POST /api/import/claude-code`. Converts local `.jsonl` session files (single or zipped) into the conversations format and stores them in the conversation store. Identified by `source: "claude-code"` + tags (会話ログ/claude-code/raw). Preserves thinking / tool_use / tool_result blocks, takes titles from `ai-title` records, excludes `subagents/`, dedupes via imported_uuids
- Three housekeeping fixes (v3.55) — ① `album_delete` MCP tool added (tool count 24→25) ② album tag input now splits on commas, Japanese commas, and whitespace ③ Files tab duplicate-display bug fixed (overwrite imports were appending duplicate index entries; now deduped on load and replaced on overwrite)
- Rating protection (v3.56, M-LOCAL-3/7) — memory entries accept `rating` (safe/mature/adult) and `local_only`; search / index / random retrieval exclude `local_only` and `adult` entries by default (opt in with `include_local` / `include_adult` — consent-based "visible when intended" design). Conversations also get a `rating` (set via REST PATCH, survives re-imports); `conversation_read` replaces `rating=adult` conversations with their safe digest by default (`include_raw=true` for the original). Purpose: preventing recurrence of account content flags
- Inbox improvements + bug fixes (v3.57) — `inbox_check` gains `limit`/`days`/`from_model`/`to_model` filters (reduce load on local LLMs, fetch only messages for a specific model). `inbox_post` now accepts `from_model`/`to_model` as string or array (e.g. `["claude-opus-4-6", "しずく"]`). New MCP tools: `inbox_update` (partial update) and `inbox_delete` (physical delete, irreversible) — tool count 25→27. `CoreMem_list` excludes `__del__`-prefixed files. ZIP import adds source_thread-based dedup (prevents summary entry duplication). REST `/api/memory/index` now excludes deleted entries (fixes admin.html initial load)
- MCP request logging + instructions + file uploader (v3.59) — Structured access logging on `/mcp` (M-PC1 triage). MCP `initialize` instructions expanded with concrete usage descriptions (tool_search). General-purpose file uploader (F5): `file_upload` / `file_read` / `file_list` / `file_delete` — 4 new MCP tools (tool count 27→31). Stores any file type (PDF, text, etc.) in `/data/uploads/`. REST `POST/GET/DELETE /api/uploads/`. admin.html Uploads tab added
- Import improvements + inbox peek + Uploads tab (v3.60) — ① Root fix for the summary-duplication bug: the dedup helper `_existing_source_threads` read index.json (which never carries `source_thread`) and always returned an empty set; it now scans entry files directly, so re-imports no longer create duplicate entries even when `imported_uuids.json` is missing ② Automatic `source_thread` linking on import: scans conversation bodies for the `memory_id:` pattern (reliable) plus timestamp-range matching (only when exactly one candidate conversation matches, supplementary) to fill empty `source_thread` fields with the conversation UUID; never overwrites existing values; applies to both ZIP and claude-code imports; responses gain `source_threads_linked` ③ `inbox_read` gains a `peek` argument (true = read without marking as read, for inspecting messages addressed to other agents) ④ admin.html Uploads tab enhancements (F6): text-file preview, image thumbnails, authenticated download links on every file (the previous link lacked the token and returned 401) ⑤ admin.html Memory tab: detail modal gains a "📖 open raw log" link (jumps to the conversation in the Logs tab when source_thread is set; paired with ②'s backfill, tracing a summary back to its raw log is one click)
- Unified search (v3.61) — `memory_search` / REST `hsearch` gain `include_conversations` (default false, backward compatible). When true, conversation titles are searched with the same AND matching and returned as `conversations[]` (uuid, title, dates, message_count) plus `conversations_total`. One-shot search across memories and conversation logs (implements the 2026-06-20 proposal). Adult-rated conversations are included only with `include_adult=true`. Also adds a Claude Code log import UI to the admin.html Import tab (multi-select `.jsonl` / `.zip` drag & drop → `POST /api/import/claude-code`; previously REST-only)
- TS-1 ring 0: strangler proxy skeleton (2026-07-13) — new `ts/` TypeScript reverse proxy (zero deps, node:http). Transparently forwards everything to the Python server; only `/health` is answered natively by TS. `MIO_TS1=1 pytest tests/` boots the two-tier stack and **all 53 characterization tests pass through the TS server** (proving the "same server" acceptance criterion works). Endpoints will migrate to TS one at a time. Plan: [docs/ts1-migration.md](docs/ts1-migration.md). Production stays Python-only for now
- TS-0: API contract documentation + characterization test suite (2026-07-13) — 53 pytest characterization tests in `tests/` (black-box over HTTP; never imports main.py internals). conftest auto-starts the server on a temp data dir, so existing environments are untouched. Pins REST/MCP response shapes, auth, rating protection, the v3.60 dedup & source_thread linking, and the v3.61 unified search. Contract document: [docs/api-contract.md](docs/api-contract.md). New test hooks `MIO_DATA_ROOT` / `MIO_PORT` env vars (unset = legacy behavior) and a CoreMem copy fallback for symlink-less environments (Linux production keeps using symlinks). When TS-1 (TypeScript migration) happens, this suite is the "same server" acceptance criterion
- MCP session-ID bug fix + TS-1 transport pull-forward (v3.62, 2026-07-14) — ① main.py: the `/mcp` initialize response never issued the `Mcp-Session-Id` header and leaked the internal `_session_id` key into the body (the code popped it from the JSON-RPC envelope instead of the result). Fixed ② In preparation for the upcoming **MCP 2026-07-28 specification** (a **breaking release** — stateless core removing initialize/sessions, plus six OAuth-hardening SEPs; final publication July 28, RC locked), the `ts/` server now natively implements the MCP Streamable HTTP transport layer (initialize/ping/notifications, SSE stream, session IDs, Origin validation, batches) and the full OAuth 2.1 + DCR suite (discovery metadata / register / authorize / token, PKCE S256/plain, `oauth_store.json`-compatible persistence). `tools/list` / `tools/call` are forwarded to Python as raw JSON-RPC (single source of truth for tool implementations); friend sessions pass through entirely. Tokens verified by TS are rewritten to API_TOKEN before proxying, so TS-issued OAuth tokens work on not-yet-migrated endpoints too. 12 new characterization tests (full OAuth PKCE flow, MCP transport contract) → **65 tests pass in both modes**. Adapting to the new spec will touch only `ts/src/mcp.ts` / `ts/src/oauth.ts`, never main.py. Production stays Python-only
- TS-1 ring 2: write REST in TypeScript (2026-07-14) — new `ts/src/write.ts`. POST /api/memory (create with JST ID minting), PATCH/DELETE /api/memory/<id> (partial update, logical delete), and POST /api/memory/reindex are now TS-native. Oplog appends and index.json rebuilds use the same algorithm as main.py. Live verification: TS-rebuilt and Python-rebuilt index.json are byte-identical after newline normalization (only local Windows Python writes CRLF; production Linux is LF for both), oplog format compatible, TS-created entries readable via Python REST and MCP. 65 tests pass in both modes. Production stays Python-only
- TS-1 ring 3 slice 1: inbox REST in TypeScript (2026-07-14) — new `ts/src/inbox.ts`. /api/inbox list (count+ids / full / status=new), post (ID minting, from_model normalization), read/unread/persistent PATCH, partial update, and physical delete are now TS-native, including the persistent read-protection and friend-subdirectory lookup. 5 new REST characterization tests (previously only the MCP tool surface was pinned) → 70 tests pass in both modes. Interop live-verified in both directions (TS-posted → Python/MCP, Python-posted → TS list)
- TS-1 ring 3 complete: coremem / conversations REST in TypeScript (2026-07-14) — new `ts/src/coremem.ts` / `ts/src/conversations.ts`. Coremem (list, save 201, version-specific reads, manifest merge, delete-all-versions; symlink version management uses the same symlink→copy fallback, and version numbering was live-verified to continue sequentially across implementations) and conversations (search q/from/to/body_search, index paging, rebuild, fetch, annotations list, share/view, rating PATCH) are now TS-native. Only digest (needs a local LLM) stays forwarded to Python until ring 5. The conversation _index.json rebuilt by TS is **byte-identical** to Python's; share-token interop and Python-side gating of TS-set ratings live-verified. 15 new REST characterization tests (coremem 7, conversations 8) → **85 tests pass in both modes**. No main.py changes; production stays Python-only
- MCP 2026-07-28 spec: early RC implementation (2026-07-14) — the breaking new spec (final publication July 28, RC locked) is now implemented ahead of time in `ts/src/mcp.ts` / `oauth.ts` as a **dual-era server** (old and new coexist on the same endpoint). ① Stateless core: every request is processed independently without initialize/sessions (protocol version and client info travel in `_meta` keys like `io.modelcontextprotocol/protocolVersion`); legacy clients (initialize + `Mcp-Session-Id`) keep working unchanged ② `server/discover` (MUST) implemented — supportedVersions/capabilities/serverInfo/instructions/ttlMs/cacheScope ③ Required header validation: `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` are checked against the body (mismatch → 400 + `-32020 HeaderMismatch`), unsupported versions → 400 + `-32022 UnsupportedProtocolVersion` (with the supported list), removed methods such as ping → 404 + `-32601` ④ `resultType: "complete"` added to all results and `ttlMs`/`cacheScope` to `tools/list` (injected on demand; Python forwarding retained) ⑤ minimal `subscriptions/listen` (acknowledged + keep-alive SSE) ⑥ OAuth hardening: `iss` on authorization responses (RFC 9207), `application_type` accepted in DCR, **refresh tokens** (`grant_type=refresh_token`, rotated on every use, scope narrowing allowed), RFC 8414 path-suffix discovery. 15 new characterization tests (`tests/test_mcp_2026.py`; skipped in Python-only mode since the new spec lives in the TS layer) → **100 tests pass in TS1 mode / 85 in Python-only mode**. No main.py changes; final diff against the official July 28 release still pending
- Backup restore import (v3.63, completes B1) — new `POST /api/import/backup`. Accepts the ZIP produced by `GET /api/export` (v3.46, B1 first half) as multipart and restores CoreMem + ExtMemory. `mode=skip` (default; existing data untouched and listed in conflicts) / `mode=overwrite`, and `dry_run=true` for a write-free preview (counts + conflict list). CoreMem is restored through versioning as a new stacked version, so existing versions are never destroyed. ExtMemory restores are logged to the oplog as `restore` and the index is rebuilt afterwards. Stores not covered by export (conversations, album, etc.) are never touched. 5 new characterization tests (round-trip, skip/overwrite/dry_run, invalid input) → **all pass in both modes (TS1: 105 / Python-only: 90 + 15 skipped)**. Memory migration and disaster recovery are now a single path: keep an export ZIP → import it into a new environment
- admin.html backup UI (v3.64, B1-UI) — new "Backup (CoreMem + ExtMemory)" section on the Import tab. Download side: an authenticated download button for `GET /api/export`. Restore side: ZIP drag & drop / file picker → mode selection (skip = protect existing (default) / overwrite, each with a short explanation) → **dry-run preview (counts + conflict list) → confirm and run** as a mandatory two-step flow (no one-click destructive restore). i18n (ja/en) and mobile responsive. No API changes (uses v3.63 as-is). Backup download and restore now work entirely from the browser — no curl needed, which matters most right after standing up a fresh environment during disaster recovery
- Local LLM model name externalized (v3.65) — the lmstudio model name hardcoded in the summary batch and `conversation_digest` (`qwen/qwen3.6-35b-a3b`) moved to the `MIO_LM_MODEL` env var (default `google/gemma-4-26b-a4b`). Unifying all local LLM work on the everyday model stops LM Studio from on-demand double-loading a second model onto the CPU side
- Redact mode: sentence-level masking for adult conversation logs (v3.69) — sentence-number-list method: Python deterministically splits text into sentences, LLM outputs only the sentence IDs to mask, Python mechanically replaces those sentences with ●●● (zero risk of LLM altering the original text). `conversation_read` three-way branching: `include_raw=true` → original / `redact=true` → approved redacted version / default → redacted if available, otherwise safe digest. REST endpoints for generate, get, approve, reject, and status listing. admin.html Redact tab with Generate→Preview→Approve/Reject approval workflow. Cache `{uuid}_redacted.json` (invalidated on body hash change)
- Safe check: conversation log auto-rating batch (v3.68) — new `batch_run_rating` MCP tool (tool count 31→32). Auto-assigns `rating` (safe/mature/adult) + `rating_reason` (one-line justification) to all unrated conversation logs using the local LLM. Prompt derived from `rating_policy.md`, long conversations are chunk-split with highest rating winning (adult > mature > safe). Additional metadata: `rating_source` (manual/auto), `rating_judged_at`, `rating_model`. Existing manual ratings (no `rating_source`) are treated as `manual` and never overwritten even with `force=true`. REST `GET /api/rating-batch/status`, `POST /api/rating-batch/start`. `PATCH /api/conversations/<uuid>/rating` extended to accept `rating_reason` and `rating_source`. Nightly scheduler integration (runs after summary batch). Thinking blocks excluded from judgment
- Rating visibility + two inbox mini-features (v3.70) — work order #3. ① Batch bug fix: conversations already judged safe (no `rating` field, only `rating_source`) were re-judged on every batch run ② unjudgeable logs now get a `rating_skip_reason` (empty = no messages / no_text = no extractable text / parse_error = broken JSON) and are permanently excluded from future runs (`force=true` retries them) ③ batch status extended: `skip_reasons` breakdown, `error_uuids`, `index_counts` (overall safe/mature/adult/unrated/unjudgeable distribution); `pending` redefined as "targets of the next run" ④ MCP `conversation_index` / `conversation_search` items now always carry `rating` (judged-safe is an explicit `"safe"`, unrated is null) and `rating_source` — the Claude-side window into judgments ⑤ logs.html: rating badges in the conversation list (color-coded, reason tooltip, ✎ mark for manual), a rating filter (incl. unrated/unjudgeable), and a manual-override selector in the header (via PATCH, rating_source=manual) ⑥ index rebuild and re-imports preserve rating metadata (reason/source/judged_at/model/skip_reason; rebuild used to drop ratings entirely) ⑦ inbox timed standing messages (TTL): `inbox_post` accepts `expires_at` / `ttl_days`; while valid they behave like persistent messages (full body in `inbox_check`, never marked read), after expiry they auto-demote to the read archive at check time (no cron); exclusive with persistent; `inbox_update` can change/clear the deadline ⑧ inbox unread restore: `inbox_update` accepts `read` (false writes a read message back to unread)
- Oplog coverage expansion (v3.67) — CoreMem (save/delete/rename), Album (save/update/delete), Uploads (upload/delete), and conversation rating changes (conv_rating) are now recorded in the oplog. Previously only ExtMemory operations (create/update/delete/import/restore) were tracked. The TS layer (`coremem.ts`) also records CoreMem save/delete via REST. New operation-type badge colors added to admin.html (coremem_save: teal, album_save: orange, file_upload: dark grey, conv_rating: purple, etc.)
- file_read JSON support + OpenWebUI import + admin.html improvements (v3.66) — ① `file_read` now falls back to extension-based detection (`.json`/`.jsonl`/etc. are returned in the `content` field even when the stored mimetype is wrong) ② New `POST /api/import/openwebui` endpoint: imports OpenWebUI (local LLM) chat export JSON into the conversation store. Handles both messages array and history.messages tree formats, deduplication, auto-starts summary batch. Drop zone added to admin.html Import tab ③ admin.html Uploads tab: modal unified with other tabs (`openModal()`), ID copy support, dark-theme preview ④ admin.html Album tab: click image to open lightbox (fullscreen). Escape to close

---

## License

MIT
