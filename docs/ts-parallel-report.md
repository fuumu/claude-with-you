# TS Front-End Production Switch Preparation Report

*Created: 2026-08-15 / Shizuku (Code side)*
*Ordered by: Shio (2026-08-15)*

---

## ① Production TS Service Definition Check & Creation

### Inventory Results

| Item | Production Python (existing) | TS Front-End (created) |
|------|------------------------------|------------------------|
| Dockerfile | `memory/Dockerfile` (python:3.11-slim) | **`ts/Dockerfile` — newly created** (node:22-slim) |
| Compose definition | `docker-compose.yml` → `memory` service | **`docker-compose.parallel.yml` — newly created** (overlay) |
| Port | 5002 (`MIO_PORT` default) | 5003 (`MIO_PORT=5003` override) |
| Network | `network_mode: host` | `network_mode: host` (same) |
| Data | `./memory/data:/data` | `./memory/data:/data` (shared volume) |

### Created Files

**`ts/Dockerfile`** — Node 22 slim, zero external dependencies, build-time compile.

**`docker-compose.parallel.yml`** — Overlay file. Does NOT modify `docker-compose.yml`.

---

## ② TS Front-End Endpoint Inventory

### Routes Used by Claude.ai Client

All OAuth and MCP routes are **TS native**. Claude.ai's entire communication path works through the TS proxy.

### Three-Way Classification of All REST Routes

#### Through TS (native implementation)

Health, Memory REST (reads + writes + reindex), Inbox (all), CoreMem (all), Conversations (all except digest), OAuth (all 4 endpoints + RFC 8414), MCP transport (dual-era: legacy + 2026-07-28).

#### Pass-through (transparent proxy to Python)

Static HTML pages, import/export, memory search/dedup/cleanup, legacy path-token routes, share tokens, oplog, friends system, conv-artifacts, redact, batch/rating-batch, attendance, album, uploads, legacy SSE endpoints, friend MCP sessions.

#### Should remain Python-direct (low priority for TS migration)

Digest (requires LLM), batch jobs (background threads + LLM), ZIP import (complex multipart), friend sessions (dynamic tool set), static HTML (no benefit).

### Key Findings

- **OAuth works through TS.** TS and Python share `oauth_store.json`. TS-issued tokens are rewritten to `API_TOKEN` when forwarded.
- **MCP 2026-07-28 is TS-only.** Python stays on 2025-11-25. No Python changes needed for the switch.

---

## ③ Parallel Configuration Design

### Architecture

```
Production Python (:5002) ← unchanged, serves Claude.ai
TS proxy (:5003) ← parallel port, upstream → :5002, shares /data
```

### Startup / Shutdown / Rollback

See Japanese version for copy-paste commands.

---

## Second Phase (Production Switch) Estimate

**Mostly just a port swap**, plus: MIO_BASE_URL verification, write exclusivity confirmation under production load, friend session check, compose finalization, optional logging.

**Estimated time**: 1–1.5 hours including verification. Rollback is instant (stop TS, Python is untouched).

### Potential Issues at Switch Time

1. Legacy SSE endpoints (`/mcp/sse`, `/mcp/messages`) — not used by current Claude.ai client
2. `oauth_store.json` concurrent writes — low risk, ideally consolidate to TS-only post-switch
3. Admin HTML served via TS proxy — transparent, but note the extra hop
