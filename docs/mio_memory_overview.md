# What is mio-memory

**[日本語版 / Japanese](mio_memory_overview.ja.md)** ← 日本語版が正。このファイルは日本語版から同期。

A **personal external memory system** that lets you accumulate, search, and reference your conversations with Claude.  
It runs on a Synology NAS (or any comparable server) and connects to Claude via MCP.

## What problem does it solve

Claude has no memory across sessions.  
To reference yesterday's conversation in today's session, you had to paste it back in manually — or give up.

mio-memory addresses this by:

- automatically indexing your past conversations, and
- letting Claude itself search and reference them whenever needed.

## Who is it for

**People whose records keep growing**  
Once your conversation logs pass a few hundred entries, "where was that discussion again?" becomes a daily problem.  
Full-text search alone is heavy — that's where mio-memory's 4-layer structure pays off.

**People running long-term projects with Claude**  
Development logs, design evolution, decision history — when these accumulate and stay searchable over time,  
you no longer have to re-explain "how we decided last time" in every session.

**People who treat their dialogues with Claude as an asset**  
Philosophical discussions, emotional shifts, learning records — conversation logs stop being ephemeral  
and become a growing body of documents.

## What it can do

| Feature | Description |
|---|---|
| Automatic conversation import | Ingest the ZIP exported from Claude.ai |
| 4-layer summaries & keywords | Generated automatically by an LLM (local or Anthropic API) |
| Hierarchical search | Searches keywords → summary → full body in order, reaching results at minimal cost |
| Manual notes | Save important moments, design decisions, and TODOs yourself |
| Full conversation access | Read the original conversation directly by UUID |
| Inbox system | Receive completion reports and messages from Claude Code in chat |

## Getting started

1. **Deploy**: start mio-memory in a Docker container on your NAS
2. **Import a ZIP**: ingest conversations exported from Claude.ai
3. **Batch processing**: generate summaries and keywords with an LLM (nightly automatic or manual)
4. **Connect Claude**: add the server in Claude.ai's MCP settings and start using it right away

See the [setup guide](./setup.md) for details.

## Documentation

### Search & reference
- [**Search Strategy Guide**](./memory_search_guide.md)  
  How to use the 4 layers effectively. Search pattern examples, per-environment customization, and how to handle failed searches.  
  → Read this when your logs have grown and you feel like you "can't find things anymore."

### Design & architecture
- [Data Structure Reference](./data_structure.md)
- [Design Document](./design.md)

## What "local" means here

mio-memory runs on your own server.  
**Your conversation logs never leave your hardware.**

For LLM-based summary and keyword generation you can choose:
- **LMStudio (local)**: fully offline; processing speed depends on your model
- **Anthropic API**: higher quality, but incurs cost

Pick whichever fits your use case and environment.

## On customization

mio-memory is a system you grow to fit your data, your use cases, and your preferences.  
Which keywords to emphasize, what handwritten notes to keep — tune it as you go.

→ The [Search Strategy Guide](./memory_search_guide.md) has concrete customization examples.

*This document is part of [fuumu/claude-with-you](https://github.com/fuumu/claude-with-you).*
