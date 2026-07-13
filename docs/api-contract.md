# API Contract Document (TS-0)

*Target: mio-memory v3.61 / Written: 2026-07-13*

This document pins down the externally promised behavior (the contract) of the current
`memory/app/main.py`. **The executable contract is the characterization test suite in
`tests/`** — this document is its map. For TS-1 (the TypeScript migration), the suite
passing green is the criterion for "this is the same server."

## Running the test suite

```powershell
# First time only: create venv and install deps
python -m venv .venv
.venv/Scripts/python -m pip install flask pytest requests pillow

# Run (the server auto-starts on a temp data dir; existing environments are untouched)
.venv/Scripts/python -m pytest tests/ -q
```

The tests are **black-box over HTTP** and never import `main.py` internals.
Swapping the server implementation (e.g. a TS port) only requires changing the launch
command in `tests/conftest.py`.

**Test hooks (unset in production = legacy behavior):**

| Env var | Purpose |
|---|---|
| `MIO_DATA_ROOT` | Override the data root (default `/data`) |
| `MIO_PORT` | Listen port (default `5002`) |

---

## 1. Common contract

### Authentication

- REST / MCP both use Bearer tokens: `Authorization: Bearer <token>`
- Valid tokens: ① `MIO_API_TOKEN` ② OAuth access tokens (30 days, persisted in `oauth_store.json`)
- **Fallback**: `?token=<token>` query parameter also authenticates (for `<img>`/`<a>` tags)
- Auth failure → **401**
- No auth required: `/health`, OAuth discovery/flow, `/api/share/<token>`,
  `/api/album/shared/<token>`, `/register`, `/activate`

### Common response shapes

- MCP tool results that are dicts always carry `server_time` (JST ISO 8601) and `server_version`
- MCP tool results that are lists are wrapped as `{"data": [...], "server_time": ..., "server_version": ...}`
- Tool-level errors return HTTP 200 with `{"error": "..."}` (not a JSON-RPC error)

### ID formats

| Kind | Format | Example |
|---|---|---|
| ExtMemory entry | `YYYYMMDD_HHMMSS_<first-tag>` | `20260713_194909_ts0` |
| Conversation (LogStore) | claude.ai UUID / Code session id | `0050e3a7-...` |
| inbox | `inbox_YYYYMMDD_HHMMSS_<hex8>` | `inbox_20260713_150648_5c786bed` |
| Uploads | `YYYYMMDD_HHMMSS_<first 30 chars of filename>` | `20260713_160000_report` |
| ZIP-derived entry | `YYYYMMDD_HHMMSS_<seq4>_<uuid8>` | `20260713_152622_0487_0050e3a7` |

---

## 2. Health / OAuth

| Method | Path | Contract |
|---|---|---|
| GET | `/health` | 200 `{status:"ok", version, mcp_tool_count}`, no auth |
| GET | `/.well-known/oauth-authorization-server` | issuer / authorization_endpoint / token_endpoint / registration_endpoint; `code_challenge_methods_supported` includes S256 |
| POST | `/oauth/register` | Dynamic Client Registration |
| GET/POST | `/oauth/authorize` `/oauth/token` | PKCE (S256/plain) required. Auth codes 10 min, access tokens 30 days |

## 3. ExtMemory REST (`/api/memory`)

| Method | Path | Contract |
|---|---|---|
| GET | `/api/memory/index` | index array (deleted excluded; local_only/adult excluded; `?include_local` `?include_adult` `?random=N` `?filter=summarized`) |
| GET | `/api/memory/<id>` | Full entry. **Readable after soft-delete with deleted:true** (no rating gate) |
| POST | `/api/memory` | 201. Server-assigned ID. Accepts `source_thread` |
| PATCH | `/api/memory/<id>` | Only title / body / tags / source_thread / importance / keywords are updatable |
| DELETE | `/api/memory/<id>` | Soft delete (deleted=true; removed from index) |
| GET | `/api/memory/search?q=` | Full-text search (entry array incl. body) |
| GET | `/api/memory/hsearch?q=` | Hierarchical search: `results[]{id,title,tags,keywords,match_layer,summary,symbolic,source_thread,...}` + `total` + `has_more`. `?include_conversations=true` adds `conversations[]` + `conversations_total` (v3.61) |
| GET | `/api/memory/tags` | tag → count map |
| POST | `/api/memory/reindex` | Rebuild index.json |
| POST | `/api/memory/share/<id>` | Issue share token |
| GET | `/api/share/<token>` | Entry without auth (24h expiry) |
| GET | `/api/export` | ZIP of CoreMem + ExtMemory |

## 4. MCP transport (`/mcp`)

- `POST /mcp` — JSON-RPC 2.0; single and batch (array) requests
- No id (notification) → **202 Accepted** (empty body)
- If `Accept` includes `text/event-stream`, the response is SSE (`event: message` + `data: <json>`); otherwise `application/json`
- `initialize` → `result.serverInfo` / `result.instructions` (includes the CoreMem_read("core.md") prompt) / issues `Mcp-Session-Id` header
- `tools/list` → **31 tools** for regular sessions
- `tools/call` → `result.content[0] = {type:"text", text:"<JSON string>"}`; image tools use `_mcp_content` (type:"image", base64)
- `ping` → `{}`
- Unknown method → JSON-RPC error `-32601`
- Friend tokens (`/mcp?token=<friend_token>`) expose a separate 4-tool set

## 5. MCP tools (31): response shapes (essentials)

For argument details see README.md / CoreMem `protocol_guide_detail.md`. Below are the
response shapes pinned by tests.

