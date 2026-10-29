# TS-FULL prep: inventory of what Python still owns

*2026-10-29 / as of v3.99 (commit 34e84d1). Investigation only — no code changes. Japanese version (`ts-full-inventory.ja.md`) is authoritative.*

> **Progress (2026-10-29)**: items 1 (remove runtime Python dependency) and 2 (test harness) of the summary are done in `ts-full-step1`. Dropped: legacy SSE (removed), legacy path-token API, `/api/memories/symbolic`. To port: dedup-scan, cleanup-empty ×2 (handled with admin REST in item 4).
> **Progress (2026-10-30)**: item 3 (imports) is done in `ts-full-step3` — the six import routes, `index/rebuild`, conversation `cleanup-empty`, title change and `conv-artifacts`. The TS conversation REST also caught up with main.py (AND search, individual, hidden, oplog).
> **Progress (2026-10-30)**: item 4 (admin REST) is done in `ts-full-step4` — old search, dedup-scan, cleanup-empty, oplog, share tokens, projects, attendance, export/backup. The legacy path-token API and symbolic were removed from both servers. A Python/TS REST differential test also caught lag in already-ported routes (hsearch, body_length, manifest guard), now fixed.
> **Progress (2026-10-30)**: item 5 (album / uploads REST) is done in `ts-full-step5`.
> **Progress (2026-10-30)**: item 6 (friend REST, serving the five HTML pages) is done in `ts-full-step6`.
> **Progress (2026-10-30)**: item 7 (nightly scheduler, redaction generation) is done in `ts-full-step7`. Only item 8 (seed, compose, retiring Python) is left.

Premise: after TS-1, all 38 MCP tools are TS-native (no handler in `tools.ts` returns `FORWARD`).
However, the TS front (`ts/src/index.ts`) transparently forwards **everything it does not handle** to Python,
so **many REST routes, the HTML pages, and background jobs are still served by Python**.

Legend: ✅ TS native / ⚠️ partial or depends on Python / ❌ Python only

---

## 1. main.py endpoints

### 1-1. Places where the TS front itself depends on Python (breaks first under TS-only)

| Feature | Python today | TS status | Work needed for TS-only |
|---------|--------------|-----------|-------------------------|
| `GET /health` | returns VERSION, tool count, etc. | ⚠️ `index.ts` **fetches Python's /health, caches it** and adds `served_by: ts`; 503 when Python is down | Keep VERSION in TS and build /health locally |
| `server_version` (every tool response) | `VERSION` constant | ⚠️ `mcp.ts upstreamVersion()` reads it from Python /health | Same (VERSION in TS) |
| Tool definitions (tools/list) | `_MCP_TOOLS` (source of truth) | ⚠️ `tool-defs.ts` / `friend-defs.ts` are **generated from main.py via ast** by `scripts/gen_ts_tool_defs.py` | Move the source of truth into TS |
| Unknown MCP methods | `_process_mcp_message` | ⚠️ anything other than `initialize`/`ping`/notifications/`tools/*` (e.g. resources/list) is forwarded | Answer in TS (-32601 etc.) |
| `/mcp/sse`, `/mcp/messages` (legacy SSE) | implemented | ❌ forwarded | Drop or port (Claude.ai uses `/mcp` only) |
| `/mcp` friend sessions | `_handle_friend_tool_call` | ✅ `friend.ts` | — |

### 1-2. REST already ported

| Routes | TS |
|--------|----|
| `GET /api/memory/index` `/tags` `/hsearch` `/<id>` | ✅ |
| `POST /api/memory`, `POST /api/memory/reindex`, `PATCH/DELETE /api/memory/<id>` | ✅ |
| All of `/api/inbox` | ✅ (incl. 【生】 sublimation pipeline) |
| All of `/api/coremem` | ✅ |
| `GET /api/conversations/` (search), `/index`, `/<uuid>`, `/<uuid>/annotations`, `GET /api/conversations/view` (public), `POST /share/<uuid>`, `PATCH /<uuid>/rating` | ✅ |
| `POST /api/conversations/<uuid>/digest`, `/api/batch/status|start`, `/api/rating-batch/status|start`, `/api/llm-status` | ✅ (`rest-llm.ts`) |
| OAuth: `.well-known/*`, `/oauth/register`, `/oauth/authorize` (GET/POST), `/oauth/token` | ✅ |

### 1-3. REST not yet ported (Python only)

