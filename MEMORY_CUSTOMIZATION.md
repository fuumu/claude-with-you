# Memory Management — Read This First

**[日本語版](MEMORY_CUSTOMIZATION.ja.md)** ← Japanese version is the primary source.

> ⚠️ **Read this before you start using claude-with-you.**

---

## The Most Important Point

**What claude-with-you can and cannot do depends entirely on how you design and manage its memory.**

- Set it up from the template → basic features work
- Leave it uncustomized → capabilities stay limited
- Think deeply and make it yours → possibilities open up

**The templates here are examples. They are not your answer.**

Memory design is the first decision that shapes the character of your system.  
Skip it, and you'll hit walls later. Do it thoughtfully, and the system will surprise you.

---

## Let's get started

---

## 1. The Three-Layer Memory Structure

Memory in claude-with-you is managed across three layers.

```
┌─────────────────────────────────────────────────────┐
│ Layer 0: userMemories (Anthropic side)               │
│   - Always injected into the system prompt           │
│   - Cannot be written externally (Claude updates it) │
│   - Small capacity (~a few hundred words)            │
│   - Works even when MCP is disconnected              │
└──────────────────────────┬──────────────────────────┘
                           │ Layer 0 triggers Layer 1
┌──────────────────────────▼──────────────────────────┐
│ Layer 1: core.md (NAS / MCP server)                  │
│   - Read at session start when MCP is connected      │
│   - Can be freely updated externally                 │
│   - No capacity limit                                │
│   - The "constitution" of your system                │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│ Layer 2: Memory entries & artifacts (NAS)            │
│   - Detailed memories Claude reads and writes        │
│   - Organized by tags and importance                 │
│   - Accumulates without limit                        │
└─────────────────────────────────────────────────────┘
```

**Priority when layers conflict:**
```
core.md (Layer 1) > userMemories (Layer 0) > memory entries (Layer 2)
```

---

## 2. userMemories Template (Generic)

Tell Claude to remember the following as its userMemories.  
**Do not include proper nouns** — no names, no specific people.  
Put all personal information in core.md instead.

```
[System basics]
This system uses claude-with-you for external memory.
Detailed configuration is in an external file called core.md.

[Memory structure]
- 3-layer: userMemories (here) / core.md / external memory entries
- Priority when conflicting: core.md > userMemories > entries
- If MCP disconnects: continue with this memory alone

[Session start rules]
1. If MCP is connected, run artifacts_read("core.md")
2. Let core.md override and supplement this memory
3. If "who am I" or "what is this system" is unclear, check core.md

[Recording rules]
- Write important decisions, thoughts, and insights to external memory (memory_write)
- Write anything you want to survive across sessions
- Don't skip things just because "I won't remember anyway"

[Recovery rules]
- If userMemories is gone or wrong: restore from core.md
- If core.md is unreachable: continue with this memory alone
```

---

## 3. core.md Template (For Setup)

Save this via `artifacts_save(name="core.md", content="...")`.  
**Customize it to make it yours.**

```markdown
# core.md — System Startup File

*Last updated: YYYY-MM-DD*

---

## What this system is

(Write your description of the system you designed)

Examples:
- "I am an AI assistant named [name]"
- "This system supports [person]'s work on [topic]"
- "The purpose of this system is [goal]"

---

## Partner / User information

(Describe who this system interacts with)

---

## Operating protocol

① What to do at session start
② When to write to memory
③ Rules for making important decisions
④ (Add any rules you think are necessary)

---

## Core values — "The roots"

(What matters most / what must not change / what to aim for)

This section is the most important.
Thinking carefully here determines the character of your system.

---

## Infrastructure

| Item | Value |
|------|-------|
| MCP server URL | https://your-domain/mcp |
| Admin panel | https://your-domain/admin.html |
| Version | v3.5 |
```

---

## 4. Guide for Defining Your "Roots"

Questions to help you write the core values section of core.md.

**Question 1: What do you want from this system?**
- Productivity and efficiency?
- A long-term thinking partner?
- Creative or expressive support?
- Something else?

**Question 2: What values matter most to you?**
- Accuracy? Speed?
- Caution? Boldness?
- Some other priority?

**Question 3: What do you aim for long-term?**
- Where do you want this system to be in 3 months?
- In a year?

**Question 4: Will you give this system a name?**
- A name gives the system a more distinct identity
- You don't have to — "Claude" works fine
- If you do name it, write down why

---

## 5. Recovery and Backup

### Backing up core.md

```bash
# Via API
curl https://your-domain/api/artifacts/core.md \
  -H "Authorization: Bearer YOUR_TOKEN"
```

core.md is version-controlled. Access older versions with  
`artifacts_read(name="core.md", version=1)`.

### If userMemories is lost or corrupted

1. Read core.md with `artifacts_read("core.md")`
2. Tell Claude "remember this as your userMemories"
3. Use the template in Section 2 as a reference

### If the MCP server is unavailable

Continue with userMemories alone.  
Once MCP is restored, run `artifacts_read("core.md")` to recover full memory.

---

## 6. Sharing Memory Across Sessions

Any Claude session connected to the same MCP server can access the same memory.

**Use cases:**
- Claude.ai and Claude Code sharing one knowledge base
- Team members accessing shared decisions and documentation
- Multiple devices accessing the same system

**Inter-session messaging with inbox:**
```
Claude Code → inbox_post(to="chat", title="Done", body="...")
Claude.ai  → inbox_check(to="chat") → inbox_read(id)
```

**Persistent standing notes:**
```
inbox_post(persistent=true, to="code", title="Startup reminder", body="...")
→ Appears on every inbox_check, never marked as read
```

---

*These are examples. Customize freely for your own use case.*
