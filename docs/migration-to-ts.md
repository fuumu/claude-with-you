# MIO Server Full TypeScript Migration Plan

> **v4.0 note (2026-10-30):** this plan was carried out through TS-1 (rings 0–5) and TS-FULL (steps 1–8); since v4.0 the server is TypeScript only. See [ts1-migration.md](ts1-migration.md) and [ts-full-inventory.md](ts-full-inventory.md) for how it went. This document is the pre-migration investigation and plan.

*The Japanese version, `migration-to-ts.ja.md`, is the primary document. This file is its English counterpart.*

## 1. Current scale

### 1.1 Python side

| File | Lines | Notes |
|------|-------|-------|
| `memory/app/main.py` | 8,982 | Full-featured MIO server (single-file layout) |
| `scripts/generate_summary_layers.py` | 417 | Batch summary generation |
| `scripts/manage_llm_endpoints.py` | 237 | LLM endpoint management |
| 18 files under `tests/` | 2,923 | Whole test suite |
| **Python total** | **12,559** | |

### 1.2 TypeScript side (already implemented)

| File | Lines | Function |
|------|-------|----------|
| `ts/src/oauth.ts` | 414 | OAuth 2.1 + DCR (complete) |
| `ts/src/mcp.ts` | 583 | MCP transport (dual-era server) |
| `ts/src/conversations.ts` | 357 | conversations REST (except digest) |
| `ts/src/inbox.ts` | 349 | inbox REST |
| `ts/src/coremem.ts` | 377 | CoreMem REST |
| `ts/src/write.ts` | 172 | Data-write foundation |
| `ts/src/search.ts` | 186 | Search foundation |
| `ts/src/data.ts` | 89 | Data-access foundation |
| `ts/src/auth.ts` | 39 | Auth foundation |
| `ts/src/index.ts` | 319 | Entry point |
| **TS total** | **2,885** | Existing implementation |

### 1.3 To be migrated (not yet implemented)

```
Total to migrate: 12,559 - 2,885 = 9,674 lines
```

## 2. Already covered on the TS side (no migration needed)

As described in CLAUDE.md, the following are already implemented in TS:

- ✅ memory REST (read/write)
- ✅ inbox REST
- ✅ CoreMem REST (symlink versioning)
- ✅ conversations REST (except digest)
- ✅ OAuth 2.1 + DCR (Dynamic Client Registration)
- ✅ MCP transport (dual-era server)

## 3. Features to migrate

### 3.1 MCP tools (38)

| Category | Tools | Main contents | Estimate |
|----------|-------|---------------|----------|
| ExtMemory CRUD | 5 | memory_read_index, memory_read, memory_write, memory_upsert, memory_search | 1 day |
| CoreMem CRUD | 4 | CoreMem_save, CoreMem_read, CoreMem_list, CoreMem_delete | 1 day |
| Conversation ops | 4 | conversation_index, conversation_search, conversation_read, conversation_share | 1 day |
| Inbox ops | 5 | inbox_check, inbox_read, inbox_post, inbox_update, inbox_delete | 1 day |
| Album | 5 | album_save, album_read, album_list, album_share, album_delete | 1 day |
| Uploads | 4 | file_upload, file_read, file_list, file_delete | 0.5 day |
| Batch | 2 | batch_run_summary_layers, batch_run_rating | 1 day |
| Special | 5 | sublimate, attendance_view, log_annotate, memory_share, project_create | 1.5 days |
| Other | 2 | oplog_list, llm_status | 0.5 day |
| **Subtotal** | **38** | | **9 days** |

### 3.2 Batch processing

| Feature | Description | Estimate |
|---------|-------------|----------|
| Summary batch | Automatic summarization of conversation logs (uses LLM) | 1 day |
| Rating batch | Automatic rating judgment (safe/mature/adult) | 0.5 day |
| Nightly scheduler | Automatic batch run for unjudged logs | 0.5 day |
| **Subtotal** | | **2 days** |

### 3.3 LLM integration

