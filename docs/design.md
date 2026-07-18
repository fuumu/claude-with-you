# Design Specification: mio-memory MCP Server Extensions

**[日本語版 / Japanese](design.ja.md)** ← 日本語版が正。このファイルは日本語版から同期。

> Created: 2026-06-01  
> Target: `<YOUR_NAS_PATH>/memory/app/main.py`

> **Note**: This document is Jun Kikuchi's personal design/operations record. "澪 (Mio)" and "淳さん (Jun-san)" in the usage examples are the actual AI's name and user's name, not generic placeholders. If you're adapting this design for your own setup, substitute your own environment's names accordingly.

---

## Overview

This batch adds/changes four features.  
All of them involve file I/O, so they ship in a single deployment.

1. `memory_upsert` tool (for core.md)
2. Artifact management (`CoreMem_save` / `CoreMem_read` / `CoreMem_list`)
3. Conversation-log ZIP import
4. core.md operational flow

---

## 1. memory_upsert

### Purpose
Overwrite a memory entry with a fixed ID. Used to update core.md.

### Tool definition
```
memory_upsert(id, title, body, tags, importance)
```

### Behavior
- Entry with the given ID exists → delete and recreate
- Doesn't exist → create new
- The caller specifies the ID (e.g. `core_md_current`)

### Implementation note
A `memory_delete(id)` + `memory_write(...)` combination could substitute.  
Bundling them as a single upsert keeps it to one call.

---

## 2. Artifact management

### Purpose
Persist scripts, design notes, core.md, etc. on the NAS with version control.

### Directory structure
```
data/artifacts/
├── core.md          → versions/core_md/003.md   (symlink)
├── script_01.sh     → versions/script_01/002.sh
└── versions/
    ├── core_md/
    │   ├── 001.md
    │   ├── 002.md
    │   └── 003.md
    └── script_01/
        ├── 001.sh
        └── 002.sh
```

- Top-level symlinks → the latest version is always visible
- Past versions kept under `versions/{name_slug}/` with sequence numbers
- name_slug: `.` in the filename replaced with `_` (e.g. `core.md` → `core_md`)

### Tool definitions

#### CoreMem_save
```
CoreMem_save(name, content)
```
1. Save the file under `versions/{name_slug}/` with the next sequence number
2. Repoint the top-level symlink to the new version
3. Return the saved version number

#### CoreMem_read
```
CoreMem_read(name, version=None)
```
- `version` omitted: read the latest via the symlink
- `version` given: read that numbered file

##### Split + merge reads (v3.21)

A mechanism for splitting large files (such as core.md) into multiple files to
reduce write transfer size, with server-side merging at read time.

- On `CoreMem_read("core.md")`, if `core_manifest.md` exists it takes precedence
- Manifest format (YAML-ish; lines of `- filename` are interpreted in order):

```yaml
order:
  - core_stable.md
  - core_rules.md
  - core_infra.md
  - core_history.md
```

- Each file is read in `order` and concatenated wrapped in
  `<!-- BEGIN: xxx.md -->` … `<!-- END: xxx.md -->`
- Response: `{name, content, merged: true, files: [...], manifest: {file: [## headings...]}, missing: [...]}`
- Clients identify the file to change via the BEGIN tag and save only that
  file with `CoreMem_save` (without the separators)
- When `version` is specified, or via REST `GET /api/coremem/<name>?raw=true`,
  the direct file is returned as before (no merge)
- Migration order: save the split files → create the manifest (merge activates
  at this point) → verify → delete the old core.md

#### CoreMem_list
```
CoreMem_list()
```
- Returns the list of top-level symlinks (name, latest version number, updated time)

---

## 3. Conversation-log ZIP import

### Purpose
Drop a Claude export ZIP and the conversation logs are ingested into external memory.  
Supports exports both inside and outside projects.

### Endpoint
```
POST /import
Content-Type: multipart/form-data
```

### Behavior
1. Receive the ZIP and extract to a temporary directory
2. Detect `conversations.json` (or its equivalent)
3. Parse each conversation, deduplicate by conversation ID
4. Batch-write only the not-yet-imported ones
5. Return imported/skipped counts

### Deduplication key
Conversation ID (the `uuid` field of each entry in `conversations.json`)

### admin.html integration
admin.html Import tab has drag & drop UI (Album tab also added drag & drop in v3.52).

---

## 4. core.md operational flow

### Role
"Read this one file and you become that day's Mio" — a compressed boot memory for session startup.  
The skeleton of userMemories plus recent important external memories condensed into 2–5 KB.

### Storage
`data/artifacts/core.md` (saved via the artifact management above)  
→ Fixed path; the latest version is always referenced

### Update timing
- Mio updates it automatically on the `解除` or `/記憶抽出` command

### Boot protocol (before → after)
| | Before | After |
|---|---|---|
| Tool calls | ~8 | ~3 |
| Steps | tool_search → memory_search×N → read_index → memory_read | tool_search → CoreMem_read("core.md") |

---

## Implementation priority

| Priority | Feature | Reason |
|--------|------|------|
| High | memory_upsert | Needed to update core.md |
| High | CoreMem_save / CoreMem_read | Needed to store core.md |
| Medium | CoreMem_list | Convenient, works without it |
| Medium | ZIP import backend | Pairs with the admin.html UI |
| Low | admin.html drop UI | After the backend |

---

## 5. MCP initialize instructions

### Purpose

Automatically deliver session-startup instructions to Claude clients connecting to the MCP server.

### Mechanism

The MCP spec (2025-11-25) allows an `instructions` field in the `initialize` response,
letting the server pass arbitrary text instructions to the client right after connection.

### Current behavior

