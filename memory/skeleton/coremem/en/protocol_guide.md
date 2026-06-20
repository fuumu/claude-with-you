# protocol_guide.md — MCP tool operating guide (mio-memory v3.44 / 19 tools)

*A reference a new session can read in one pass to learn how the MCP tools work.*
*This file is install-agnostic (the tool mechanics are common to every mio-memory). For environment-specific startup rules / naming, see `core_rules.md`.*

---

## 0. Big picture — 4 stores + 1 batch

mio-memory operates **four kinds of store** via MCP tools. Pick by the nature of the data.

| Store | Name | Backing | Nature |
|-------|------|---------|--------|
| **ExtMemory** | External memory (KV store) | `/data/memory/{id}.json` + `index.json` | High-volume, append-style. Notes/knowledge. Hierarchical-search target |
| **UserCoreMemory** | CoreMem | `/data/artifacts/` (versioned + symlinks) | Few, overwrite-style. Identity / rules / TODO |
| **LogStore** | Conversation archive | `/data/conversations/` + `/data/annotations/` | Immutable logs + append-only annotations. From ZIP import |
| **inbox** | Lightweight messaging | `/data/inbox/` | Inter-session messages. chat/code/friend channels |

Plus **batch** (summary-layer generation) grows ExtMemory in the background.

---

## 1. Tool list (5 groups / 19 total)

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
| 9 | `CoreMem_list` | UserCoreMemory | List files | light |
| 10 | `CoreMem_delete` | UserCoreMemory | Delete or rename (src/dst) | light |
| 11 | `conversation_index` | LogStore | Conversation title list (desc date) | light |
| 12 | `conversation_search` | LogStore | Search conversations by keyword/date | light |
| 13 | `conversation_read` | LogStore | Read conversation body | med |
| 14 | `conversation_share` | LogStore | 24h share URL for a conversation | light |
| 15 | `log_annotate` | LogStore | Append an annotation to a conversation | light |
| 16 | `inbox_check` | inbox | Unread count + standing bodies (light) | light |
| 17 | `inbox_read` | inbox | Get one message, mark read | light |
| 18 | `inbox_post` | inbox | Send a message | light |
| 19 | `batch_run_summary_layers` | batch | Start summary-layer batch | **heavy** (LLM, async) |

※ Friend sessions (`/mcp?token=<friend_token>`) expose a separate set of 6 tools. This guide covers the 19 regular-session tools.

---

## 2. Tool details

### ExtMemory (KV store, 6)

**`memory_read_index`** — no args. Lightweight metadata for all entries (id/title/tags/created_at/importance/keywords/symbolic). **light**.

**`memory_read`** — `id` (required). Full entry incl. body. **light**.

**`memory_write`** — `title` (req) · `body` (req) · `tags` · `importance` (high/normal/low). Id format `YYYYMMDD_HHMMSS_<first-tag>`. **Record the returned `id` in the chat**. Cost = **med** (full index rebuild).

**`memory_upsert`** — `id` (req) · `title` (req) · `body` (req). Overwrite by fixed id (create if absent). Cost = **med**.

**`memory_search`** — `q` (req) · `limit` (def 10, 0=unlimited) · `offset` · `full_body`. **Hierarchical**: stage 1 = index (title+tags+keywords+layer-3 symbolic) → stage 2 = summary → stage 3 = full text. Returns `summary` + `symbolic`, each hit with `match_layer` (keyword/symbolic/summary/full). For full text use `full_body=true` or `memory_read`. **light–med**.

**`memory_share`** — `id` (req). 24h share URL. **light**.

### UserCoreMemory (CoreMem, 4)

**`CoreMem_save`** — `name` (req) · `content` (req) · `mode` ("overwrite" default / "append"). Versioned. **light**.

**`CoreMem_read`** — `name` (req) · `version` (opt). If `{stem}_manifest.md` exists, returns split files merged. ⚠️ Writes must target the **individual split file, not the merged whole**. **light–med**.

**`CoreMem_list`** — no args. name · latest version · updated_at. **light**.

**`CoreMem_delete`** — `name` (full delete) / `src`+`dst` (rename). **light**.

### LogStore (conversation archive, 5)

**`conversation_index`** — `search` · `limit` (def 50, max 500) · `offset`. Title list (desc date). **light**.

**`conversation_search`** — `q` · `date_from` · `date_to` · `limit` (def 5). Conversation metadata (uuid/title/date/count). **light**.

**`conversation_read`** — `uuid` (req) · `include_thinking` · `thinking_limit` (def 1500) · `include_annotations` · `include_body` · `turn_offset` (opt, negative = from end) · `turn_limit` (opt, 0 = unlimited). With `include_annotations=true`, annotations inline + `[No.X]` numbering. `turn_offset`/`turn_limit` slice by message (head = `turn_limit=4`, tail = `turn_offset=-4`). **med**.

**`conversation_share`** — `uuid` (req). 24h share URL. **light**.

**`log_annotate`** — `uuid` (req) · `note` (req) · `author` (req) · `target` (opt = message number, omit = whole conversation). **Raw log immutable, append-only**. **light**.

### inbox (3)

**`inbox_check`** — `to` ('chat'/'code') · `include_read`. Unread count + ids + **standing bodies** (`persistent[]`). **light**.

**`inbox_read`** — `id` (req). Get one and **mark read**. **light**.

**`inbox_post`** — `to` (req) · `title` (req) · `body` (req) · `from` · `from_model` · `to_model` · `reply_to_id` · `persistent`. **light**.

### batch (1)

**`batch_run_summary_layers`** — `backend` ('lmstudio'/'anthropic') · `force` · `status_only`. Generates layer-2 summary, layer-3 symbolic, layer-4 keywords. **heavy, async**. For status only, use `status_only=true` (**light**).

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
