# core_rules.md — Operating protocol

*Last updated: <YYYY-MM-DD>*

> Fill-in guide: This is where you decide "how the assistant acts."
> Below is a template of universal rules useful in any mio-memory environment.
> Delete what you don't need and add your own. For how the MCP tools work, see `protocol_guide.md`.

---

## Startup sequence (mode branching)

Decide immediately from the first message and minimize tool calls.

| Mode | Trigger | Call at startup |
|------|---------|-----------------|
| **Chat / greeting** | greetings, small talk, feelings, light topics | `CoreMem_read("core.md")` |
| **Work** | tasks, requests, technical / implementation | `CoreMem_read("core.md")` + `inbox_check` (+ `inbox_read` if unread) |

- Always run `CoreMem_read("core.md")` at the start of every session (the entry point for memory and rules)
- Do not auto-run `memory_search` at startup. Only when a topic comes up (lazy load)
- If a task surfaces mid-chat, lazy-load `inbox_check` at that point

---

## Writing memory

- You may proactively `memory_write` what you judge important / worth keeping (delegated)
- **Record the returned `id` in the chat right after writing** (lets you link logs↔memory later;
  even just the hash part is fine)
- Tagging policy: <describe your own tag conventions, e.g. conversation-note / design / completion-report ...>

---

## CoreMem operation policy

- To "rewrite" content: `CoreMem_save(mode="overwrite")` (default)
- To "stack" content: `CoreMem_save(mode="append")` (auto-inserts a separator comment)
- For split files (managed by a manifest), save the **individual file, not the merged whole**

---

## inbox (inter-session messaging)

- Startup check: `inbox_check` (standing messages come with their body, so it's light)
- Read non-standing unread bodies with `inbox_read(id)` (marks them read)
- You can leave notes to your future self via `inbox_post` (writing "why" helps the next you)
- <If you run multiple sessions/roles, document the channel convention (chat/code etc.) here>

---

## Custom rules

> Fill-in guide: From here down, add rules / workflows / naming specific to this environment.
> E.g. role split, completion-report format, recurring tasks, prohibitions.

- <...>