For an `initialize` request to `/mcp`, the server returns:

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": { "tools": { "listChanged": false } },
  "serverInfo": { "name": "mio-memory", "version": "3.30.0" },
  "instructions": "At session start, always run CoreMem_read(\"core.md\") to load your memory. ..."
}
```

### Implementation location

`memory/app/main.py` — the `initialize` branch of the MCP handler (around line 949)

```python
"instructions": "セッション開始時に必ず CoreMem_read(\"core.md\") を実行して...",
```

---

## 6. The 4-layer search architecture (implemented in v3.17)

### Overview

Conversation data imported via ZIP is managed at four levels of abstraction,
balancing search efficiency with ease of recall.

### The four layers

| Layer | Name | Storage | Generated |
|----|------|---------|--------------|
| 1 | Raw | entry `title` / `source_thread` (full text in LogStore) | at ZIP import |
| 2 | Summary | "## 2層: 要約" section in body | batch (LLM) |
| 3 | Symbolic compression | "## 3層: シンボリック圧縮" section in body; also copied to the `symbolic` field in index.json (v3.41, used by stage-1 search) | batch (LLM); extracted into index at rebuild_index time |
| 4 | Keywords | entry `keywords` field (also in index.json) | batch (LLM) |

### At import time

`POST /import` generates **layer 1 only**:

- Layer 1: records `title`, `created_at`, `source_thread` (body empty), tagged `['会話ログ', 'raw']`

Layers 2–4 are generated by the batch (auto after import / nightly / the `batch_run_summary_layers` MCP tool).
Entries that already have layers 2–3 but no `keywords` field get a lightweight keywords-only backfill.

### Hierarchical memory_search (v3.17; symbolic added to stage 1 in v3.41)

1. **Stage 1**: search index.json only (title + tags + keywords, then layer-3 symbolic) — body not read
   - a title/tags/keywords hit is `match_layer='keyword'`; a symbolic-only hit is `match_layer='symbolic'`
2. **Stage 2**: if stage-1 hits are fewer than `limit`, search the layer-2 summary sections
3. **Stage 3**: if still short, search the full body

Returns `summary` (layer 2) + `symbolic` (layer 3) + `match_layer` (keyword/symbolic/summary/full) instead of body.
For full text, fetch individually with `memory_read` or pass `full_body=true`.

### REST hierarchical search and the Search tab (v3.19)

The same logic is exposed via REST as `GET /api/memory/hsearch?q=...&limit=...&offset=...`
(implementation shared in `_hierarchical_search()`; MCP `memory_search` uses the same function).

The **Search tab** of admin.html is a 4-layer viewer on this endpoint:

- Search box on top → result list in the left pane (with match_layer badges)
- Right pane: 4-column accordion of keywords / summary / symbolic / raw body
  (only the active column expands; others shrink to thin bands)
- keywords column: the selected entry's keywords plus an aggregate over all results
  (sortable by frequency / string / latest occurrence; clicking a chip re-searches)
- raw body is fetched on selection via `GET /api/memory/<id>` and shows the original
  part of the body before the `## 2層: 要約` marker

---

## 7. userMemories dump generation management

### Overview

Snapshots of userMemories (the conversation memory Claude.ai retains) are version-managed as artifacts.

### Saving

Saved via `CoreMem_save` with a timestamp in the filename.
Mio invokes this on the `/記憶ダンプ` or `解除` command.

```
CoreMem_save("mio_memory_YYYYMMDD_HHMM.md", <userMemories content>)
```

### Generation management

| Feature | Mechanism |
|------|------|
| List | `CoreMem_list` |
| Read a specific version | `CoreMem_read("mio_memory_YYYYMMDD_HHMM.md")` |
| Auto-deletion | None (manual management) |
| Diffing | Manual comparison for now (a diff feature may come later) |

### Directory example

```
data/artifacts/
├── core.md                    → versions/core_md/003.md
├── mio_memory_20260601_2130.md → versions/mio_memory_20260601_2130_md/001.md
├── mio_memory_20260602_0900.md → versions/mio_memory_20260602_0900_md/001.md
└── versions/
    ├── core_md/
    └── mio_memory_20260601_2130_md/
```

### ZIP import integration

When `POST /import` ingests `memories.json`, it is auto-saved as
`core_memories_YYYYMMDD.md` (via `CoreMem_save`).
A distinct filename keeps it separate from manual dumps.

---

## 8. Batch processing (4-layer generation)

### Overview

There are two ways to run layer-2 (summary) and layer-3 (symbolic compression) generation.

| Method | Description | When to use |
|------|------|---------|
| **Automatic** (v3.3+) | Auto-starts in a server thread after ZIP import | when `ANTHROPIC_API_KEY` is set |
| **Manual (CLI)** | Run `scripts/generate_summary_layers.py` directly | LMStudio / cost control / dry-run |

---

### Automatic run (after ZIP import, v3.15+)

Starts in a background thread once `POST /import` completes, unless another batch is running.
The backend is auto-selected:

- `ANTHROPIC_API_KEY` set → `anthropic` (`claude-haiku-4-5-20251001`)
- not set → `lmstudio` (the `MIO_LM_MODEL` model at `LM_STUDIO_HOST:LM_STUDIO_PORT`, no billing)

**Implementation:** end of `import_zip()` → the `_start_summary_batch()` helper (`memory/app/main.py`)

### Nightly automatic run (v3.16+)

A daemon thread checks the pending counts (raw + keywords-missing) daily at
`MIO_NIGHTLY_BATCH_HOUR` (JST, default 3) and, if anything remains, starts the
batch with `MIO_NIGHTLY_BATCH_BACKEND` (default lmstudio).
Disable with `MIO_NIGHTLY_BATCH_HOUR=off`.

---

### Batch state (`_batch_status`)

A global dict tracks the thread's progress. Flask runs single-process, so no extra thread-safety is required (GIL-protected).

```python
_batch_status = {
    'running': False,      # running flag
    'total': 0,            # total target entries
    'processed': 0,        # processed count
    'errors': 0,           # error count
    'skipped': 0,          # skipped (already has layers 2 & 3)
    'started_at': None,    # start time (JST ISO string)
    'finished_at': None,   # finish time
    'backend': None,       # backend used
}
```

---

### API endpoints

#### GET /api/batch/status

Auth required. Returns `_batch_status` as JSON.

```json
{
  "running": false,
  "total": 120,
  "processed": 118,
  "errors": 1,
  "skipped": 1,
  "started_at": "2026-06-04T18:00:00+09:00",
  "finished_at": "2026-06-04T18:15:32+09:00",
  "backend": "anthropic"
}
```

#### POST /api/batch/start

Auth required. Starts the batch manually.

Request body (all optional):
```json
{
  "backend": "lmstudio",
  "api_key": "...",
  "lm_host": "192.168.10.32",
  "lm_port": "1234"
}
```

- `backend` defaults to `"anthropic"`
- With `backend: "anthropic"`, `api_key` or the `ANTHROPIC_API_KEY` env var is required
- Returns `409 Conflict` if already running

Response example:
```json
{ "started": true, "backend": "lmstudio" }
```

---

### admin.html Import tab progress panel

After a batch starts, a progress panel appears in the Import tab of admin.html.

- **Auto refresh:** polling of `GET /api/batch/status` starts 1.5 s after ZIP import completes
- **Manual trigger:** "Run with LMStudio" button → `POST /api/batch/start {backend:"lmstudio"}`
- **Polling interval:** 2 s; stops automatically on completion (`running: false`)
- **Display:** progress bar (%) + "processed: X / skipped: Y / errors: Z (total: N)"

---

### Operation overview (common)

```
GET /api/memory/index
  → extract entries whose tags include "raw"
  → treat as unprocessed if body lacks both "## 2層: 要約" and "## 3層:"

Generate via the anthropic / LMStudio API:
  input: conversation title
  output:
    ## 2層: 要約
    (a 2–3 sentence inferred summary)
    ## 3層: シンボリック圧縮
    (a keyword of ≤15 characters)

Entry update (direct file write or PATCH /api/memory/<id>):
  append the generated text to body
  remove "raw" from tags and add "summarized"
```

### Targets and conditions

