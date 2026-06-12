# Design Specification: mio-memory MCP Server Extensions

**[日本語版 / Japanese](design.ja.md)** ← 日本語版が正。このファイルは日本語版から同期。

> Created: 2026-06-01  
> Target: `/volume1/docker/mio/memory/app/main.py`

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
A drag & drop UI is added to admin.html (separate task).

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
  "serverInfo": { "name": "mio-memory", "version": "3.23.0" },
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
| 3 | Symbolic compression | "## 3層: シンボリック圧縮" section in body | batch (LLM) |
| 4 | Keywords | entry `keywords` field (also in index.json) | batch (LLM) |

### At import time

`POST /import` generates **layer 1 only**:

- Layer 1: records `title`, `created_at`, `source_thread` (body empty), tagged `['会話ログ', 'raw']`

Layers 2–4 are generated by the batch (auto after import / nightly / the `batch_run_summary_layers` MCP tool).
Entries that already have layers 2–3 but no `keywords` field get a lightweight keywords-only backfill.

### Hierarchical memory_search (v3.17)

1. **Stage 1**: search index.json only (title + tags + keywords) — body not read
2. **Stage 2**: if stage-1 hits are fewer than `limit`, search the layer-2 summary sections
3. **Stage 3**: if still short, search the full body

Returns `summary` (layer 2) + `symbolic` (layer 3) + `match_layer` (keyword/summary/full) instead of body.
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
- not set → `lmstudio` (Qwen3 at `LM_STUDIO_HOST:LM_STUDIO_PORT`, no billing)

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
| Target tag | `raw` |
| Skip condition | body contains both `## 2層: 要約` and `## 3層:` |
| Model (anthropic) | `claude-haiku-4-5-20251001` |
| Model (lmstudio) | `qwen/qwen3.6-35b-a3b` |
| Rate limiting | 0.5 s sleep between items |
| Idempotency | guaranteed via the processed-marker check |

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
| lmstudio | `qwen/qwen3.6-35b-a3b` | `google/gemma-4-26b-a4b`, `liquid/lfm2-24b-a2b` |

**Required environment variables (for the CLI script):**

| Variable | Purpose | Default |
|------|------|-----------|
| `MIO_API_TOKEN` | mio-memory Bearer auth | (required) |
| `ANTHROPIC_API_KEY` | Claude API auth (anthropic backend) | (required) |
| `MIO_SERVER_URL` | mio-memory server URL | `http://localhost:5002` |
| `LM_STUDIO_HOST` | LMStudio host (lmstudio backend) | `192.168.10.32` |
| `LM_STUDIO_PORT` | LMStudio port | `1234` |

The `MIO_SERVER_URL` default assumes in-container execution. When running outside the container, add `MIO_SERVER_URL=https://memory.mio.runabook.synology.me` to `.env`.

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
MIO_SERVER_URL=https://memory.mio.runabook.synology.me python scripts/generate_summary_layers.py --dry-run
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
- `url` has the form `https://memory.mio.runabook.synology.me/share.html?token=...` (v3.23+; a standalone read-only viewer. Legacy `logs.html?token=` links keep working)
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
| Conversations | 4 | conversation_search, conversation_share, conversation_read, log_annotate |
| Inbox | 3 | inbox_check, inbox_read, inbox_post |
| Batch | 1 | batch_run_summary_layers |
| **Regular session total** | **18** | |
| **Friend sessions** | **4** | friend_memory_read, friend_memory_write, friend_memory_delete, mio_self_note |

※ Friend sessions apply only when accessed via `/mcp?token=<friend_token>`. The regular 18 tools are unavailable there.

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
- `url` has the form `https://memory.mio.runabook.synology.me/admin.html?token=...&id=...`

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

### Friend MCP tools (4)

| Tool | Description |
|--------|------|
| `friend_memory_read` | Read the shared memory with this friend (memory_{seq_no}.md) |
| `friend_memory_write` | Append a dated entry to the "覚えていること" section |
| `friend_memory_delete` | Delete a specific entry |
| `mio_self_note` | Send a note to the owner's inbox (addressed to chat) |

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