| Tool | Response contract |
|---|---|
| `memory_read_index` | list → `{data:[{id,title,tags,created_at,importance,keywords?,symbolic?,rating?,local_only?}]}`; `random=N` (clamped 1–5) |
| `memory_read` | Full entry dict; unknown id → `{error}` |
| `memory_write` | Created entry dict (assert `id`); accepts `rating`/`local_only` |
| `memory_upsert` | Upsert by fixed id; created dict |
| `memory_search` | `{results[], total, has_more}`; no body by default (`summary`+`symbolic`+`match_layer`); `full_body=true` for body; `include_conversations=true` adds `conversations[]`+`conversations_total` (v3.61) |
| `memory_share` | `{token, url(admin.html?token=..&id=..), expires_at}` |
| `CoreMem_save` | `{name, version, version_str}`; `mode="append"` appends with `<!-- APPEND datetime -->` separator |
| `CoreMem_read` | `{name, version, content}`; with manifest: `merged:true` + `<!-- BEGIN/END: file -->` separators + `manifest` map |
| `CoreMem_list` | list → `{data:[{name,version,updated_at}]}`; `__del__` prefix excluded |
| `CoreMem_delete` | `{deleted}` / rename: `{renamed,src,dst}` |
| `conversation_index` | `{total, offset, limit, items[]}` |
| `conversation_search` | list → `{data:[{uuid,title,created_at,updated_at,message_count}]}`; title match only; date range supported |
| `conversation_read` | Body dict; `turn_offset` (negative = from tail) / `turn_limit`; `include_annotations=true` adds annotations + `[No.X]`; **adult conversations never return raw text by default** (`include_raw=true` for raw) |
| `log_annotate` | The appended annotation (seq starts at 1); no edit/delete API |
| `inbox_check` | `{count, ids, non_persistent_unread_count, non_persistent_unread_ids, persistent[] (with bodies)}`; `limit/days/from_model/to_model` filters |
| `inbox_read` | Message dict (marks read); `peek=true` does not mark read (v3.60); persistent never gets marked |
| `inbox_post` | Created message dict; `from_model`/`to_model` normalized string→array |
| `inbox_update` | Partially updated dict (unspecified fields kept) |
| `inbox_delete` | Physical delete |
| `batch_run_summary_layers` | `status_only=true` → `{running,total,processed,errors,skipped,raw_pending,keywords_pending}` |
| `album_*` / `file_*` | Same metadata shapes as REST; `album_read` returns MCP image content |

## 6. Import (includes the v3.60 contract)

| Method | Path | Contract |
|---|---|---|
| POST | `/import` | claude.ai export ZIP. `{imported, skipped, conversations_saved, artifacts_extracted, source_threads_linked}` |
| POST | `/api/import/claude-code` | Single `.jsonl` / `.zip`. `{imported, skipped, errors, conversations_saved, source_threads_linked}` |

**Dedup (v3.60 root fix):**
- Re-importing the same conversation is skipped (no ExtMemory entry duplication)
- The check is the OR of `imported_uuids.json` **and** the set of existing entries'
  `source_thread`. **Dedup holds even when imported_uuids.json is missing**
  (pinned by `test_zip_reimport_dedup_survives_missing_import_log`)
- `overwrite=true` bypasses dedup and recreates (not for normal operation)

**Automatic source_thread linking (v3.60):**
- Conversation bodies are scanned for `memory_id: <ID>` → the entry's empty
  `source_thread` is set to the conversation UUID
- Supplementary: timestamp matching only when the entry's created_at falls within
  **exactly one** imported conversation's range
- Existing source_thread values are **never overwritten**
- Conversation saving (`_save_conversations`) always runs independently of dedup
  (including rating carry-over)

## 7. Other REST

| Group | Path | Essentials |
|---|---|---|
| conversations | `/api/conversations/*` | index / rebuild / rating PATCH (400 unless safe/mature/adult) |
| coremem | `/api/coremem/<name>` | Manifest-merged; `?raw=true` bypasses |
| inbox | `/api/inbox*` | GET list / POST / PATCH read・unread / PATCH partial update / DELETE |
| album | `/api/album/*` | list / image / upload / PATCH meta / DELETE / share (shared image needs no auth) |
| uploads | `/api/uploads/*` | list / download / POST (201; tags split on commas, Japanese commas, whitespace) / DELETE (404 if missing) |
| batch | `/api/batch/status` `/api/batch/start` | status dict / background start |
| import-status | `/api/import-status` | Last ZIP import record |
| friends | `/api/friends*` `/register` `/activate` | Friend system (untested — SendGrid dependent) |

## 8. Known uncovered areas (as of v3.62)

- Friend system (register → approve → activate → friend MCP session)
- Actual generation by `conversation_digest` / summary batch (local-LLM dependent; only status shapes pinned)
- `album_save(url=...)` external download / HTML image extraction
- Legacy `/mcp/sse` / `/mcp/messages`

Add these before executing TS-1 as needed.

**Covered since v3.62** (tests/test_oauth_mcp_transport.py, 12 tests): the full OAuth
flow (register → authorize → token → issued token used on REST/MCP; PKCE S256
verification; rejection of bad verifier / password / grant) and the MCP transport
(Mcp-Session-Id header on initialize, SSE response for `Accept: text/event-stream`,
DELETE, GET without SSE accept = 405, parse error, batches, 401 auth).
Note: v3.62 fixed a main.py bug where initialize never issued the `Mcp-Session-Id`
header and leaked the internal `_session_id` key — behavior now matches §3.