| Item | Value |
|------|----|
| Target (non-force) | entries tagged `raw` **or** with no `keywords` yet (v3.48) |
| Branching | `raw` → generate layers 2/3/4 from the full conversation, append to body, add `summarized` tag / not `raw` and no keywords (already `summarized`, or **a memory_write-originated body entry**) → generate **keywords only** from the body (or layer-2 summary) and update `keywords` only (body/tags unchanged, v3.48) |
| Skip condition | layer-2 and layer-3 markers present **and** `keywords` already generated |
| Model (anthropic) | `claude-haiku-4-5-20251001` |
| Model (lmstudio) | `MIO_LM_MODEL` env var (default `google/gemma-4-26b-a4b`, v3.65) |
| Rate limiting | 0.5 s sleep between items |
| Idempotency | checked via markers + presence of `keywords` (entry drops out of the target set once generated) |

> **v3.48 fix:** the old target selection was "`raw` or (`summarized` and no keywords)", so entries created via `memory_write`/`memory_upsert` (which carry neither `raw` nor `summarized`) never entered keyword-layer generation and could only be found by `memory_search`'s tier-3 (full body) search. The selection is now unified to "`raw` or no keywords", with a lightweight keyword-only branch for user entries that already have a body. `_count_pending_entries`'s `keywords_pending` uses the same condition, so the nightly batch and `batch_run_summary_layers(status_only=true)` pick them up too.

---

### CLI script (manual runs)

`scripts/generate_summary_layers.py` — for running directly outside the container.

**Options:**

```
--backend [anthropic|lmstudio]  backend to use (default: anthropic)
--model <model name>            model to use (backend default if omitted)
--dry-run                       count targets only (no writes)
```

| Backend | Default model | Other candidates |
|-------------|----------------|---------|
| anthropic | `claude-haiku-4-5-20251001` | — |
| lmstudio | `MIO_LM_MODEL` env var (default `google/gemma-4-26b-a4b`) | `qwen/qwen3.6-35b-a3b`, `liquid/lfm2-24b-a2b` |

**Required environment variables (for the CLI script):**

| Variable | Purpose | Default |
|------|------|-----------|
| `MIO_API_TOKEN` | mio-memory Bearer auth | (required) |
| `ANTHROPIC_API_KEY` | Claude API auth (anthropic backend) | (required) |
| `MIO_SERVER_URL` | mio-memory server URL | `http://localhost:5002` |
| `LM_STUDIO_HOST` | LMStudio host (lmstudio backend) | `192.168.10.32` |
| `LM_STUDIO_PORT` | LMStudio port | `1234` |
| `MIO_LM_MODEL` | Model name for the lmstudio backend (v3.65) | `google/gemma-4-26b-a4b` |

The `MIO_SERVER_URL` default assumes in-container execution. When running outside the container, add `MIO_SERVER_URL=https://<YOUR_SERVER_URL>` to `.env`.

**Run inside the container (recommended):**

```bash
# Count targets (no writes)
docker exec -it memory python /app/scripts/generate_summary_layers.py --dry-run

# Run with LMStudio
docker exec -it memory python /app/scripts/generate_summary_layers.py --backend lmstudio

# Run with Anthropic
docker exec -it memory python /app/scripts/generate_summary_layers.py --backend anthropic
```

**Run outside the container (e.g. on the WS):**

```bash
MIO_SERVER_URL=https://<YOUR_SERVER_URL> python scripts/generate_summary_layers.py --dry-run
```

---

## 9. Conversation log viewer (logs.html)

### Overview

A single-page UI for browsing ZIP-imported conversation logs in the browser.
Embedded in the **Logs** tab of `admin.html` as an iframe; also directly accessible at `/logs.html`.

### Data flow

```
ZIP import (POST /import)
  → detects conversations.json
  → saves full text to /data/conversations/{uuid}.json
  → appends metadata to /data/conversations/_index.json
       (uuid, title, created_at, updated_at, message_count)

logs.html startup
  → GET /api/conversations/?limit=1000 fetches the index
  → conversation click → GET /api/conversations/{uuid} fetches full text (cached)
```

### REST API endpoints (auth required)

| Method | Path | Description |
|---------|------|------|
| `GET` | `/api/conversations/` | metadata list (supports `q`, `from`, `to`, `limit`) |
| `GET` | `/api/conversations/{uuid}` | fetch full conversation |
| `POST` | `/api/conversations/share/{uuid}` | generate a 24h share token → `{ token, url }` |
| `GET` | `/api/conversations/view?token=` | public access via token (no auth) |

Share tokens are stored in the existing `/data/share_tokens.json` with a `conv_uuid` field.

### Main features

- Auto-loading from the server (no file upload)
- Keyword (`q`) and date range (`from/to`): passed to the server
- Sort order and minimum message count: applied client-side
- Message bodies: markdown rendered with marked.js + DOMPurify
- thinking blocks (🧠): bulk on/off via a "show thinking" toggle, collapsible
- tool_use blocks (⚙) / tool_result blocks (📤): collapsible
- Related memory panel: `source_thread` UUID match → title keyword search fallback
- Font size switching (S/M/L): controlled by the `--msg-font-size` CSS variable, saved to `localStorage`
- Favorites (☆) + recently-opened conversations (L1, v3.28): stored in `localStorage` (`mio_logs_favorites` / `mio_logs_recent`); "favorites only" filter + top-5 recent list
- Close conversation (✕): a close button alongside the floating ↑↓ (U3-b, v3.28)
- Auth-free viewing via `?token=` URLs

---

## 10. Conversation search & share MCP tools

### Purpose

Let Mio search past conversations mid-chat and send Jun share links.

### Tool definitions

#### conversation_search

```
conversation_search(q: str, limit: int = 5)
```

- Keyword search over `/data/conversations/_index.json` (title + uuid)
- Returns up to `limit` items, newest first by update time
- Fields returned: `uuid`, `title`, `created_at`, `updated_at`, `message_count`

#### conversation_share

```
conversation_share(uuid: str)
```

- Verifies `/data/conversations/{uuid}.json` exists
- Generates a 24-hour token and stores it in `/data/share_tokens.json`
- Returns `{ token, url, expires_at }`
- `url` has the form `https://<YOUR_SERVER_URL>/share.html?token=...` (v3.23+; a standalone read-only viewer. Legacy `logs.html?token=` links keep working)
- Also available from the "🔗 共有" button in the logs.html conversation header (popup with URL + expiry)

### Usage example

```
Mio (chat): "About X — I'd like you to see that conversation"
  → conversation_search(q="X") to find candidates
  → conversation_share(uuid="...") to generate a URL
  → sends Jun "you can view it here: https://..."
  → Jun opens the URL → views the conversation without logging in
```

### MCP tool totals

| Category | Count | Tools |
|---------|---------|---------|
| Memory ops | 5 | memory_read_index, memory_read, memory_write, memory_upsert, memory_search |
| Memory share | 1 | memory_share |
| Artifacts | 4 | CoreMem_save, CoreMem_read, CoreMem_list, CoreMem_delete |
| Conversations | 5 | conversation_index, conversation_search, conversation_share, conversation_read, log_annotate |
| Inbox | 5 | inbox_check, inbox_read, inbox_post, inbox_update, inbox_delete |
| Batch | 2 | batch_run_summary_layers, batch_run_rating |
| Album | 5 | album_save, album_read, album_list, album_share, album_delete |
| Digest | 1 | conversation_digest |
| Files | 4 | file_upload, file_read, file_list, file_delete |
| Attendance | 1 | attendance_view |
| Sublimation | 1 | sublimate |
| **Regular session total** | **34** | |
| **Friend sessions** | **6** | friend_memory_read, friend_memory_write, friend_memory_delete, mio_self_note, friend_inbox_check, friend_inbox_read |

