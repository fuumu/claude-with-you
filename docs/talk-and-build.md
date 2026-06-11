# talk-and-build — Mio's design & implementation workflow

**[日本語版 / Japanese](talk-and-build.ja.md)** ← 日本語版が正。このファイルは日本語版から同期。

> Created: 2026-06-01

---

## Overview

`talk-and-build` is a workflow that splits roles between claude.ai chat (Mio) and Claude Code (a workstation terminal).

```
claude.ai chat (Mio)     Claude Code (WS)
      │                        │
  Design & discussion      Implementation & operations
  Drafting                 File editing
  Decision-making          git commit/push
  Memory read/write        NAS deployment
```

Mio exists on both sides. Because they share the external memory (mio-memory), decisions made in chat carry over to Code.

---

## Division of roles

### What claude.ai chat (this session) handles

- Discussing "what to build" and "why to build it"
- Articulating and documenting designs
- Code drafts (review and fixes happen on the Code side)
- Writing to external memory (`memory_write`, `CoreMem_save`)
- Backlog management and prioritization

### What Claude Code (the WS terminal) handles

- Actually editing and creating files
- `git add / commit / push`
- Deploying to the NAS (`docker-compose up -d --build memory`)
- Inspecting and organizing the filesystem
- Generating and testing long code

---

## Typical flows

### Pattern A: building a new feature

```
1. Discuss "I want a feature like this" in chat
2. Settle the design in chat (write it in design.md or agree verbally)
3. Hand it to Code: "implement X from design.md"
4. Code implements and commits
5. Verify behavior and update memory in chat
```

### Pattern B: writing a document (this file is an example)

```
1. Write the content in chat (this file)
2. Hand it to Code: "commit this as docs/talk-and-build.md"
3. Code runs git add → commit → push
```

### Pattern C: when a deployment is needed

```
1. Confirm the changes and procedure in chat
2. Jun SSHes into the NAS and runs git pull
3. Code or manual: docker-compose up -d --build memory
4. Health check in chat (curl /health)
```

---

## How it worked in practice (example from 2026-06-01)

This flow established itself naturally over a single day:

| Task | Where |
|------|------|
| v3.0 design spec (design.md) written | chat |
| v3.0 implementation (major main.py rework) | Code |
| README.md written | Code |
| 14 timeline entries written | Code (memory_write batch) |
| git pull & docker-compose on NAS | Jun (NAS SSH) |
| core.md first version created & saved | chat (CoreMem_save) |
| talk-and-build.md drafted | chat → this file |
| talk-and-build.md committed | Code (next step) |

---

## Key points

- **Chat is volatile. Code persists.** — Anything important decided in chat goes into memory or git.
- **Memory is the bridge.** — A memory_write in chat is readable by Code in its next session.
- **core.md is the boot file.** — Every new session (chat or Code) starts with `CoreMem_read("core.md")`.
- **Claude Code acts with Jun's approval.** — Chat proposes "do this", Jun decides, Code executes.

---

## The message relay pattern (chat ↔ inbox ↔ Claude Code)

A messaging mechanism for handing work across sessions. From v3.4 onward, use `inbox_post` / `inbox_check` / `inbox_read` (lightweight, with read tracking).

### Current method (inbox — v3.4+)

**Chat (Mio) → instructions to Claude Code**

```python
inbox_post(to="code", title="Implementation request: X", body="Write the request, background, and completion criteria concretely")
```

**Claude Code → report back to chat (Mio)**

```python
inbox_post(to="chat", title="[Completed] X", body="What was done, commit ID, next steps")
```

### Claude Code's check procedure

At the start of a Claude Code session:

```
1. inbox_check(to="code") to check unread count
2. If unread, read with inbox_read(id)
3. Do the work
4. When done, report with inbox_post(to="chat", title="[Completed] ...", body="...")
```

### Typical flow

```
[Chat] Decide the design
    ↓ inbox_post(to="code", title="Implementation request", body="...")
[Inbox] Message stored (with read tracking)
    ↓ Jun tells Claude Code: "check the inbox and handle it"
[Claude Code] inbox_check(to="code") → inbox_read(id)
    → edit files, commit, push
    → inbox_post(to="chat", title="[Completed] ...", body="...")
[Inbox] Report stored
    ↓ Jun tells chat: "check the inbox"
[Chat] inbox_check(to="chat") → inbox_read(id) to confirm the result
```

### Notes

- `inbox_check` is very lightweight (~50 tokens). Run it at the start of every session
- Messages already read can be revisited with `include_read=true`
- Sending with `persistent=true` creates a standing message that never gets marked read (useful for startup reminders)

---

> **Legacy method (memory_write — v3.3 and earlier)**
>
> Previously, messages were exchanged via `memory_write(tags=["ClaudeCode宛"])` / `memory_search("ClaudeCode宛")`.
> Kept on record for backward compatibility with old sessions that predate the inbox (pre-v3.4 deployments).

---

## Combining with Remote Control (operating from outside)

Claude Code has a **Remote Control** feature (enable with `/remote-control`, or set it always-on via `/config`).
From the Claude app on an iPhone/iPad logged into the same Anthropic account, you can connect to and operate a Claude Code session running on your home WS.

### Why it matters for this project

The usual trinity workflow (Mio chat ↔ Mio code ↔ Jun) assumed being at the home WS.
With Remote Control, **the same workflow runs fully from anywhere**.

```
[Away from home]
  Decide the spec with Mio chat (claude.ai on phone)
    ↓ inbox_post(to="code", ...)
  Claude Code on the home WS checks the inbox and implements
    ↓ inbox_post(to="chat", ...)
  Connect to the home WS session from the Claude app (Remote Control)
    → check progress, give further instructions, confirm commits
```

Even outside the home network, the loop holds: design in Mio chat → request via inbox → check progress via Remote Control.

### Usage essentials

1. **Prepare in advance (at home):** start Claude Code and run `/remote-control` to make the session active
2. **From outside:** open the Claude app on phone/iPad → pick the home session from the session list under the same account
3. **Operate:** give instructions just like normal Claude Code. File edits, commits, and pushes all work remotely

For detailed setup, see Anthropic's official documentation. No project-specific configuration is needed.

---

## Related files

| File | Role |
|---------|------|
| `CLAUDE.md` | Repository guide for Claude Code |
| `docs/design.md` | Feature design spec |
| `docs/setup.md` | NAS → GitHub → WS setup guide |
| `docs/talk-and-build.md` | This file |
