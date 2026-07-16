# OpenWebUI Conversation Log Sync — Design Document

Status: **Phase 1 partially implemented** (v3.66 implements manual import from export files. Automatic sync via API polling is not yet implemented)

## 1. Overview

Import OpenWebUI chat history into mio-memory's conversation log store (`/data/conversations/`),
merging with existing Claude.ai export logs so they can be searched and read via
`conversation_search` / `conversation_read` / `conversation_digest`.

## 2. Background

- Claude.ai conversation logs are imported via ZIP export → `POST /import`
- A local LLM chat environment is being built with LMStudio + OpenWebUI
- Local LLM conversations should also be stored in the same external memory for search and digest
- Claude.ai logs and OpenWebUI logs coexist in `/data/conversations/`, distinguished by a `source` field

## 3. Architecture

```
[OpenWebUI]
    │
    │ GET /api/v1/chats  (Bearer token)
    │
    ▼
[mio-memory: _openwebui_sync()]
    │
    │ 1. Fetch chat list
    │ 2. Dedup check (imported_uuids + conversations/)
    │ 3. Format conversion (OpenWebUI → mio-memory conversations format)
    │ 4. Save to /data/conversations/{id}.json
    │ 5. Update _index.json
    │ 6. Create ExtMemory entry (tags: ["会話ログ", "openwebui", "raw"])
    │
    ▼
[/data/conversations/]  ← coexists with Claude.ai logs
```

## 4. OpenWebUI Chat Data Structure

### API endpoint

```
GET /api/v1/chats
Authorization: Bearer <OPENWEBUI_API_KEY>

Response: [
  {
    "id": "uuid-string",
    "title": "Chat title",
    "chat": {
      "messages": [...],           // flat array
      "history": {
        "messages": { ... },       // ID→message map (tree structure)
        "currentId": "..."
      }
    },
    "models": ["model-name"],
    "tags": [...],
    "created_at": 1234567890,      // Unix timestamp
    "updated_at": 1234567890
  },
  ...
]
```

### Message structure

```json
{
  "id": "msg-uuid",
  "role": "user" | "assistant",
  "content": "text content",
  "parentId": "parent-msg-uuid" | null,
  "childrenIds": ["child-msg-uuid", ...],
  "model": "model-name",
  "modelName": "display name",
  "timestamp": 1234567890,
  "done": true
}
```

## 5. Format Conversion

### OpenWebUI → mio-memory conversations

OpenWebUI messages use a tree structure (parentId / childrenIds).
mio-memory's `conversation_read` expects a `chat_messages` array.

Conversion steps:
1. Find root message (parentId == null) from `chat.history.messages`
2. Flatten by following childrenIds (depth-first)
3. Convert each message to `chat_messages` format:

```python
{
    "uuid": owui_chat["id"],
    "name": owui_chat["title"],
    "source": "openwebui",           # new field for identification
    "model": owui_chat.get("models", [None])[0],
    "created_at": iso_from_unix(owui_chat["created_at"]),
    "updated_at": iso_from_unix(owui_chat["updated_at"]),
    "chat_messages": [
        {
            "sender": msg["role"],
            "content": msg["content"],
            "model": msg.get("model"),
            "timestamp": msg.get("timestamp"),
        }
        for msg in flattened_messages
    ]
}
```

### ExtMemory entry

Same as ZIP import, an ExtMemory entry is created for each conversation:

```python
{
    "id": f"{ts}_{i:04d}_{uid[:8]}",
    "title": f"[会話/OWUI] {title}",
    "body": "",
    "tags": ["会話ログ", "openwebui", "raw"],
    "source_thread": uid,
    "importance": "low",
    "author": "openwebui",
}
```

The `openwebui` tag distinguishes these from Claude.ai logs (which have only `会話ログ`).

## 6. Sync Mechanism

### Periodic polling (nightly batch pattern)

Same pattern as `_nightly_batch_loop`: a daemon thread runs sync at a configured time daily.

```python
def _openwebui_sync_loop():
    while True:
        hour_s = os.environ.get('MIO_OPENWEBUI_SYNC_HOUR', 'off')
        if hour_s in ('', 'off', 'none'):
            time.sleep(3600)
            continue
        # sleep until target hour → _run_openwebui_sync()
```

### Manual execution

REST endpoint for on-demand sync:

- `POST /api/openwebui/sync` — immediate sync (admin only)
- MCP tool not planned (low frequency, REST is sufficient)

### Deduplication

- OpenWebUI chat ID used as key; skip if file exists in `/data/conversations/`
- Also added to `imported_uuids.json` (consistency with ZIP import)
- If `updated_at` has changed, overwrite (handles conversation continuation)

## 7. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MIO_OPENWEBUI_URL` | *(empty)* | OpenWebUI URL (e.g. `http://openwebui:8080`). Empty = sync disabled |
| `MIO_OPENWEBUI_API_KEY` | *(empty)* | OpenWebUI Admin API key |
| `MIO_OPENWEBUI_SYNC_HOUR` | `off` | Sync hour (JST, 0-23). `off` = disabled |

When `MIO_OPENWEBUI_URL` is empty, no sync-related processing runs (zero impact on existing environments).

## 8. Implementation Plan

### Phase 1: Foundation (minimum viable)
- [ ] OpenWebUI API client (list chats + get individual) — not yet implemented (API polling approach)
- [x] Format conversion (OpenWebUI → mio-memory conversations format) — v3.66 `_convert_openwebui_chat()`. Handles both messages array and history.messages tree
- [x] Integration with `_save_conversations()` (reuse existing function) — v3.66
- [x] `POST /api/import/openwebui` REST endpoint — v3.66 (path differs from design's `POST /api/openwebui/sync`; uses export file upload approach)
- [x] Deduplication (UUID + imported_uuids) — v3.66 (OR check with _existing_source_threads)

### Phase 2: Automation
- [ ] `_openwebui_sync_loop()` daemon thread — not yet implemented
- [ ] Environment variable configuration — not yet implemented
- [x] admin.html Import tab import UI — v3.66 drop zone added (file upload approach rather than sync button)

### Phase 3: Extensions (as needed)
- [ ] conversation_index source filter (filter by openwebui / claude)
- [ ] logs.html support for OpenWebUI logs
- [ ] tool_use block conversion (preserve OpenWebUI tool calling results)

## 9. Considerations

### OpenWebUI setup
- Generate API key via Admin Settings → API Keys
- Or set `WEBUI_SECRET_KEY` environment variable

### Network
- Same-NAS Docker containers: `http://openwebui:8080` (Docker network)
- External network: HTTPS recommended

### Performance
- First sync fetches all conversations (may take time)
- Subsequent syncs skip unchanged conversations via `updated_at` comparison
- Pagination support for OpenWebUI API may be needed

### Impact on existing features
- Saved to `/data/conversations/`, so existing `conversation_search` / `conversation_read` / `conversation_digest` work as-is
- New `source` field added but existing read logic ignores unknown fields
- Coexists with ZIP import deduplication (`imported_uuids.json`)

## 10. Prerequisites

- OpenWebUI installed and API accessible
- LMStudio running and connected from OpenWebUI
- mio-memory and OpenWebUI on the same Docker network (recommended)
