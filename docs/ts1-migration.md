# TS-1: TypeScript Migration Plan (Strangler Pattern)

*Written: 2026-07-13 / Rings 0–3 + transport pull-forward (part of rings 4/5) + MCP 2026-07-28 early RC implementation done*

## Approach

Instead of rewriting main.py (Flask, single file) in one go, **place a TypeScript
reverse proxy in front and move endpoints to TS one at a time** (strangler pattern).

- **The acceptance criterion is always the TS-0 characterization suite**
  (`tests/`, 53 tests). As long as `MIO_TS1=1 pytest tests/` passes, the stack
  counts as "the same server"
- Every stage is production-deployable (the proxy is transparent; external behavior
  is identical whether 0 or 53 endpoints have been migrated)
- Aborting mid-way costs nothing (remove the proxy and Python-only operation resumes)

## Current state (Rings 0–3 + transport pull-forward, as of 2026-07-14)

```
client → [ts/ TypeScript server] → [memory/app/main.py (Flask)]
           ├ /health                       … TS native
           ├ GET /api/memory/{index,tags,hsearch,<id>} … TS native
           ├ POST /api/memory              … TS native (create, ID minting)
           ├ PATCH/DELETE /api/memory/<id> … TS native (partial update, logical delete)
           ├ POST /api/memory/reindex      … TS native (index.json rebuild)
           ├ /api/inbox* (list/post/read/update/delete) … TS native
           ├ /api/coremem* (list/save/versioned read/merge/delete) … TS native
           ├ /api/conversations* (search/index/rebuild/fetch/annotations/
           │    share/view/rating)         … TS native (only digest forwarded)
           ├ /.well-known/oauth-*          … TS native
           ├ /oauth/{register,authorize,token} … TS native (PKCE, DCR)
           ├ /mcp transport layer          … TS native (dual-era:
           │    legacy = initialize/ping/notifications/SSE/sessions,
           │    modern = MCP 2026-07-28 stateless core (server/discover,
           │    subscriptions/listen, required-header validation,
           │    resultType/ttlMs injection); tools/* are forwarded to
           │    Python as raw JSON-RPC; friend sessions pass through entirely)
           └ everything else               … transparently proxied to Python
                 ※ tokens verified by TS are rewritten to API_TOKEN before
                   proxying (TS-issued OAuth tokens work on unmigrated endpoints)
```

- `ts/src/` — index.ts (router + proxy) / auth.ts (Bearer, ?token=, oauth_store.json) /
  data.ts (read layer over /data/ JSON) / write.ts (create/update/delete, oplog,
  index rebuild) / search.ts (hierarchical search, `_hierarchical_search`-compatible) /
  oauth.ts (OAuth 2.1 + DCR, oauth_store.json-compatible persistence) /
  mcp.ts (MCP transport layer) / inbox.ts / coremem.ts (symlink version management
  with copy fallback, Python-compatible) / conversations.ts (conversation REST,
  share_tokens.json-compatible)
- Zero dependencies (node:http only); SSE/chunked OK
- `MIO_TS1=1 pytest tests/` boots the two-tier stack → **all 100 tests pass**
  (direct mode: 85 pass + 15 skipped — the MCP 2026-07-28 characterization tests
  only run against the TS layer, where the new spec is implemented)
- Build: `cd ts && npm install && npx tsc` → `node dist/index.js`
- Env vars: `MIO_PORT` / `MIO_UPSTREAM_HOST` / `MIO_UPSTREAM_PORT` / `MIO_DATA_ROOT` /
  `MIO_API_TOKEN` / `MIO_BASE_URL` / `MIO_ALLOWED_ORIGINS`

**Ring-2 finding**: on local Windows, Python's text-mode writes translate `\n` → `\r\n`,
so index.json etc. come out CRLF (production Linux is LF). TS always writes LF
(production-compatible). Live verification confirmed the TS-rebuilt and Python-rebuilt
index.json are byte-identical after newline normalization — identical with no
normalization on production. The oplog format (create/update/delete, diff.before/after,
author) was also verified compatible.

**Ring-1 finding**: main.py has many `open()` calls without an explicit encoding —
utf-8 on Linux (production) but cp932 on local Windows. Tests now pin `PYTHONUTF8=1`
to match production. The TS implementation is utf-8 fixed (production-compatible).

## Ring plan (each ring = one commit; all tests green = done)

| Ring | Target | Decision points |
|---|---|---|
| 0 | Proxy skeleton + /health | ✅ done (2026-07-13) |
| 1 | Auth middleware + read-only REST (index/read/tags/hsearch) | ✅ done (2026-07-13) — auth.ts / data.ts / search.ts, unified search included; native-vs-proxy routing verified live via the Werkzeug Server header |
| 4/5 pull-forward | **MCP transport layer + OAuth/DCR** (mcp.ts / oauth.ts) | ✅ done (2026-07-14) — pulled forward because the breaking MCP 2026-07-28 spec (stateless core removing initialize/sessions + OAuth hardening) publishes July 28. tools/* dispatch stays forwarded to Python (migrates in ring 4 proper). Spec adaptation will touch ts/ only |
| New-spec RC | **MCP 2026-07-28 early RC implementation** (mcp.ts / oauth.ts revisions) | ✅ done (2026-07-14) — dual-era server (legacy initialize and modern stateless core coexist on the same endpoint per the spec's era-detection rules). server/discover, subscriptions/listen, required-header validation (-32020/-32022/-32601), resultType/ttlMs/cacheScope injection, OAuth hardening (iss / application_type / refresh_token / RFC 8414 suffix). 15 new characterization tests (TS1 mode only) → 100 pass in TS1 mode. Remaining task: diff against the official July 28 release |
| 2 | Write REST (create/patch/delete/reindex) | ✅ done (2026-07-14) — write.ts. ID minting (JST, tag slug), oplog, and index rebuild all verified Python-compatible live (byte-identical after newline normalization). In the test config REST writes = TS and MCP-driven writes = Python (forward target) coexist; both use the same algorithm so index/oplog converge |
| 3 | inbox / coremem / conversations REST | ✅ done (2026-07-14) — inbox.ts / coremem.ts / conversations.ts. 20 new REST characterization tests (inbox 5, coremem 7, conversations 8). Symlink version management: TS uses the same symlink→copy fallback; version numbering verified live to continue sequentially across implementations. The conversation _index.json rebuilt by TS is byte-identical to Python's. Share tokens and rating gating live-verified interoperable. Only digest (needs local LLM) stays forwarded to Python until ring 5 |
| 4 | MCP tools/list + tools/call native in TS | Tools should internally call the REST-equivalent functions (transport layer already pulled forward) |
| 5 | Import, batch, friend system, conversation digest | Batch/digest need an LLM client (Anthropic SDK / fetch); friend-session /mcp passthrough is also resolved here |
| 6 | Remove Python; Node-based Dockerfile | Decide after a parallel-run period + full test green |

## Design commitments

- **Data formats never change** — the JSON files and directory layout under `/data/`
  stay fully compatible with the Python version (both implementations must be able to
  read/write at any point)
- During any ring, migrated endpoints are served by TS; the rest are proxied to Python
- When migrating an endpoint, extend the characterization tests first if coverage is
  thin (see docs/api-contract.md §8)
- Dependency minimalism (target: zero runtime deps through ring 4; scrutinize after)

## Open questions (to discuss with Jun)

- When to start ring 1 (TS-0 / ring 0 only provide the decision material)
- When to deploy the front proxy in production (around rings 2–3 seems right)
- Node runtime image choice for the NAS Docker setup
