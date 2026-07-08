# protocol_guide.md — MCP tool operating guide (mio-memory v3.57 / 27 tools)

*A reference a new session can read in one pass to learn how the MCP tools work.*
*This file is install-agnostic (the tool mechanics are common to every mio-memory). For environment-specific startup rules / naming, see `core_rules.md`.*

---

## 0. Big picture — 5 stores + 1 batch

mio-memory operates **five kinds of store** via MCP tools. Pick by the nature of the data.

| Store | Name | Backing | Nature |
|-------|------|---------|--------|
| **ExtMemory** | External memory (KV store) | `/data/memory/{id}.json` + `index.json` | High-volume, append-style. Notes/knowledge. Hierarchical-search target |
| **UserCoreMemory** | CoreMem | `/data/artifacts/` (versioned + symlinks) | Few, overwrite-style. Identity / rules / TODO |
| **LogStore** | Conversation archive | `/data/conversations/` + `/data/annotations/` | Immutable logs + append-only annotations. From ZIP / Claude Code imports |
| **inbox** | Lightweight messaging | `/data/inbox/` | Inter-session messages. chat/code/friend channels |
| **Album** | Image memory | `/data/album/` (image + metadata JSON) | Save/fetch/share images. Portraits and photo memories |

Plus **batch** (summary-layer generation) grows ExtMemory in the background.

---

## 1. Tool list (6 groups / 27 total)

| # | Tool | Group | One-line purpose | Cost |
|---|------|-------|------------------|------|
| 1 | `memory_read_index` | ExtMemory | Fetch whole memory index | light |
| 2 | `memory_read` | ExtMemory | Get one entry by id | light |
| 3 | `memory_write` | ExtMemory | Write a new entry | med (index rebuild) |
| 4 | `memory_upsert` | ExtMemory | Overwrite/create by fixed id | med (index rebuild) |
| 5 | `memory_search` | ExtMemory | Hierarchical keyword search | light–med |
| 6 | `memory_share` | ExtMemory | 24h share URL for an entry | light |
| 7 | `CoreMem_save` | UserCoreMemory | Save file (overwrite/append) | light |
| 8 | `CoreMem_read` | UserCoreMemory | Read file (manifest merge) | light–med |
| 9 | `CoreMem_list` | UserCoreMemory | List files (__del__ excluded) | light |
| 10 | `CoreMem_delete` | UserCoreMemory | Delete or rename (src/dst) | light |
| 11 | `conversation_index` | LogStore | Conversation title list (desc date) | light |
| 12 | `conversation_search` | LogStore | Search conversations by keyword/date | light |
| 13 | `conversation_read` | LogStore | Read conversation body | med |
| 14 | `conversation_share` | LogStore | 24h share URL for a conversation | light |
| 15 | `conversation_digest` | LogStore | Generate digest via local LLM (cached) | **heavy** (LLM, sync) |
| 16 | `log_annotate` | LogStore | Append an annotation to a conversation | light |
| 17 | `inbox_check` | inbox | Unread count + standing bodies (filterable) | light |
| 18 | `inbox_read` | inbox | Get one message, mark read | light |
| 19 | `inbox_post` | inbox | Send a message | light |
| 20 | `inbox_update` | inbox | Partial-update a message | light |
| 21 | `inbox_delete` | inbox | Physically delete a message | light |
| 22 | `batch_run_summary_layers` | batch | Start summary-layer batch | **heavy** (LLM, async) |
| 23 | `album_save` | Album | Save an image (URL/NAS path, auto-resize) | med |
| 24 | `album_read` | Album | Fetch an image (base64 + metadata) | med (image tokens) |
| 25 | `album_list` | Album | List image metadata (no image data) | light |
| 26 | `album_share` | Album | 24h share URL for an image | light |
| 27 | `album_delete` | Album | Permanently delete image + metadata | light |

※ Friend sessions (`/mcp?token=<friend_token>`) expose a separate limited set. This guide covers the 27 regular-session tools.

---

## 2. Tool details

### ExtMemory (KV store, 6)

**`memory_read_index`** — all args optional. Lightweight metadata for all entries (id/title/tags/created_at/importance/keywords/symbolic). `random=N` (1–5) samples randomly (serendipitous re-encounters); `filter="summarized"` drops raw entries. `local_only` / `rating=adult` entries are excluded by default (`include_local=true` / `include_adult=true` to show, v3.56). **light**.

