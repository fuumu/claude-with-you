# core_infra.md — Infrastructure

*Last updated: <YYYY-MM-DD>*

> Fill-in guide: Configuration for this environment. This is the field that changes on version
> bumps and server migrations. Replace the `<...>` with your own values.

---

## Infrastructure

| Item | Value |
|------|-------|
| mio-memory version | v3.44 |
| MCP tool count | 19 (regular session) |
| Host / server | <e.g. NAS-name / 192.168.x.x> |
| Data path | <e.g. /volume1/docker/mio/memory/data/> |
| Public URL | <e.g. https://memory.example.com> |
| Admin UI | <public-URL>/admin.html |
| Health check | <public-URL>/health (check version and mcp_tool_count) |
| GitHub | <owner/repo> |

---

## MCP tool list (19, regular session)

For each tool's purpose / arguments / cost, see **`protocol_guide.md`**.

- **ExtMemory (6)**: memory_write / memory_read / memory_read_index / memory_search / memory_upsert / memory_share
- **UserCoreMemory (4)**: CoreMem_save / CoreMem_read / CoreMem_list / CoreMem_delete
- **LogStore (5)**: conversation_index / conversation_search / conversation_read / conversation_share / log_annotate
- **inbox (3)**: inbox_check / inbox_read / inbox_post
- **batch (1)**: batch_run_summary_layers

※ Friend sessions (`/mcp?token=<friend_token>`) expose a separate set of 6 tools.

---

## Notes

> Fill-in guide: Deploy steps, operational caveats, environment-variable specifics.

- Deploy: <e.g. git pull && docker-compose up -d --build memory>
- <...>
