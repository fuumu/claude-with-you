# claude-with-you

> Persistent external memory for Claude — self-hosted MCP server

**[日本語版 / Japanese](README.ja.md)**

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
# {"status":"ok","version":"3.5","mcp_tool_count":15}

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
  │  └─────────────────────────────┘ │
  └──────────────┬───────────────────┘
                 │ volume mount
  /data/  memory/ · artifacts/ · conversations/ · inbox/
```

Single-file implementation — all logic in `memory/app/main.py`.

---

## Section A — MCP API Layer

Claude calls these tools directly. All responses include `server_time` (JST).

### Memory tools (6)

| Tool | Description | Key args |
|------|-------------|----------|
| `memory_read_index` | List all entry titles and tags | — |
| `memory_read` | Read one entry by ID | `id` |
| `memory_write` | Create a new entry | `title`, `body`, `tags`, `importance` |
| `memory_upsert` | Overwrite a fixed-ID entry | `id`, `title`, `body` |
| `memory_search` | Full-text search with pagination | `q`, `limit` (default 10), `offset` |
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

### Artifact tools (3)

Versioned file storage. Every save creates a new version; the latest is always accessible by name.

| Tool | Description | Key args |
|------|-------------|----------|
| `artifacts_save` | Save a file (new version) | `name`, `content`, `source_conversation_uuid` |
| `artifacts_read` | Read latest or specific version | `name`, `version` |
| `artifacts_list` | List all files | — |

`artifacts_read` falls back to conversation-extracted files if not found in the main store.

**Example — save a config file:**
```
artifacts_save(name="config.md", content="# Config\n...", source_conversation_uuid="abc-123")
→ {"name": "config.md", "version": 2, "server_time": "..."}
```

### Conversation tools (3)

Browse and share past conversations imported from Claude.ai export ZIPs.

| Tool | Description | Key args |
|------|-------------|----------|
| `conversation_search` | Search conversation titles | `q`, `limit` |
| `conversation_read` | Read full conversation text | `uuid` |
| `conversation_share` | Generate 24h shareable URL | `uuid` |

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
| `inbox_check` | Get unread count + IDs (~50 tokens) | `to` (`"chat"` or `"code"`) |
| `inbox_read` | Fetch a message and mark as read | `id` |
| `inbox_post` | Send a message | `to`, `title`, `body`, `persistent` |

`persistent=true` creates a standing message that is never marked as read — useful for reminders that should appear every session.

**Example — Claude Code reports completion to Claude.ai:**
```
inbox_post(to="chat", title="Deploy complete", body="v3.5 is live. Commit: abc123")

# Claude.ai checks later:
inbox_check(to="chat") → {"count": 1, "ids": ["inbox_..."], "server_time": "..."}
inbox_read(id="inbox_...") → {title: "Deploy complete", body: "...", ...}
```

### REST API reference

All REST endpoints require `Authorization: Bearer YOUR_TOKEN`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memory/index` | List all entries |
| GET | `/api/memory/search?q=...` | Search entries |
| GET | `/api/memory/<id>` | Get one entry |
| POST | `/api/memory` | Create entry |
| PATCH | `/api/memory/<id>` | Update entry |
| DELETE | `/api/memory/<id>` | Soft-delete entry |
| GET | `/api/artifacts` | List artifacts |
| GET | `/api/artifacts/<name>` | Read artifact |
| POST | `/api/artifacts/<name>` | Save artifact |
| GET | `/api/conversations/` | Search conversations |
| GET | `/api/conversations/<uuid>` | Get conversation |
| GET | `/api/inbox` | List inbox messages |
| POST | `/api/inbox` | Post a message |
| PATCH | `/api/inbox/<id>/read` | Mark as read |
| POST | `/import` | Import ZIP file |
| GET | `/health` | Health check |

---

## Section B — Web UI Layer

Access at `https://your-domain/admin.html` — login with your API token.

### Admin panel (`/admin.html`)

| Tab | What you can do |
|-----|-----------------|
| **Memory** | Browse, search, read, and edit memory entries |
| **Artifacts** | View versioned files and their content |
| **Import** | Upload Claude.ai export ZIP; overwrite mode for re-processing |
| **Files** | Browse files extracted from conversation tool-use blocks |
| **Inbox** | Read messages between Claude Code and Claude.ai sessions |
| **Logs** | Search and read full conversation history |
| **Oplog** | Audit log of all create/update/delete operations |

### Conversation viewer (`/logs.html`)

- Auto-loads conversations from the server
- Filter by keyword, date range, minimum message count
- Renders markdown with `marked.js` + `DOMPurify`
- Collapsible `thinking` / `tool_use` / `tool_result` blocks
- Font size toggle (small / medium / large)
- Shareable via `?token=` URL (no login required)

**Sharing a conversation:**
```
# Via MCP tool:
conversation_share(uuid="abc-123")
→ {"url": "https://your-domain/logs.html?token=xyz", "expires_at": "..."}

# Anyone with the link can read the conversation for 24 hours
```

---

## Section C — Data Import & Management

### Import a Claude.ai export

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
| `memories.json` | userMemories → `core_memories_YYYYMMDD.md` artifact |
| `projects/*.json` | Project metadata as memory entries |

**Auto-summarization:** If `ANTHROPIC_API_KEY` is set, a batch job starts automatically after import. It adds 2-layer (summary) and 3-layer (symbolic compression) annotations to raw entries.

### Versioned artifacts

```
/data/artifacts/
├── core.md          → versions/core_md/003.md  (symlink to latest)
└── versions/
    └── core_md/
        ├── 001.md
        ├── 002.md
        └── 003.md   ← current
```

Every `artifacts_save` creates a new numbered version. The top-level symlink always points to the latest. Specific versions are accessible via `artifacts_read(name="core.md", version=1)`.

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
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | *(empty)* | Allowed CORS origins; empty = skip check |
| `ANTHROPIC_API_KEY` | *(empty)* | Enables auto-summarization after import |
| `LM_STUDIO_HOST` | `192.168.10.32` | LM Studio host for local summarization |
| `LM_STUDIO_PORT` | `1234` | LM Studio port |

---

## Project Structure

```
claude-with-you/
├── README.md               This file (English)
├── README.ja.md            Japanese detailed reference
├── CLAUDE.md               Claude Code instructions
├── docker-compose.yml
├── .env_sample
├── docs/
│   ├── design.md           MCP server design spec
│   ├── setup.md            First-time setup guide
│   └── talk-and-build.md   Claude.ai + Claude Code workflow
├── scripts/
│   └── generate_summary_layers.py
└── memory/
    ├── Dockerfile
    ├── app/
    │   ├── main.py         All server logic (~1900 lines, single file)
    │   ├── admin.html      Web admin UI
    │   ├── logs.html       Conversation viewer
    │   └── requirements.txt
    └── wheels/             Vendored Python wheels (offline build)
```

---

## Roadmap

- `BASE_URL` env variable (currently hardcoded)
- UI distribution for students (vanilla JS + `config.js`)
- Tailscale integration for remote access
- Friend system (v0.1 spec drafted)
- Artifact delete UI

---

## License

MIT