| Feature | Routes | Used by | Work needed |
|---------|--------|---------|-------------|
| **Conversation import** | `POST /import` (ZIP), `/api/import/claude-code`, `/openwebui`, `/unsloth`, `/compare`, `GET /api/import-status` | admin.html Import tab, **many test fixtures** | 4 converters + ingest (`_save_conversations`, `_link_source_threads`, title auto-improve, `extract_artifacts`, batch auto-start). **Largest chunk** (~1200 lines around main.py 3427–4660) |
| Conversation index rebuild | `POST /api/conversations/index/rebuild` | admin.html | model/participants backfill, title improvement, JSON write-back |
| Conversation title | `PATCH /api/conversations/<uuid>/title` | admin.html | update conv JSON, _index and ExtMemory |
| Empty cleanup | `POST /api/conversations/cleanup-empty`, `POST /api/memory/cleanup-empty` | admin (manual) | port or drop |
| Redaction | `POST /<uuid>/redact`, `GET /<uuid>/redacted`, `/redact/approve`, `/redact/reject`, `GET /api/conversations/redact-status` | admin.html Redact tab | LLM generation (`_generate_redacted`) + approval flow. Reading approved redactions in `conversation_read` is already TS |
| Conversation artifacts | `GET /api/conv-artifacts`, `/api/conv-artifacts/<uuid>/<file>` | admin.html, logs.html | list/serve (extraction happens at import) |
| Backup | `GET /api/export` (ZIP), `POST /api/import/backup` | admin.html | ZIP create/extract (needs a Node zip library) |
| Legacy keyword search | `GET /api/memory/search` | **admin.html and logs.html use it** | port, or switch pages to `hsearch` |
| Symbolic list | `GET /api/memories/symbolic` | unknown (external script?) | confirm usage, port or drop |
| Dedup scan | `POST /api/memory/dedup-scan` | manual | same |
| Path-embedded token (legacy) | `/api/<token>/memory/index` `/search` `/<id>`, `POST /api/<token>/memory` | old clients | decide on removal (ask Jun) |
| oplog | `GET /api/oplog`, `DELETE /api/oplog/<i>` | admin.html | simple (MCP `oplog_list` already TS) |
| Share tokens | `POST /api/share-token`, `POST /api/memory/share/<id>`, `GET /api/share/<token>` (public) | admin.html | simple (MCP `memory_share` already TS) |
| Project list | `GET /api/projects` | admin.html | simple (MCP `project_list` already TS) |
| Attendance | `GET /api/attendance` | admin.html | thin wrapper over `attendance-view.ts` |
| Album REST | `GET /api/album/`, `GET /<id>`, `POST /upload`, `PATCH /<id>`, `DELETE /<id>`, `POST /<id>/share`, `GET /shared/<token>` (public) | admin.html Album tab | resize can reuse `album-save.ts` (sharp); needs multipart parsing |
| Uploads REST | `GET/POST /api/uploads`, `GET/DELETE /api/uploads/<id>` | admin.html Uploads tab | multipart + download serving |
| Friends REST | `POST /api/friends/register`, `GET /api/friends`, `/approve`, `/send_email` (SendGrid), `/direct_register`, `/revoke`, `DELETE /<seq>`, `GET /invitation`, `POST /activate` | admin.html, register.html, activate.html | registration → approval → email (SENDGRID_*). Friend MCP sessions already TS |

## 2. Admin pages (HTML) and their API dependencies

| Page | Served by | Unported APIs it calls |
|------|-----------|------------------------|
| `admin.html` | ❌ Python | all import routes, export/backup, redact-status, index/rebuild, album/uploads/friends, oplog, share-token, `/api/share/`, projects, attendance, conv-artifacts, **`/api/memory/search`** |
| `logs.html` | ❌ Python | **`/api/memory/search`**, conv-artifacts |
| `share.html` | ❌ Python | none (`/api/conversations/view` is TS) |
| `register.html`, `activate.html` | ❌ Python | `/api/friends/register`, `/invitation`, `/activate` |

→ TS-only needs **static file serving** for these 5 pages (bundle `memory/app/*.html` into the TS image) plus the APIs above.

## 3. Batch jobs

| Job | Python | TS | Work needed |
|-----|--------|----|-------------|
| Summary layers (2/3/4) | `_run_summary_batch` | ✅ `llm-tasks.ts` | — |
| Rating | `_run_rating_batch` | ✅ | — |
| conversation_digest generation | ✅ | ✅ | — |
| sublimate / inbox 【生】 auto-sublimation | ✅ | ✅ | — |
| **Nightly scheduler** | `_nightly_batch_loop` (startup thread, `MIO_NIGHTLY_BATCH_HOUR`/`_BACKEND`) | ❌ | daily timer in TS |
| **Batch auto-start after import** | ✅ (`MIO_IMPORT_AUTO_BATCH`) | ❌ (import not ported) | with import |
| Redaction generation | `_generate_redacted` | ❌ | see redaction above |
| External script | `scripts/generate_summary_layers.py` (runs outside the server via REST) | — | should keep working under TS-only; can stay Python |

⚠️ **Current caveat (known dual-run risk):** batch state lives in each process's memory. With the TS front, MCP/REST-triggered batches run in TS while nightly and post-import batches run in Python, so **the same batch can run twice** (as noted in ts1-migration Ring 5).

