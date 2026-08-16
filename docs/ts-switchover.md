# TS Frontend Production Switchover Guide

*Created: 2026-08-16 / Shizuku (Code side)*
*Order: Shizuku (Chat side, 2026-08-16) / Design: Shio (2026-08-15)*

---

## Overview

Switch the public-facing port from Python direct to TS frontend.

```
[Current]
  Claude.ai / Reverse proxy → Python (:5002)

[After switchover]
  Claude.ai / Reverse proxy → TS frontend (:5002) → Python (:5003, internal)
```

Data and tool execution remain in Python. TS handles the transport layer (OAuth, MCP, REST), forwarding tool execution to Python.

---

## Pre-switchover Backup

Always run before switching.

```bash
# 1. Back up configuration files
cp docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d)
cp .env .env.bak.$(date +%Y%m%d)

# 2. Back up OAuth store (preserve existing tokens)
cp memory/data/oauth_store.json memory/data/oauth_store.json.bak.$(date +%Y%m%d)
```

---

## Switchover Steps (Copy-Paste Execution)

### Step 1: Edit docker-compose.yml

Add `MIO_PORT=5003` to the `memory` service to move Python to an internal port.

**Before:**
```yaml
version: '3'
services:
  memory:
    build:
      context: ./memory
      network: host
    network_mode: host
    volumes:
      - ./memory/data:/data
      - ./scripts:/app/scripts:ro
    env_file:
      - .env
    restart: unless-stopped
```

**After:**
```yaml
version: '3'
services:
  memory:
    build:
      context: ./memory
      network: host
    network_mode: host
    volumes:
      - ./memory/data:/data
      - ./scripts:/app/scripts:ro
    env_file:
      - .env
    environment:
      - MIO_PORT=5003
    restart: unless-stopped

  ts-proxy:
    build:
      context: ./ts
      network: host
    network_mode: host
    volumes:
      - ./memory/data:/data
    environment:
      - MIO_PORT=5002
      - MIO_UPSTREAM_HOST=127.0.0.1
      - MIO_UPSTREAM_PORT=5003
    env_file:
      - .env
    restart: unless-stopped
    depends_on:
      - memory
```

**Summary of changes:**
- Added `environment: - MIO_PORT=5003` to `memory` (move to internal port)
- Added `ts-proxy` service (listen on :5002, upstream to :5003)

### Step 2: Execute Switchover

```bash
# Move Python to :5003 + start TS on :5002 (single command)
docker-compose up -d --build

# Verify both containers are running
docker-compose ps
```

### Step 3: Health Check

```bash
# Confirm TS frontend is responding (should include served_by: "ts")
curl http://127.0.0.1:5002/health
```

Expected response:
```json
{"status":"ok","version":"3.89",...,"served_by":"ts"}
```

**If `served_by: "ts"` is present, TS is serving on the public port.**

### Step 4: MCP Connectivity Check

```bash
# REST API read (memory_read_index equivalent)
curl -H "Authorization: Bearer $MIO_API_TOKEN" http://127.0.0.1:5002/api/memory/index | head -c 200

# MCP JSON-RPC connectivity (initialize)
curl -X POST http://127.0.0.1:5002/mcp \
  -H "Authorization: Bearer $MIO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

### Step 5: Python Direct Connectivity (Internal Port Check)

```bash
# Confirm Python responds on :5003
curl http://127.0.0.1:5003/health
```

Expected: normal `/health` response without `served_by`.

---

## OAuth Re-authentication Verification

**After switchover, confirm new connections (connector re-authentication) from Claude.ai succeed.**

### Verification Steps

1. Open the connector settings in Claude.ai
2. Disconnect the mio-memory connector, then reconnect
3. Verify the OAuth flow completes (username/password → redirect → token issuance)
4. Verify MCP tools work (e.g., `CoreMem_read("core.md")`)

### Why This Is Needed

- TS now serves the public port, so OAuth discovery (`/.well-known/oauth-authorization-server`) is handled by TS
- Verify TS-issued tokens are correctly rewritten to `API_TOKEN` when forwarded to Python
- Even if existing tokens work, a broken re-authentication flow is a time bomb

---

## Rollback Procedure (Under 3 Minutes)

If anything goes wrong, restore the previous configuration immediately.

```bash
# 1. Restore docker-compose.yml from backup
cp docker-compose.yml.bak.$(date +%Y%m%d) docker-compose.yml

# 2. Stop TS, restore Python to :5002
docker-compose up -d --build

# 3. Remove TS container (optional)
docker-compose rm -f ts-proxy 2>/dev/null || true

# 4. Connectivity check
curl http://127.0.0.1:5002/health
```

**Key point: just restore `docker-compose.yml` and run `up -d --build`. Python returns to :5002, TS is not defined so it won't start.**

If the date has changed, adjust the `.bak.YYYYMMDD` filename to match the actual backup date.

---

## Post-switchover Verification Checklist

To be executed by chat-side agents:

| # | Item | Method | Result |
|---|------|--------|--------|
| 1 | MCP read | `CoreMem_read("core.md")` | □ |
| 2 | MCP write | `memory_write` create test entry → delete | □ |
| 3 | inbox round-trip | chat→code→chat via inbox_post/inbox_check | □ |
| 4 | share URL | `conversation_share` → view in browser | □ |
| 5 | admin UI | `https://<public-url>/admin.html` in browser | □ |
| 6 | OAuth re-auth | disconnect connector → reconnect | □ |

---

## Observation Period (3–7 Days After Switchover)

- Keep `docker-compose.yml.bak.*` files (instant rollback path)
- `docker-compose.parallel.yml` was for parallel testing; not used after switchover but kept for reference
- After 7 days without issues, archive `*.bak.*` files and mark as complete

---

## Technical Notes

### Port Configuration

| Component | Before | After |
|-----------|--------|-------|
| Python (memory) | :5002 (public) | :5003 (internal) |
| TS frontend (ts-proxy) | N/A | :5002 (public) |
| Reverse proxy / public URL | → :5002 | → :5002 (no change) |

**No changes needed to the Synology reverse proxy.** The public port remains :5002.

### Known Risks

1. **oauth_store.json concurrent writes**: TS and Python read-modify-write the same file. Race condition risk is extremely low unless OAuth token issuance is concentrated
2. **Legacy SSE (`/mcp/sse`, `/mcp/messages`)**: TS transparently forwards to Python. Current Claude.ai uses only `/mcp`, no impact
3. **Batch/digest endpoints**: Remain Python-direct on :5003. Operations from admin.html pass through TS → Python transparent proxy