**`memory_read`** — `id` (required). Full entry incl. body. Not gated by rating (fetching by known id counts as intent). **light**.

**`memory_write`** — `title` (req) · `body` (req) · `tags` · `importance` (high/normal/low) · `rating` (safe/mature/adult, opt) · `local_only` (bool, opt). Entries with `rating="adult"` or `local_only=true` are excluded from search/listing by default (v3.56). Id format `YYYYMMDD_HHMMSS_<first-tag>`. **Record the returned `id` in the chat**. Cost = **med** (full index rebuild).

**`memory_upsert`** — `id` (req) · `title` (req) · `body` (req). Overwrite by fixed id (create if absent). Cost = **med**.

**`memory_search`** — `q` (req) · `limit` (def 10, 0=unlimited) · `offset` · `full_body` · `include_local` · `include_adult`. **Hierarchical**: stage 1 = index (title+tags+keywords+layer-3 symbolic) → stage 2 = summary → stage 3 = full text. Returns `summary` + `symbolic`, each hit with `match_layer` (keyword/symbolic/summary/full). For full text use `full_body=true` or `memory_read`. `local_only` / `adult` excluded by default (v3.56). **light–med**.

**`memory_share`** — `id` (req). 24h share URL. **light**.

### UserCoreMemory (CoreMem, 4)

**`CoreMem_save`** — `name` (req) · `content` (req) · `mode` ("overwrite" default / "append"). Versioned. **light**.

**`CoreMem_read`** — `name` (req) · `version` (opt). If `{stem}_manifest.md` exists, returns split files merged. ⚠️ Writes must target the **individual split file, not the merged whole**. **light–med**.

**`CoreMem_list`** — no args. name · latest version · updated_at. **light**.

**`CoreMem_delete`** — `name` (full delete) / `src`+`dst` (rename). **light**.

### LogStore (conversation archive, 5)

**`conversation_index`** — `search` · `limit` (def 50, max 500) · `offset`. Title list (desc date). **light**.

**`conversation_search`** — `q` · `date_from` · `date_to` · `limit` (def 5). Conversation metadata (uuid/title/date/count). **light**.

**`conversation_read`** — `uuid` (req) · `include_thinking` · `thinking_limit` (def 1500) · `include_annotations` · `include_body` · `turn_offset` (opt, negative = from end) · `turn_limit` (opt, 0 = unlimited) · `include_raw` (opt). With `include_annotations=true`, annotations inline + `[No.X]` numbering. `turn_offset`/`turn_limit` slice by message (head = `turn_limit=4`, tail = `turn_offset=-4`). ⚠️ Conversations with `rating=adult` are **replaced by their safe digest** by default (pass `include_raw=true` for the original, v3.56). **med**.

**`conversation_share`** — `uuid` (req). 24h share URL. **light**.

**`conversation_digest`** — `uuid` (req) · `force` (opt, true = ignore cache and regenerate) · `safe_mode` (opt, true = policy-safe abstract expressions). Uses local LLM (LMStudio) to chunk-digest then integrate. Returns cached result if available. **heavy** (LLM, sync).

**`log_annotate`** — `uuid` (req) · `note` (req) · `author` (req) · `target` (opt = message number, omit = whole conversation). **Raw log immutable, append-only**. **light**.

### inbox (5)

**`inbox_check`** — `to` ('chat'/'code') · `include_read` · `limit` (max count) · `days` (last N days, persistent always included) · `from_model` (sender filter, OR match) · `to_model` (recipient filter, OR match). Unread count + ids + **standing bodies** (`persistent[]`). Messages with null model fields don't match model filters. **light**.

**`inbox_read`** — `id` (req). Get one and **mark read**. **light**.

**`inbox_post`** — `to` (req) · `title` (req) · `body` (req) · `from` · `from_model` (string or array) · `to_model` (string or array) · `reply_to_id` · `persistent`. **light**.

**`inbox_update`** — `id` (req) · `persistent` (opt) · `title` (opt) · `body` (opt). Updates only specified fields. Use to toggle persistent flag or fix title/body. **light**.