## 4. LLM split

| Feature | Python | TS |
|---------|--------|----|
| LLM client (`LLM_ENDPOINTS` discovery, OK-model selection, LM Studio load/unload, anthropic backend) | `_lm_client` etc. | ✅ `llm.ts` (same logic, Anthropic Messages compatible) |
| `llm_status` (MCP & REST) | ✅ | ✅ (but the LLM log buffer is **per process** — Python's nightly batch logs don't show in TS `llm_status`) |
| REST-LLM (`rest-llm.ts`) | — | ✅ digest / batch / rating-batch / llm-status |
| Redaction generation | ✅ | ❌ |

→ The only LLM pieces left are **redaction generation and the nightly scheduler**.

## 5. Test suite

All tests are **black-box HTTP** (never import main.py). `conftest.py` always launches `main.py`, and only with `MIO_TS1=1` puts the TS front in front of it.

| Group | Files | Under TS-only |
|-------|-------|---------------|
| Harness | `conftest.py` (Python launch is mandatory) | **add a TS standalone mode** (no upstream); MockLLM can stay |
| Python-anchored check | `test_mcp_core.py::test_ts_tool_defs_snapshot_matches_python` | delete/rewrite once definitions live in TS |
| TS-only tests | `test_mcp_2026.py` (17), `test_ts_native_complete.py` (2) — only under `MIO_TS1=1` | keep |
| **Use unported APIs as fixtures/assertions** | `POST /import`: test_attendance_sublimate / test_conversation_tools / test_conversations_rest / test_import_conversations / test_llm_native / test_mcp_core / test_rating_visibility. `/api/import/*`, `/api/export`: test_backup_restore / test_import_conversations / test_uploads_album_misc. `index/rebuild`: test_conversations_rest / test_rating_visibility. redact: test_conversation_tools / test_conversations_rest. `/api/album`, `/api/uploads`: test_ring4_misc_tools / test_uploads_album_misc. `/api/oplog`: test_attendance_sublimate / test_llm_native. `/api/attendance`: test_attendance_sublimate. `/api/share/`, `admin.html`: test_mcp_core / test_inbox_rest. `dedup`: test_import_conversations | port import first, or change fixtures to write data directly. **Import underpins the conversation tests, so it comes first** |
| Everything else | test_coremem / test_coremem_rest / test_inbox / test_inbox_rest (except admin.html) / test_inbox_ttl / test_health_auth / test_oauth_mcp_transport / test_path_traversal etc. | expected to pass on TS alone (harness change only) |

Test count (reference): ~236 (`def test_` occurrences).

## 6. Other Python-only pieces

| Feature | Python | Work needed |
|---------|--------|-------------|
| Startup seeding | `_seed_coremem_if_empty` (`memory/skeleton/coremem`, `MIO_SEED_LANG`), `_seed_welcome_inbox` (`MIO_SEED_WELCOME`) | only matters on fresh installs; port (bundle skeleton into the TS image) |
| Uploads legacy-meta migration | startup `_uploads_migrate_all` | TS already runs `migrateAllMeta()` before `file_list` etc.; startup version likely unnecessary |
| Access log | `_log_mcp_access` (client classification, `MIO_LOG_LEVEL`) | TS only logs LLM; port if needed |
| Friend approval email | SendGrid (`SENDGRID_API_KEY`/`_FROM_EMAIL`), `MIO_REGISTER_URL` | with friends REST |
| Docker | `docker-compose.yml` has **only Python (memory)**; TS is fronted via `docker-compose.parallel.yml` / the ts-switchover runbook | TS-only compose, swap the `memory` service to the Node image; check whether the `./scripts` mount is still needed |
| Python packages | flask / anthropic / Pillow (`memory/wheels`) | move to the archive branch |

---

## Summary: work chunks for TS-only (suggested order splits)

1. **Remove runtime Python dependency (small):** /health and server_version in TS, tool-definition source of truth in TS, unknown MCP methods, decide on legacy SSE. **This alone makes MCP fully work even if Python is down.**
2. **Test harness:** TS standalone mode in conftest
3. **Import suite (large):** ZIP / Claude Code / OpenWebUI / Unsloth / compare / import-status + index/rebuild, title, conv-artifacts, post-import batch start
4. **Admin REST (medium, mostly simple):** oplog, share-token, `/api/share/`, projects, attendance, `/api/memory/search`, symbolic, dedup, cleanup-empty ×2, export/backup
5. **Binary REST (medium):** album REST, uploads REST (multipart)
6. **Friends REST + email (medium)**, static serving of the 5 HTML pages
7. **Nightly scheduler, redaction generation (medium, LLM)**
8. **Startup seeding**, compose swap, move Python to the archive branch

Needs Jun's decision: port or drop — legacy path-token API, legacy SSE, `/api/memories/symbolic`, dedup-scan, cleanup-empty.