| Feature | Description | Estimate |
|---------|-------------|----------|
| Multi-endpoint | Managing multiple endpoints such as LM Studio / FreeToken | 1 day |
| On-demand load | Automatic model load/unload | 1 day |
| Digest generation | LLM calls for conversation summaries | 0.5 day |
| Sublimation pipeline | Poetic transformation of mature expressions | 1 day |
| Auto rating | Automatic judgment of conversation logs | 0.5 day |
| **Subtotal** | | **4 days** |

### 3.4 Import features

| Feature | Description | Estimate |
|---------|-------------|----------|
| ZIP import | Claude Code / manual ZIP formats | 1 day |
| OpenWebUI import | OpenWebUI chat export JSON | 0.5 day |
| Unsloth import | Unsloth Desktop chat JSONL | 0.5 day |
| Backup/restore | CoreMem + ExtMemory ZIP | 1 day |
| **Subtotal** | | **3 days** |

### 3.5 Other features

| Feature | Description | Estimate |
|---------|-------------|----------|
| Friend system | Friend registration, approval, token auth | 1 day |
| Attendance ledger | Activity history merged from 5 layers | 0.5 day |
| Redact mode | Sentence-level masking of adult conversations | 0.5 day |
| Invitation system | SendGrid integration | 0.5 day |
| **Subtotal** | | **2.5 days** |

### 3.6 Tests

| Category | Files | Estimate |
|----------|-------|----------|
| Test rewrite | 18 files | 3–5 days |

## 4. Migration strategy

### 4.1 Recommended approach (Strangler pattern)

```
Day 1-3:   Integrate and refactor existing TS code
Day 4-10:  Implement MCP tools in TS (38)
Day 11-15: Port batch processing and LLM integration
Day 16-18: Port import features
Day 19-20: Friend system and other features
Day 21-25: Rewrite tests and integration testing
Day 26-28: Documentation update and verification
Day 29-30: Final check and production deploy
```

### 4.2 Migration order

```
Step 1: Integrate existing TS code (2-3 days)
  - oauth.ts, mcp.ts, conversations.ts, inbox.ts, coremem.ts
  - Unify the data-access foundation
  - Reorganize dependencies

Step 2: Implement MCP tools in TS (5-7 days)
  - memory CRUD (turn existing REST into MCP tools)
  - CoreMem CRUD
  - conversation ops
  - inbox ops
  - album
  - uploads

Step 3: Batch processing and LLM integration (3-5 days)
  - Summary batch
  - Rating batch
  - LLM endpoint management
  - Digest generation

Step 4: Import (2-3 days)
  - ZIP import
  - OpenWebUI import
  - Unsloth import
  - Backup/restore

Step 5: Friend system and others (2-3 days)
  - Friend registration, approval, token auth
  - Attendance ledger
  - Redact mode
  - Invitation system

Step 6: Rewrite tests (3-5 days)
  - Port existing tests to TS
  - Run integration tests

Step 7: Documentation and verification (2-3 days)
  - Update README.md
  - Update API documents
  - Prepare production deploy
```

## 5. Total estimate

| Phase | Estimate |
|-------|----------|
| Integrate and refactor existing TS code | 2–3 days |
| Implement MCP tools in TS | 5–7 days |
| Port batch processing and LLM integration | 3–5 days |
| Port import features | 2–3 days |
| Friend system and others | 2–3 days |
| Rewrite tests | 3–5 days |
| Documentation and verification | 2–3 days |
| **Total** | **20–30 days** |

## 6. Cautions

1. **The biggest bottleneck is that main.py is a single file**
   - A splitting strategy (module split by feature) is required
   - Dependencies between features must be sorted out

2. **CLAUDE.md documentation is very thorough**
   - Porting to TS should be relatively easy
   - Existing documentation can be reused

3. **Double-implementation period with existing TS code**
   - A gradual migration with the Strangler pattern is needed
   - Account for the parallel-running period until migration completes

4. **Tests are black-box (over HTTP)**
   - The design already lets the same suite run against the TS side
   - `MIO_TS1=1` runs against the TS side

5. **Shared data layer**
   - Shared `oauth_store.json` issue (a known bug at 2025-10-03)
   - The data-access layer needs to be unified

## 7. Benefits after migration

- Performance improvement (Node.js non-I/O performance)
- Better type safety
- Affinity with the TypeScript ecosystem
- Full use of the existing TS code