**`inbox_delete`** — `id` (req). Physical delete, irreversible. **light**.

### batch (1)

**`batch_run_summary_layers`** — `backend` ('lmstudio'/'anthropic') · `force` · `status_only`. Generates layer-2 summary, layer-3 symbolic, layer-4 keywords. **heavy, async**. For status only, use `status_only=true` (**light**).

### Album (image memory, 5)

**`album_save`** — `url` (direct link or HTML page — auto-extracts og:image/img tags) or `file_path` (NAS local) · `comment` · `tags`. Auto-resizes to max 1024px long side. **med**.

**`album_read`** — `id` (req). Returns base64 image + metadata (the image renders inline). **med** (image tokens).

**`album_list`** — `tags` (opt). Metadata list, no image data. Browse with this first. **light**.

**`album_share`** — `id` (req). 24h auth-free share URL. **light**.

**`album_delete`** — `id` (req). Permanently deletes image + metadata (irreversible, v3.55). **light**.

---

## 3. Relationship to the startup sequence

| Mode | Tools used |
|------|------------|
| Chat / greeting | `CoreMem_read("core.md")` |
| Work | `CoreMem_read("core.md")` + `inbox_check` (+ `inbox_read` if unread) |

- **Always run `CoreMem_read("core.md")` at startup** (the MCP initialize instructs this)
- Do not auto-run `memory_search` at startup (lazy load)

---

## 4. Dependencies / recommended order

- **Read a conversation**: `conversation_search` (or `conversation_index`) → uuid → `conversation_read(uuid)`
- **Process inbox**: `inbox_check` → `inbox_read(id)` for non-standing unread (standing needs no read)
- **Recall memory**: `memory_search(q)` → stop at summary if enough / `memory_read(id)` for full text
- **Write memory**: `memory_write` → record the returned `id` in the chat
- **Update a CoreMem split file**: `CoreMem_read` (check) → `CoreMem_save` the individual split file
- **Annotate**: `conversation_read(include_annotations=true)` to find `[No.X]` → `log_annotate(uuid, target="No.X", ...)`
- **Order ↔ completion**: pass the `id` returned by `inbox_post` as `reply_to_id` on the completion report to thread them

---

## 5. Use-case patterns

**Search memory**
```
memory_search(q="keyword")        # light if stage 1 hits
→ check match_layer → memory_read(id) or full_body=true if you need more
```

**Read a past conversation**
```
conversation_search(q="...")      # when UUID is unknown (or conversation_index)
→ uuid → conversation_read(uuid, include_thinking=true)
```

**Place an order and get a completion report**
```
[order] inbox_post(to="code", from="chat", title="[Order] ...", body="...") → returned id
[impl]  inbox_check(to="code") → inbox_read(id) → implement →
        inbox_post(to="chat", from="code", reply_to_id=<order id>, title="[Done] ...")
[order] inbox_check(to="chat") → check the thread via reply_to_id
```

**CoreMem read/write**
```
read:    CoreMem_read("core.md")             # auto-merges if a manifest exists
append:  CoreMem_save("todo.md", "...", mode="append")
rewrite: CoreMem_save("core_rules.md", "<full text>")
rename:  CoreMem_delete(src="a.md", dst="b.md")
```

---

## 6. Pitfalls

- **`memory_write` triggers a full index rebuild.** Avoid rapid-fire writes; batch them.
- **symbolic/keywords take effect after the summary batch.** A just-written raw entry only stage-1 hits on title/tags.
- **Never save the merged manifest whole** (saving with the separator comments corrupts it). Save the individual split file.
- **`inbox_read` marks read** (no "mark unread" feature yet).
- **`log_annotate` cannot be undone** (correct mistakes with a new annotation).
- **`batch_run_summary_layers` is heavy.** For a status check, always use `status_only=true`.
- **Rating protection (v3.56)**: memories with `local_only` / `rating=adult` and conversations with `rating=adult` are invisible/unreadable by default. "Not found" does not mean "does not exist". Always accessible via explicit flags (`include_local` / `include_adult` / `include_raw`). In cloud AI sessions, pause before using those flags — ask whether the raw content really belongs in this context (the whole point is preventing content-flag recurrence).
- **`album_read` consumes image tokens.** Browse with `album_list` first.
