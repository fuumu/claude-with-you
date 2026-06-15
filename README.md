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

```bash
# 1. Clone and configure
git clone https://github.com/fuumu/claude-with-you.git
cd claude-with-you
cp .env_sample .env        # then edit MIO_API_TOKEN

# 2. Start
docker compose up -d

# 3. Verify
curl https://your-domain/health
# {"status":"ok","version":"3.42","mcp_tool_count":18}

# 4. Connect Claude Code
claude mcp add --transport http mio-memory https://your-domain/mcp
# An OAuth page opens — enter your MIO_API_TOKEN to authorize
```

For Claude.ai: Settings → Connectors → Add custom MCP → `https://your-domain/mcp`

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
  /data/  memory(ExtMemory)/ · artifacts(UserCoreMemory)/ · conversations(LogStore)/ · inbox/ · friends/
```

Single-file implementation — all logic in `memory/app/main.py`.

---

## Section A — MCP API Layer

Claude calls these tools directly. All responses include `server_time` (JST) and `server_version` (v3.20+, e.g. `"3.21"` — lets clients auto-switch behavior by server capability).

### Memory tools (6)

| Tool | Description | Key args |
|------|-------------|----------|
| `memory_read_index` | List all entry titles and tags | — |
| `memory_read` | Read one entry by ID | `id` |
| `memory_write` | Create a new entry | `title`, `body`, `tags`, `importance` |
| `memory_upsert` | Overwrite a fixed-ID entry | `id`, `title`, `body` |
| `memory_search` | Hierarchical search (index keywords + layer-3 symbolic → summary → full text); returns `summary` + `match_layer` (keyword/symbolic/summary/full) per hit | `q`, `limit` (default 10), `offset`, `full_body` |
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

### Conversation tools (5)

Browse, share, and annotate past conversations imported from Claude.ai export ZIPs.

| Tool | Description | Key args |
|------|-------------|----------|
| `conversation_index` | List conversation titles in descending date order with pagination — for browsing when UUID is unknown (v3.34); REST: `GET /api/conversations/index`, rebuild: `POST /api/conversations/index/rebuild` | `search`, `limit`, `offset` |
| `conversation_search` | Search conversation titles by keyword and date range | `q`, `limit` |
| `conversation_read` | Read full conversation text; `include_thinking=true` includes thinking blocks (v3.20); `thinking_limit` caps each block (default 1500, ≤0 unlimited); `include_annotations=true` shows annotations inline with `[No.X]` message numbers (v3.22); `include_body=false` returns annotations only without message body (v3.33) | `uuid`, `include_thinking`, `thinking_limit`, `include_annotations`, `include_body` |
| `conversation_share` | Generate 24h shareable URL (`/share.html?token=` — standalone read-only viewer, v3.23) | `uuid` |
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
| `inbox_read` | Fetch a message and mark as read | `id` |
| `inbox_post` | Send a message; `from_model`/`to_model` optionally tag sender/recipient model (v3.27) | `to`, `title`, `body`, `persistent`, `from_model`, `to_model` |

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

`backend` defaults to `anthropic` when `ANTHROPIC_API_KEY` is set, otherwise `lmstudio` (local LLM). The same batch auto-starts after each ZIP import.

### REST API reference

All REST endpoints require `Authorization: Bearer YOUR_TOKEN`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memory/index` | List all entries |
| GET | `/api/memory/search?q=...` | Search entries |
| GET | `/api/memory/hsearch?q=...` | Hierarchical search (keywords+symbolic→summary→full body, with match_layer/summary/symbolic) |
| GET | `/api/memories/symbolic` | List layer-3 symbolic compression for all entries (`{id, title, symbolic}`, empties excluded, v3.42) |
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
| POST | `/import` | Import ZIP file |
| GET | `/health` | Health check |

---

## Section B — Web UI Layer

Access at `https://your-domain/admin.html` — login with your API token.

### Admin panel (`/admin.html`)

| Tab | What you can do |
|-----|-----------------|
| **Memory** | Browse, search, read, and edit memory entries |
| **CoreMem** | View UserCoreMemory files, content preview, and delete |
| **Import** | Upload Claude.ai export ZIP; overwrite mode for re-processing |
| **Files** | Browse files extracted from conversation tool-use blocks |
| **Inbox** | Read messages between Claude Code and Claude.ai sessions |
| **Logs** | Search and read full conversation history |
| **Oplog** | Audit log of all create/update/delete operations |
| **Friends** | Manage friend registrations — approve requests, issue access tokens, view usage |

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
| `LM_STUDIO_HOST` | `192.168.10.32` | LM Studio host for local summarization |
| `LM_STUDIO_PORT` | `1234` | LM Studio port |
| `SENDGRID_API_KEY` | *(empty)* | Friend system: SendGrid API key for approval emails (Mail Send scope) |
| `SENDGRID_FROM_EMAIL` | *(empty)* | Friend system: sender email address |
| `MIO_REGISTER_URL` | *(empty)* | Friend system: public base URL for activation links — `/activate` is appended (falls back to `MIO_BASE_URL`) |

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
│   └── memory_search_guide.md   Search strategy guide (4-layer usage)
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

**Implemented (v3.9–v3.34)**
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

---

## License

MIT