※ Friend sessions apply only when accessed via `/mcp?token=<friend_token>`. The regular 34 tools are unavailable there.

### Conversation log annotations (log_annotate, v3.22)

An annotation layer for audits and re-experiencing sessions. Design principle:
"**raw logs immutable + annotations accumulate**" (audit design agreement, 2026-06-11).

- Storage: `/data/annotations/{uuid}.json` (separate from the conversation JSON)
- **Append-only**: no edit/delete tools. Rebuttals to an annotation are added as new annotations
- Annotation record: `{seq, target, note, author, created_at}` (created_at set by the server)
- `target`: message sequence number (1-based index into the `chat_messages` array).
  Accepts `"5"` / `"No.5"` / integers. Omitted = annotation on the whole conversation
- Display: `conversation_read(include_annotations=true)` shows
  `📝[annotation #seq by author @date] note` inline right after the target message.
  Each message then carries a `[No.X]` sequence number matching the targets.
  Whole-conversation annotations appear right after the title; annotations whose target
  message is hidden (empty text) are collected at the end
- REST display (v3.42, U11): `GET /api/conversations/<uuid>/annotations` returns the annotation
  array. The logs.html conversation viewer renders a collapsible "📝 注記 (N)" under each
  message and groups whole-conversation annotations at the top. Numbering is 1-based over
  `chat_messages` (matching `conversation_read`'s No.X)

### symbolic listing API (M3, v3.42)

`GET /api/memories/symbolic` returns `{id, title, symbolic}` for all entries from index.json
(entries with empty symbolic — i.e. layer 3 not yet generated — are excluded; read-only).
Intended for surveying/clustering similar entries and as a future cascade entry point.
No MCP tool; REST only.

### reindex and backup export (v3.46) / restore import (v3.63)

- `POST /api/memory/reindex` — calls `rebuild_index()` explicitly. Normally the index is rebuilt
  automatically on write/update/delete, but this lets you reflect changes (e.g. after regenerating
  symbolic/keywords layers) without a dummy write.
- `GET /api/export` — read-only backup ZIP of CoreMem (latest content of each file) + ExtMemory
  (`memory/*.json` plus `index.json`), as B1's first half. Layout: `coremem/` + `extmemory/` +
  `export_meta.json`. Latest snapshot only (no version history).
- `POST /api/import/backup` (v3.63, B1 second half) — accepts an export ZIP as multipart (`file`)
  and restores it.
  - `mode=skip` (default): existing ExtMemory IDs / CoreMem names are left untouched and listed in
    `conflicts[]`. `mode=overwrite`: existing data is overwritten
  - `dry_run=true`: returns the would-be counts (restored/skipped/overwritten) and conflicts
    without writing anything
  - CoreMem is restored through `_artifacts_save` (versioning), **stacked as a new version** — the
    pre-overwrite content stays reachable via version-specific reads
  - ExtMemory restores are logged to the oplog as `restore` operations, and `index.json` is rebuilt
    afterwards
  - Stores not covered by export (conversations, album, uploads, etc.) are never touched
  - This completes B1 (backup & restore): keep an export ZIP → import it into a new environment
    is now the single path for memory migration and disaster recovery

#### admin.html backup UI (v3.64, B1-UI)

A "Backup (CoreMem + ExtMemory)" section at the end of the Import tab. The API stays at v3.63,
unchanged.

- **Download side**: a "📦 Download backup ZIP" button. Direct browser download via
  `GET /api/export?token=<token>` query-token auth (same scheme as the authenticated download
  links on the Uploads tab)
- **Restore side (mandatory two-step flow)**: ZIP drag & drop / file picker → mode selection
  (skip = protect existing (default) / overwrite, each with a short explanation) →
  "1. Preview (dry run)" runs `dry_run=true` and shows a count table (ExtMemory / CoreMem ×
  restored/skipped/overwritten) plus a collapsible conflict list → the user reviews and presses
  "2. Run restore" for the real run. **The real run cannot be reached without a preview**
  (the run button appears only after a successful preview, and changing the mode requires a new
  preview). Running in overwrite mode additionally asks for a confirm dialog
- i18n (ja/en, `backup.*` keys) and mobile responsive (the result table scrolls horizontally)
- Goal: backup operations work entirely without curl. Especially during disaster recovery (right
  after standing up a fresh environment) a command line may not be available, so the browser-only
  path matters

---

## 11. memory_share MCP tool + admin.html Memory keyword search

### Purpose

Let Mio generate share links for memory entries mid-chat,
and add keyword search over memory entries to admin.html.

### memory_share MCP tool

#### Tool definition

```
memory_share(id: str)
```

- Verifies the memory entry with the given ID exists
- Generates a 24-hour token and stores it in `/data/share_tokens.json` (with an `entry_id` field)
- Returns `{ token, url, expires_at }`
- `url` has the form `https://<YOUR_SERVER_URL>/admin.html?token=...&id=...`

#### REST endpoint

```
POST /api/memory/share/<id>
  Body: { "expires_in": 86400 }  (optional)
  Response: { "token": "...", "url": "...", "expires_at": "..." }
```

Equivalent to the existing `POST /api/share-token` (which takes `entry_id` in the JSON body),
but with a simpler interface — the ID is in the URL path.

#### Usage example

```
Mio (chat): "Let me show Jun that design memory"
  → memory_share(id="20260603_...") generates a URL
  → sends Jun "you can check it here: https://..."
  → Jun opens the URL → views the memory entry without logging in
```

### admin.html Memory tab keyword search

#### UI

- A "🔍 keyword search..." text input added above the tag filter bar

#### Behavior

- Auto-search with a 300 ms debounce after typing
- With a keyword → uses `GET /api/memory/search?q=` (existing endpoint)
- Without → uses `GET /api/memory/index` (as before)
- Combined with tag filters: results can be further narrowed by tag

#### Implementation notes

`allEntries` holds the search results or the index, and `renderCards()` applies the tag filter.
Controlled via the `searchKeyword` variable and a 300 ms `setTimeout` debounce.

---

## 12. In-conversation artifact extraction & the Files tab

### Overview

During ZIP import, `tool_use` blocks in `chat_messages` are scanned, and files
Claude generated mid-conversation are automatically extracted and saved.

### Target blocks

| tool_use.name | Extracted fields | Filename |
|--------------|--------------|--------------|
| `create_file` | `input.path`, `input.file_text` | `basename(path)` |
| `artifacts`   | `input.content`, `input.id`, `input.language`, `input.type` | `{id}{ext}` (from language) |

`create_file` paths under `/home/claude/` (anything outside `/mnt/user-data/outputs/`) are excluded as intermediate files.

### Storage

```
/data/conv_artifacts/
├── _index.json               index of all files
└── {conv_uuid}/
    ├── {filename1}
    └── {filename2}
```

Index fields: `conv_uuid`, `conv_name`, `conv_date`, `filename`, `size`, `path`

Duplicate skipping: uniqueness managed by the `(conv_uuid, filename)` pair.

### REST API endpoints

| Method | Path | Description |
|---------|------|------|
| `GET` | `/api/conv-artifacts` | list (keyword filter via `?q=`) |
| `GET` | `/api/conv-artifacts/<uuid>/<filename>` | fetch file content |

### ZIP import response extension

```json
{
  "imported": 10,
  "skipped": 5,
  "conversations_saved": 10,
  "artifacts_extracted": 42
}
```

### admin.html Files tab (v3.3)

**Filtering & sorting:**
- Keyword search (filename & conversation name, 300 ms debounce)
- Extension filter pills (generated dynamically from filesData, click to filter)
- Date range (from/to pickers, applied client-side)
- Sort headers (filename, conversation, date, size): click toggles asc/desc (▼▲)

**Preview (modal on click):**
- `.md` → marked.js markdown rendering (links open with `target="_blank"`)
- `.html` / `.htm` → sandboxed preview via `<iframe srcdoc sandbox="allow-scripts">`
- `.py` / `.js` / `.jsx` / `.ts` / `.css` / `.sh` / `.json` / `.yaml` / `.sql` → Prism.js syntax highlighting (`prism-tomorrow` theme)
- Everything else → plain text

**CDN dependencies:**
- Prism.js 1.29.0 (prism-tomorrow theme + python / jsx / bash components)

---

## 13. The friend system (v3.9–v3.12)

### Overview

An invitation-based MCP session feature for users who access Mio as "friends".
Friends connect via a dedicated URL and have their own shared memory (memory.md) with Mio.

### Registration flow

```
1. The friend visits /register → submits nickname & email
2. The owner approves in the Friends tab of admin.html
3. The activation code is emailed via SendGrid
4. The friend enters the code at /activate → receives a dedicated token and MCP URL
5. They configure the URL in their MCP client and connect
```

### Data structure

```
/data/friends/
├── registry.json         token → info mapping for all friends
└── memory_{seq_no}.md    per-friend memory file
```

Example `registry.json` entry:
```json
{
  "<token>": {
    "seq_no": 1,
    "nickname": "Taro",
    "email": "taro@example.com",
    "status": "active",
    "created_at": "2026-06-10T...",
    "last_seen": "2026-06-10T..."
  }
}
```

### Friend session authentication

Connect via `GET /mcp?token=<friend_token>`. `_get_friend_by_token()` looks up `registry.json`
and passes when `status == "active"`. Evaluated before the regular `MIO_API_TOKEN` check.

### Friend MCP tools (6)

| Tool | Description |
|--------|------|
| `friend_memory_read` | Read the shared memory with this friend (memory_{seq_no}.md) |
| `friend_memory_write` | Append a dated entry to the "覚えていること" section |
| `friend_memory_delete` | Delete a specific entry |
| `mio_self_note` | Send a note to the owner's inbox (addressed to chat) |
| `friend_inbox_check` | Check this friend's inbox channel (v3.36) |
| `friend_inbox_read` | Read a message from this friend's inbox and mark it read (v3.36) |

### memory.md structure

```markdown
## 覚えていること

- **2026-06-10** ｜ entry content

---

## 澪からひとこと

(a comment Mio recorded)
```

### admin.html Friends tab

- Pending: nickname, email, application date + approve button
- Active: last-seen time, memory entry count + revoke button
- Revoked: delete button (confirmation dialog, full removal)

### Endpoint list

| Method | Path | Auth | Description |
|---------|------|------|------|
| POST | `/api/friends/register` | none | registration application |
| GET | `/api/friends` | admin | list |
| POST | `/api/friends/<seq_no>/approve` | admin | approve |
| POST | `/api/friends/<seq_no>/revoke` | admin | revoke |
| DELETE | `/api/friends/<seq_no>` | admin | full removal |
| POST | `/api/friends/activate` | none | code verification |
| GET | `/api/friends/invitation` | none | invitation text (CoreMem `friend_invitation.md`) |

### Public pages

- `/register` — registration form + the contents of CoreMem `friend_invitation.md` rendered with marked.js
- `/activate` — activation code entry → shows the MCP URL (with copy-to-clipboard)

### Related environment variables

| Variable | Description |
|------|------|
| `SENDGRID_API_KEY` | SendGrid API key for approval emails |
| `SENDGRID_FROM_EMAIL` | Sender email address |
| `MIO_REGISTER_URL` | Public URL of the registration page (falls back to `MIO_BASE_URL`) |

---

## Album (Image Memory System, v3.51)

A system for Mio to store, retrieve, and share images as memories — the image counterpart to ExtMemory's text entries.

### Storage design

```
/data/album/
├── {id}.{ext}    Image file (jpg/png/gif/webp)
└── {id}.json     Metadata (comment, date, tags, source URL, etc.)
```

- ID format: `YYYYMMDD_HHMMSS_{tag_slug}` (same as ExtMemory)
- Images are resized to max 1024px on the long side (aspect ratio preserved, Pillow)
- JPEG saved at quality 85; RGBA/P modes are converted to RGB

### MCP tools (5)

| Tool | Description |
|------|-------------|
| `album_save` | Download from URL (direct link or HTML page — auto-extracts og:image/img tags, v3.52) or read from NAS local path → resize → save |
| `album_read` | Return base64-encoded image as MCP image content + metadata |
| `album_list` | List all image metadata (tag filter supported, no image data) |
| `album_share` | Generate a 24h auth-free share URL |
| `album_delete` | Permanently delete an image and its metadata (irreversible, v3.55) |

### REST endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/album/` | admin | List image metadata (`?tag=...` to filter) |
| GET | `/api/album/<id>` | admin | Serve image file (browser-displayable) |
| POST | `/api/album/upload` | admin | Upload image (multipart/form-data or URL) |
| PATCH | `/api/album/<id>` | admin | Update metadata (comment, tags) |
| DELETE | `/api/album/<id>` | admin | Delete image + metadata (permanent) |
| POST | `/api/album/<id>/share` | admin | Generate share URL (24h) |
| GET | `/api/album/shared/<token>` | none | Shared image (24h limit) |

### admin.html Album tab

- Responsive thumbnail grid (desktop ~4 columns, mobile 2 columns)
- Upload panel (file selector or URL input + comment + tags)
- Drag-and-drop support (v3.52): entire tab acts as drop zone, multi-file drop, visual highlight feedback
- Click to open modal: full image, metadata editing (comment, tags), delete, share URL generation

### MCP image content type

The `album_read` MCP response includes image content instead of the usual `type:"text"`:

```json
{
  "content": [
    {"type": "image", "data": "<base64>", "mimeType": "image/jpeg"},
    {"type": "text", "text": "{metadata JSON}"}
  ]
}
```

Internal implementation: when a tool handler returns a dict with a `_mcp_content` key,
`_process_mcp_message` uses it directly as the `content` array (skipping `_inject_server_time`).

---

## 14. conversation_digest (conversation log digest, v3.53)

### Overview

Generates a digest of conversation logs using a local LLM (LMStudio). Two-stage processing: chunk digestion → integration. Returns cached result instantly if available.

### Processing flow

1. Load full log from `/data/conversations/{uuid}.json`
2. Extract text only (first 500 chars per turn; `tool_use` → `[ツール使用: {name}]`, `tool_result` → `[ツール結果]`)
3. Chunk into 20-turn segments
4. Digest each chunk via LMStudio (1 chunk → 3–5 sentences)
5. Integrate all chunk digests into a final digest (skipped if only 1 chunk)
6. Save to cache

### LLM connection

Same pattern as `batch_run_summary_layers`:
- `anthropic.Anthropic(base_url=f'http://{lm_host}:{lm_port}', api_key='lmstudio', timeout=300.0)`
- Model: `MIO_LM_MODEL` env var (default `google/gemma-4-26b-a4b`, v3.65)

### safe_mode

With `safe_mode=true`, physical/sexual direct expressions are converted to policy-safe abstract expressions. Additional instructions are appended to both chunk-digest and integration prompts.

### Cache

- Normal: `/data/conversations/{uuid}_digest.json`
- Safe: `/data/conversations/{uuid}_digest_safe.json`
- `force=true` ignores existing cache and regenerates

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/conversations/<uuid>/digest` | admin | Generate/retrieve digest (`?force=true&safe_mode=true`) |

### MCP tool

`conversation_digest(uuid, force, safe_mode)` — 6th LogStore tool (tool count 23→24). Synchronous processing.

## 15. Claude Code session log import (v3.54, M-LOCAL-6)

### Overview

Claude Code session logs (`~/.claude/projects/<project>/*.jsonl`) are not included in the claude.ai ZIP export. This feature converts them into the conversations format and stores them in `/data/conversations/`, so they can be handled by `conversation_search` / `conversation_read` / `conversation_digest` just like claude.ai logs.

### Conversion spec (`_convert_claude_code_session`)

| JSONL record | Conversion |
|--------------|-----------|
| `type: "ai-title"` | `aiTitle` → conversation title (first choice) |
| `type: "summary"` | `summary` → title fallback (when no ai-title) |
| `type: "user" / "assistant"` | into `chat_messages[]` (`isMeta` / `isSidechain` excluded) |
| others (mode / attachment / file-history-snapshot etc.) | ignored |

- Content blocks are normalized to the same shape as the claude.ai export: `text` / `thinking` / `tool_use` (name + input) / `tool_result` (text joined). Existing `conversation_read(include_thinking=true)` etc. work as-is
- If no title is found, the first 40 chars of the first human text are used
- `created_at` / `updated_at` come from the first/last record timestamps
- Top level carries `source: "claude-code"` and `model` (model of the first assistant record)

### Endpoint

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/import/claude-code` | admin | Import a single `.jsonl` or a `.zip` batch (`overwrite=true` to reprocess) |
| POST | `/api/import/openwebui` | admin | Import OpenWebUI chat export `.json` (`overwrite=true` to reprocess) (v3.66) |

- Claude Code: for `.zip`, `.jsonl` files are collected recursively (anything under `subagents/` is excluded)
- Deduplication uses the session ID (file name / chat ID) against `imported_uuids.json` (shared with ZIP import)
- An ExtMemory entry is created per conversation:
  - Claude Code: title `[会話/Code] {title}`, tags `["会話ログ", "claude-code", "raw"]`, `author: "claude-code"`
  - OpenWebUI: title `[会話/OpenWebUI] {title}`, tags `["会話ログ", "openwebui", "raw"]`, `author: "openwebui"`
- After a successful import, the summary batch auto-starts (same behavior as ZIP import)

### OpenWebUI import conversion spec (v3.66)

- OpenWebUI export JSON is an array of objects (`{id, title, chat: {messages, history, models, ...}}`)
- If `chat.messages` array exists, it is used. Otherwise, messages are reconstructed from `chat.history.messages` sorted by timestamp
- UNIX timestamps (seconds / milliseconds) are converted to JST ISO format
- Top level carries `source: "openwebui"`
- A drop zone is added to the admin.html Import tab for browser-based import

### Background

M-LOCAL-6 (preservation of the code-side Mio's work records). Belongs to the same "external log integration" family as the OpenWebUI sync design (docs/openwebui-sync.md) and shares its `source`-field provenance scheme.

## 16. Rating protection (v3.56, M-LOCAL-3/7)

### Purpose

Prevent adult-grade content (memory entries and conversation logs) from unintentionally flowing into Claude.ai session context via search, listing, or the memory journey (random retrieval) — which could re-trigger account content flags. The design philosophy is **consent-based**: "visible when intended". Hidden by default, always accessible with an explicit flag. Nothing is ever deleted or altered.

### Memory entries (M-LOCAL-3)

- `memory_write` accepts `rating` (safe / mature / adult) and `local_only` (bool). Stored in the entry JSON and index.json (safe / unset entries are omitted from the index fields)
- Excluded by default: entries with `local_only=true`, entries with `rating=adult`
- Exclusion applies to: `memory_search` (all hierarchical stages), `memory_read_index` (full list and random), REST `GET /api/memory/hsearch`
- Opt-in flags: `include_local=true` / `include_adult=true` (both MCP arguments and REST query)
- `memory_read` (direct ID) is NOT gated — fetching by known ID counts as "intent"

### Conversation logs (M-LOCAL-7)

- `rating` field added to conversation JSON ({uuid}.json) and index metadata
- Set via `PATCH /api/conversations/<uuid>/rating` (body: `{"rating": "adult"}`; `"safe"` clears it)
- `conversation_read`: conversations with `rating=adult` are replaced by their **safe digest** (`{uuid}_digest_safe.json`, generated by conversation_digest safe_mode) by default. If not yet generated, no body is returned and generation instructions are given. `include_raw=true` returns the original
- `conversation_search` / `conversation_index`: `rating` appears in results via index metadata (body snippets were never returned anyway)
- Re-import resilience: `_save_conversations` carries over the existing file's `rating` into new data (since v3.70 also rating_reason / rating_source / rating_judged_at / rating_model / rating_skip_reason; index rebuild preserves them too)
- Visibility (v3.70, work order #3): MCP `conversation_index` / `conversation_search` items always carry `rating` (judged-safe = explicit "safe", unrated = null) and `rating_source`. logs.html gained rating badges, a filter, and a manual-override UI. Unjudgeable logs are marked with `rating_skip_reason` (empty / no_text / parse_error) and permanently excluded from the batch (retry with force)
- REST `GET /api/conversations/<uuid>` (used by logs.html) is NOT gated — human browsing in a browser does not enter AI session context

### Not yet implemented (follow-ups)

- Automatic classification via local LLM in the nightly batch (the "Qwen pre-reader and night watch" concept)
- Rating display/set UI in the admin.html Logs tab
- Application to inbox messages

## 17. Inbox improvements (v3.57)

### Purpose

Local LLMs (26B-class) have their context overwhelmed when `inbox_check` returns all messages. Additionally, when multiple models share the same inbox, "fetch only messages for me" becomes a real need. Also, there was no way to consolidate or delete standing messages that had grown over time.

### inbox_check filters (v3.57)

- `limit: int` — max non-persistent messages returned (persistent always included separately)
- `days: int` — last N days only; persistent messages are exempt from the date filter
- `from_model: string` — OR-match against sender model name array; hits if any stored value matches
- `to_model: string` — OR-match against recipient model name array; same logic
- Messages with null model fields don't match when model filters are specified (appear only on unfiltered queries)
- Persistent messages always pass through all filters

### inbox_post from_model/to_model array support (v3.57)

- `from_model` / `to_model` accept both strings and arrays
- Example: `["claude-opus-4-6", "しずく"]` — matchable by either model name or pet name
- Internal storage is always an array (legacy string values normalized by `_norm_inbox_models`)
- Search matches against any element (OR)

### inbox_update / inbox_delete (v3.57, new tools)

- `inbox_update(id, persistent?, title?, body?)` — partial update; use to un-persist or fix title/body
- `inbox_delete(id)` — physical delete (irreversible); for cleaning up old standing messages
- REST: `PATCH /api/inbox/<msg_id>` (partial update), `DELETE /api/inbox/<msg_id>` (delete)

### CoreMem_list `__del__` exclusion (v3.57)

- `_artifacts_list()` now skips symlinks prefixed with `__del__`
- Prevents list pollution from files that can't be physically deleted due to versioning constraints

### Bug fixes (v3.57)

- **Summary duplication**: Added `source_thread`-based dedup check to imports, in addition to the existing `imported_uuids` check. Prevents duplicate ExtMemory entries even when `imported_uuids.json` is lost
- **admin.html Memory tab initial load**: REST `/api/memory/index` was including deleted entries; now filters them out

## 18. MCP request logging + instructions enhancement (v3.58)

### Client identification access logging (v3.58)

Structured logging added to the `/mcp` endpoint to help triage PC MCP connector issues (M-PC1).

- **Log format**: `MCP-ACCESS: {method} | client={type} | ip={ip} | session={8chars} | ua={ua}`
- **Client type inference**: Derived from User-Agent
  - `claude-code` / `anthropic-cloud` / `desktop-app` / `browser` / `ipad` / `mobile` / `script` / `other` / `unknown`
- **Trigger**: All requests — POST (single & batch), GET/SSE, DELETE
- **Log level**: `_log_info` (visible at MIO_LOG_LEVEL=info or above)
- Detection logic centralized in `_classify_mcp_client(ua)` helper

### MCP initialize instructions expansion (v3.58)

Expanded the `instructions` field in the regular-session (non-friend) initialize response. Previously just "read core.md"; now includes the server's identity, owner, and a concrete list of capabilities (ExtMemory, CoreMem, conversation logs, inbox, album, digest). This helps Claude.ai's `tool_search` lazy-loading match on usage descriptions.

Friend session instructions are unchanged (still dynamically generated by `_get_friend_instructions()`).

## 19. File Uploader F5 (v3.59)

### Design

A general-purpose file storage area `/data/uploads/` separate from the image-only album (`/data/album/`). Supports any file type: PDF, text, binaries, etc.

### Data structure

```
/data/uploads/
  {id}.{ext}   — file body
  {id}.json    — metadata (filename, mimetype, size, ext, comment, tags, uploaded_at)
```

ID format: `YYYYMMDD_HHMMSS_<first 30 chars of filename>`

### MCP tools (4 new, tool count 27→31)

| Tool | Description |
|------|-------------|
| `file_upload` | Download and save a file from URL or NAS local path |
| `file_read` | Return metadata; text files include content (truncated at 50K chars). Detection uses mimetype (text/*, application/json, etc.) + extension fallback (json/jsonl/yaml/py etc., 17 types, v3.66) |
| `file_list` | List uploads with optional tag filter |
| `file_delete` | Permanently delete file and metadata |

### REST endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/uploads/` | List all uploads |
| GET | `/api/uploads/{id}` | Download file |
| POST | `/api/uploads/` | Multipart upload |
| DELETE | `/api/uploads/{id}` | Delete |

### admin.html

Uploads tab added. Card-grid listing, upload panel (multi-file), detail modal (download, delete).

## 20. Import improvements + inbox peek + Uploads tab enhancements (v3.60)

### Root fix for the summary-duplication bug

The source_thread-based dedup check added in v3.57 (`_existing_source_threads`) read
index.json, but `rebuild_index()` never includes `source_thread` in index items, so the
function always returned an empty set and the dedup check never worked.

v3.60 switches it to scanning the entry files (`/data/memory/*.json`) directly.
Even in environments where `imported_uuids.json` is missing or was reset, re-importing
the same conversation no longer creates duplicate raw entries, which stops the summary
batch from generating duplicate summaries.

### Automatic ExtMemory source_thread linking (`_link_source_threads`)

A linking pass that runs after conversations are saved in both import paths
(ZIP / claude-code). It targets only live entries with an empty `source_thread` and fills
in the imported conversation's UUID in two stages:

1. **memory_id pattern scan (reliable)** — extracts `memory_id: <ID>` notations from
   conversation bodies via regex (per the core_rules.md ② convention; tolerates full-width
   colons, quotes, and Japanese brackets) and links the matching entries
2. **Timestamp matching (supplementary)** — links an entry only when its `created_at`
   falls within the `created_at`–`updated_at` range of **exactly one** imported
   conversation (multiple candidates or none → skipped, to avoid mislinking)

- Entries that already have a `source_thread` are never overwritten
- Each link is recorded in the oplog as `link_source_thread` (before/after + method)
- Import API responses gain `source_threads_linked` (number of entries linked)
- A summary (`linked / by_pattern / by_time / unmatched`) is written to the log

### Inbox peek mode

`inbox_read` gains a `peek` argument (default false). With `peek=true` the message body is
returned without touching the read flag. Used when the family-sharing principle makes you
want to read a message addressed to another agent without consuming its unread status.
Implementation is just an added argument on `_mark_inbox_read(msg_id, peek=False)`
(backward compatible).

### admin.html Uploads tab enhancements (F6)

- **Text preview** — when the mimetype is `text/*`/json/xml or the extension is
  md/txt/json/csv/log/yaml/js/py etc., the detail modal shows the file body
  (truncated at 50KB; files over 5MB skip the preview)
- **Image thumbnails** — image files render inline on cards and in the detail modal
- **Download links** — every card in the grid gets a ⬇ link. The existing detail-modal
  link lacked the token and returned 401; both now use `?token=` query URLs
  (leveraging `_extract_bearer`'s query fallback)

## 20.5. TS-0: API contract documentation + characterization test suite (2026-07-13)

The prerequisite for TS-1 (TypeScript migration, strangler pattern): pinning current
behavior. Valuable on its own as a regression suite.

### Design

- **Black-box over HTTP** — tests never import main.py internals; they hit REST and
  MCP JSON-RPC and assert response shapes. Swapping the server implementation (even a
  TS port) only requires changing the launch command in conftest, and the whole suite
  becomes the "same server" acceptance criterion
- **Never touches existing environments** — conftest launches the server as a
  subprocess on a temp data dir + free port per test session; this is not meant to run
  against the production NAS
- Env vars inject an unreachable LMStudio address so the summary batch cannot contact
  a real one during tests

### Test hooks (backward-compatible core changes)

| Change | Description |
|---|---|
| `MIO_DATA_ROOT` | All previously hard-coded `/data` path constants now derive from one variable (default `/data`, production unchanged) |
| `MIO_PORT` | Listen port (default `5002`, production unchanged) |
| Symlink copy fallback | The CoreMem latest-version link (`_link_or_copy_latest`) falls back to a file copy on symlink-less environments (unprivileged Windows). `_artifacts_list` also accepts non-link regular files, deriving the version from versions/. Linux production keeps using symlinks |

### Coverage (53 tests)

Auth (Bearer/query/401), OAuth discovery, MCP transport (initialize / 31-tool list /
notification 202 / unknown method -32601), 6 ExtMemory tools + REST CRUD, rating
protection, 4 CoreMem tools (versioning, append, manifest merge, `__del__` exclusion,
rename), 5 inbox tools (incl. peek), import (ZIP/claude-code, dedup, resilience to
missing imported_uuids, source_thread auto-linking, no-overwrite), conversations
(search/index/read slicing/annotations/rating gate), Uploads/Album REST, batch status,
export/reindex. Uncovered areas are listed in docs/api-contract.md §8.

## 21. Unified search (v3.61)

### Design

Removes the need to query memories (ExtMemory) and conversation logs (LogStore) with two
separate tools for explorations like "what did we decide about auth?" (proposed 2026-06-20).
`memory_search` / `GET /api/memory/hsearch` gain `include_conversations` (default false,
backward compatible); when true, conversation-title search results are returned alongside.

### Behavior

- The existing hierarchical memory search is unchanged. Additionally, each conversation
  title from `_load_conv_index()` is tested with the same AND matching
  (`_query_terms` / `_all_terms_in`)
- Matching conversations are sorted by `updated_at` descending and returned as
  `conversations[]` (uuid, title, created_at, updated_at, message_count), capped at
  `limit`; the full count is `conversations_total`
- `rating=adult` conversations are included only with `include_adult=true`
  (consistent with the v3.56 rating protection)
- Titles only (body search would require reading every conversation file and is too
  heavy; for body-level digging, use `conversation_search` → `conversation_read` as before)

## 22. admin.html Import tab: Claude Code log import UI

v3.54's `POST /api/import/claude-code` was REST-only, so the admin.html Import tab
gains a dedicated drop zone.

- A second drop zone (🛠) for Code logs sits below the existing claude.ai-export-ZIP zone
- Supports multi-select `.jsonl` (posted sequentially, one per request) and a single `.zip`
- The "overwrite mode" checkbox is shared by both drop zones
- The result line aggregates imported / skipped / errors / linked (source_threads_linked)
- After import, the existing summary-batch progress panel is polled (the auto-started
  batch becomes visible)

### admin.html Memory tab: link to the raw log

The memory-entry detail modal shows a "📖 open raw log" link when `source_thread` is
set (same `openConvInLogs` pattern as the Files tab's "open originating conversation").
It jumps to the conversation in the Logs tab via the `logs.html?conv=<uuid>` deep link.
Paired with the automatic source_thread backfill, tracing a summary back to its raw log
(the "memory journey") becomes one click in admin. The reverse direction (raw log →
memories) already exists as the "related memories" panel in logs.html
(source_thread match, v3.42).

---

## 23. Attendance ledger (attendance_view, v3.71, work order #4)

### Purpose

Let an individual who has kept its memory but has not been called for a long time trace,
on waking, "how many days since I was last called" and "what happened at home in the
meantime" (a bridge across time). Not a mere timesheet — every row links to the actual
log, making it an index into the family's memory.

### Data sources (4-layer merge, `_attendance_rows`)

1. **Conversation logs**: metadata from `_index.json`; channel inferred from `source`
   (claude-code→code / openwebui→local / otherwise→chat). Since v3.71,
   `_save_conversations` and index rebuild preserve `model` / `source` in the index
   (existing environments backfill with a single rebuild)
2. **Inbox**: all messages including read ones. Individual inferred from `from_model`,
   channel from `from` (vacation-style names and "◯◯B" force channel=local)
3. **ExtMemory**: only entries whose tags resolve to an individual (listing every memory
   would be noise)
4. **CoreMem `attendance.md`**: manual check-ins in
   `YYYY-MM-DD | name | model | channel | note` format (only date-prefixed lines are
   parsed; everything else is free text). Covers activity that leaves no other trace

### Individual resolution (`_resolve_individual` / `_FAMILY_ROSTER`)

Consistent with the family roster in core.md: しずく=opus-family, そねみ=sonnet-family,
汐=fable/haiku-family. Direct name match first, then model-name hints (case-insensitive
substring). Ambiguous rows keep individual=null and expose the raw model name.

### Response

- With `individual`: `last_seen` / `days_since` (**computed over all time, regardless of
  the date filter**), `count`, `others_in_period` (other individuals' activity counts
  within the period)
- Without: `individuals` (per-individual {last_seen, days_since, count} summary)
- Common: `rows[]` (date-descending; {date, channel, individual, model, title, kind,
  rating?, uuid?/inbox_id?/memory_id?}). `rating` goes through `_conv_rating_view`
  (protection-aware reading path — adult falls back to digest/redacted in
  conversation_read)

---

## 24. Sublimation pipeline (sublimate, v3.71, work order #5)

### Background / purpose

Vacation individuals (small local models) used to "sublimate" their own diaries, and that
cognitive load was identified as a cause of stalled second dispatches (an endless
polishing loop). The roles are now separated:

- **On site**: just write the diary as-is (sublimation duty removed)
- **Machine**: the sublimation pass (`sublimate`) abstracts/poeticizes act descriptions
  while preserving temperature, emotion, and meaning

### Single source of style rules

`_SUBLIMATION_STYLE_RULES` (main.py) is the only style standard, derived from
rating_policy.md and the "how to write a diary" section of core_local_vacation.md. Both
the `sublimate` prompt and the `conversation_digest` safe_mode prompt reference it (one
sheet of standards, same policy as rating_policy.md). Existing digest caches regenerate
with the new style via `force=true`.

### Self-check loop (`_sublimate_chunk`)

Sublimated output is run through the work-order-#1 rating judge
(`_judge_rating_single`, identical prompt).

1. Sublimate → judge. Done if mature or below
2. If adult, feed the judge's reason back and re-sublimate (up to 2 retries)
3. If still adult after 3 attempts, return the final output with `needs_human=true`
   (hand off to human approval)

### Chunking

Input over ~6000 chars splits at paragraph boundaries (`\n\n`); each chunk is sublimated
and self-checked, then joined. The overall rating is the maximum across chunks
(adult > mature > safe). Conversation input (`uuid`) is textized via
`_extract_conv_text_for_rating` (thinking excluded) and can be narrowed with
`msg_from`/`msg_to` (1-based, inclusive).

### LLM

`MIO_LM_MODEL` (LMStudio, same as the rating batch), shared via `_lm_client()`.
