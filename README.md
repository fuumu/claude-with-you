# claude-with-you

> Persistent external memory for Claude — self-hosted MCP server

**[日本語版 / Japanese](README.ja.md)**

Claude doesn't remember yesterday's conversations. `claude-with-you` solves this by giving Claude a persistent memory store it can read and write across sessions — running on your own hardware, under your control.

Built around the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), it works with both **Claude.ai** (via OAuth) and **Claude Code** (via Bearer token). All data stays on your NAS or server.

---

## Quick Start

**Requirements:** Docker, a Synology NAS or any Linux server, Claude Code CLI

### 1. Configure environment

```bash
cp .env_sample .env
# Edit .env — set MIO_API_TOKEN to a secret of your choice
```

### 2. Start the server

```bash
docker compose up -d
```

### 3. Verify

```bash
curl https://your-domain/health
# {"status":"ok","version":"3.5","mcp_tool_count":15,...}
```

### 4. Connect Claude Code

```powershell
claude mcp add --transport http mio-memory https://your-domain/mcp
```

An OAuth login page opens — enter your `MIO_API_TOKEN` to authorize.

### 5. Connect Claude.ai

In Claude.ai settings → Connectors → Add custom MCP server → enter `https://your-domain/mcp`.

---

## What it does

### Memory — store and recall anything

Claude can write notes, decisions, preferences, and facts to your server and retrieve them in future sessions. Memory entries are tagged JSON files, searchable by keyword.

### Artifacts — versioned file storage

Save and version markdown files, scripts, or any text content. `core.md` (Claude's identity file) lives here. Every save creates a new version; the latest is always accessible by name.

### Conversations — browse past chats

Import your Claude.ai export ZIP and browse all past conversations. Search by keyword, read full conversation text, or share a conversation via a 24-hour link.

### Inbox — messages between sessions

Claude Code and Claude.ai can leave messages for each other in a lightweight inbox. Task handoffs, completion reports, and standing reminders (`persistent=true`) all flow through here.

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
  │  /mcp          MCP Streamable    │
  │  /api/memory/* Memory REST API   │
  │  /api/artifacts/* File REST API  │
  │  /api/conversations/* Chat API   │
  │  /api/inbox/*  Inbox REST API    │
  │  /import       ZIP import        │
  │  /admin.html   Web UI            │
  │  /logs.html    Conversation view │
  │  /oauth/*      OAuth 2.1         │
  └──────────────┬───────────────────┘
                 │ volume mount
  ┌──────────────▼───────────────────┐
  │  /data/                          │
  │  ├── memory/*.json   entries     │
  │  ├── artifacts/      files       │
  │  ├── conversations/  chat logs   │
  │  ├── inbox/          messages    │
  │  ├── index.json      index       │
  │  └── oplog.json      audit log   │
  └──────────────────────────────────┘
```

**Single-file implementation** — all logic lives in `memory/app/main.py`. Three layers in one file:

1. **REST API** (`/api/*`) — CRUD for memory, artifacts, conversations, inbox
2. **OAuth 2.1** — Dynamic Client Registration + PKCE, so Claude.ai can connect without a pre-shared token
3. **MCP Streamable HTTP** — implements the MCP 2025-11-25 spec

---

## MCP Tools (v3.5 — 15 tools)

### Memory (6 tools)

| Tool | Description | Required args |
|------|-------------|---------------|
| `memory_read_index` | List all memory entry titles and tags | — |
| `memory_read` | Read a specific entry by ID | `id` |
| `memory_write` | Create a new memory entry | `title`, `body` |
| `memory_upsert` | Write to a fixed ID (create or overwrite) | `id`, `title`, `body` |
| `memory_search` | Keyword search with pagination | `q` |
| `memory_share` | Generate a 24h shareable URL | `id` |

`memory_search` returns `{results, total, has_more}` and supports `limit` (default 10) and `offset`.

### Artifacts (3 tools)

| Tool | Description | Required args |
|------|-------------|---------------|
| `artifacts_save` | Save a file with version history | `name`, `content` |
| `artifacts_read` | Read latest or specific version | `name` |
| `artifacts_list` | List all saved artifacts | — |

`artifacts_save` accepts an optional `source_conversation_uuid` to link the file to its origin conversation.  
`artifacts_read` falls back to conversation-extracted files if not found in the main store.

### Conversations (3 tools)

| Tool | Description | Required args |
|------|-------------|---------------|
| `conversation_search` | Search past conversation titles | `q` |
| `conversation_read` | Read full conversation text | `uuid` |
| `conversation_share` | Generate a 24h shareable URL | `uuid` |

### Inbox (3 tools)

| Tool | Description | Required args |
|------|-------------|---------------|
| `inbox_check` | Get unread count and IDs (~50 tokens) | — |
| `inbox_read` | Fetch and mark a message as read | `id` |
| `inbox_post` | Send a message | `to`, `title`, `body` |

`inbox_check` accepts an optional `to` filter (`"chat"` or `"code"`).  
`inbox_post` accepts `persistent=true` for standing messages that are never marked as read.

All tool responses include a `server_time` field (JST ISO 8601).

---

## Web UI (`/admin.html`)

The built-in admin panel has six tabs:

| Tab | What you can do |
|-----|-----------------|
| **Memory** | Browse, search, and edit memory entries |
| **Artifacts** | View and read versioned files |
| **Import** | Upload a Claude.ai export ZIP; overwrite mode available |
| **Files** | Browse files extracted from conversation tool-use blocks |
| **Logs** | Search and read past conversations |
| **Oplog** | Audit log of all create/update/delete operations |

Access at `https://your-domain/admin.html` with your API token.

---

## Data Import

Export your Claude.ai data (Settings → Export), then upload the ZIP via the admin panel or API:

```bash
curl -X POST https://your-domain/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@claude_export.zip"
# Add -F "overwrite=true" to reprocess already-imported conversations
```

What gets imported:

- `conversations.json` — every chat becomes a memory entry; full text is saved to `/data/conversations/`
- `memories.json` — userMemories content saved as `core_memories_YYYYMMDD.md` artifact
- `projects/*.json` — project metadata recorded as memory entries
- If `ANTHROPIC_API_KEY` is set, a summarization batch starts automatically

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MIO_API_TOKEN` | `changeme` | Shared secret — used for Bearer auth and OAuth login |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | *(empty)* | Comma-separated allowed Origins; empty = skip check |
| `ANTHROPIC_API_KEY` | *(empty)* | If set, auto-starts summarization after ZIP import |
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
│   ├── setup.md            First-time setup (NAS → GitHub → workstation)
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

## Redeploy after code changes

```bash
docker compose up -d --build memory
docker compose logs -f memory
```

---

## Roadmap

- `BASE_URL` env variable (currently hardcoded in `main.py` and `admin.html`)
- UI distribution for students (vanilla JS + `config.js` approach)
- Friend system (v0.1 spec drafted)
- Tailscale integration for remote access
- Artifact delete UI

---

## License

MIT
