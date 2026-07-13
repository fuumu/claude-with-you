# TS-1: TypeScript Migration Plan (Strangler Pattern)

*Written: 2026-07-13 / Ring 0 implemented*

## Approach

Instead of rewriting main.py (Flask, single file) in one go, **place a TypeScript
reverse proxy in front and move endpoints to TS one at a time** (strangler pattern).

- **The acceptance criterion is always the TS-0 characterization suite**
  (`tests/`, 53 tests). As long as `MIO_TS1=1 pytest tests/` passes, the stack
  counts as "the same server"
- Every stage is production-deployable (the proxy is transparent; external behavior
  is identical whether 0 or 53 endpoints have been migrated)
- Aborting mid-way costs nothing (remove the proxy and Python-only operation resumes)

## Current state (Ring 0, completed 2026-07-13)

```
client → [ts/ TypeScript proxy] → [memory/app/main.py (Flask)]
           └ only /health answered natively (with served_by: "ts")
```

- `ts/src/index.ts` — zero-dependency (node:http) transparent proxy; SSE/chunked OK
- `MIO_TS1=1 pytest tests/` boots the two-tier stack → **all 53 tests pass**
- Build: `cd ts && npm install && npx tsc` → `node dist/index.js`
- Env vars: `MIO_PORT` (proxy) / `MIO_UPSTREAM_HOST` / `MIO_UPSTREAM_PORT`

## Ring plan (each ring = one commit; all tests green = done)

| Ring | Target | Decision points |
|---|---|---|
| 0 | Proxy skeleton + /health | ✅ done |
| 1 | Auth middleware + read-only REST (index/read/tags/hsearch) | File-I/O layer design (share the same JSON files as Python) |
| 2 | Write REST (write/upsert/patch/delete/reindex) | oplog / index-rebuild compat; exclusive-writer policy (**never both write**) |
| 3 | inbox / coremem / conversations REST | symlink version-management compat |
| 4 | MCP transport (initialize / tools list / call dispatch) | Tools should internally call the REST-equivalent functions |
| 5 | Import, batch, OAuth, friend system | Batch needs an LLM client (Anthropic SDK / fetch) |
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
