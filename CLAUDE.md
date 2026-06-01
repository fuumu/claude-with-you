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

## Architecture

**Single file**: all logic is in `memory/app/main.py`. There are no sub-modules.

**Three layers in one file:**

1. **REST API** (`/api/memory/*`) — CRUD for memory entries with Bearer token auth. Supports both `Authorization: Bearer <token>` header and legacy path-embedded token (`/api/<token>/memory/...`).

2. **OAuth 2.1 + Dynamic Client Registration** — enables Claude.ai to authenticate without a pre-shared API token. Endpoints: `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`. PKCE (S256 and plain) is required. Auth codes expire in 10 minutes; access tokens last 30 days and are persisted to `oauth_store.json`.

3. **MCP Streamable HTTP transport** (`/mcp`) — implements the MCP 2025-11-25 spec. POST handles JSON-RPC messages (single and batch). GET opens an SSE keepalive stream for clients that need it. DELETE signals session close. Legacy SSE endpoints `/mcp/sse` and `/mcp/messages` remain for backward compatibility.

**MCP tools exposed:**
- `memory_read_index` — returns the index
- `memory_read` — reads a single entry by id
- `memory_write` — creates a new entry
- `memory_search` — full-text keyword search across title, body, and tags

**Entry ID format:** `YYYYMMDD_HHMMSS_<first_tag_slug>` (e.g., `20260601_153000_chat`).

## Dependencies

All Python wheels are vendored in `memory/wheels/` so the Docker build works without internet access. The only runtime dependency is Flask. To add a package, download its wheel (and all transitive deps) into `memory/wheels/` and add it to `requirements.txt`.

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MIO_API_TOKEN` | `changeme` | Shared secret for Bearer auth and OAuth password |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | *(empty)* | Comma-separated allowed Origins; empty skips check |
