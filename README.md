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
# {"status":"ok","version":"3.53","mcp_tool_count":24}

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
  /data/  memory(ExtMemory)/ · artifacts(UserCoreMemory)/ · conversations(LogStore)/ · inbox/ · friends/
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
| `memory_search` | Hierarchical search (index keywords + layer-3 symbolic → summary → full text); returns `summary` + `match_layer` (keyword/symbolic/summary/full) per hit; multi-word queries are AND-matched (split on half/full-width spaces, v3.48) | `q`, `limit` (default 10), `offset`, `full_body` |
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
| `conversation_index` | List conversation titles in descending date order with pagination — for browsing when UUID is unknown (v3.34); REST: `GET /api/conversations/index`, rebuild: `POST /api/conversations/index/rebuild` | `search`, `limit`, `offset` |
| `conversation_search` | Search conversation titles by keyword and date range | `q`, `limit` |
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

### Album tools (4, v3.52)

| Tool | Description | Key args |
|------|-------------|----------|
| `album_save` | Save an image to the album. Downloads from URL (direct or HTML page — auto-extracts from og:image/img tags) or reads from NAS local path, resizes to max 1024px long side (Pillow), saves image + metadata JSON to `/data/album/` | `url`, `file_path`, `comment`, `tags` |
| `album_read` | Read an album image. Returns MCP image content (base64) + metadata JSON | `id` |
| `album_list` | List album image metadata (no image data). Filter by tags | `tags` |
| `album_share` | Generate a 24h auth-free share URL for an album image | `id` |

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
| `LM_STUDIO_HOST` | `192.168.x.x` | LM Studio host for local summarization (replace with your own IP) |
| `LM_STUDIO_PORT` | `1234` | LM Studio port |
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

**Design phase**
- OpenWebUI conversation log sync — import local LLM (LMStudio + OpenWebUI) chat history into mio-memory, unified search with Claude.ai logs ([design doc](docs/openwebui-sync.md))

**Implemented (v3.9–v3.52)**
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

---

## License

MIT
