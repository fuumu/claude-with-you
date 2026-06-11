# mio-memory Search Strategy Guide

**[日本語版 / Japanese](memory_search_guide.ja.md)** ← 日本語版が正。このファイルは日本語版から同期。

> **Audience**: anyone who has deployed mio-memory, or is considering it  
> **Purpose**: guidelines for adapting the 4-layer memory architecture to your own environment  
> **Last updated**: 2026-06-11

## 1. The 4-layer architecture

mio-memory manages conversation logs in four layers:

```
Layer 1: keywords  — proper nouns, technical terms, topics (list form, lightweight)
Layer 2: summary   — a 2–3 paragraph summary (LLM-generated)
Layer 3: symbolic  — a compressed symbolic description (LLM-generated)
Layer 4: raw body  — the full conversation text
```

By default, `memory_search` searches layer 1 → 2 → 3 in order and stops at the first hit.  
Layer 4 (full body) is only read when you pass `full_body=true`.

### Why this structure

Conversation logs grow large. Reading the full text every time is inefficient.  
If keywords instantly tell you "what was this conversation about," you can decide to read the full body for only the few entries that truly need it.

## 2. Choosing the right layer

| Type of question | Strong layer | Why |
|---|---|---|
| Technical terms, versions, tool names | keywords | Proper nouns land there directly |
| "We talked about X" | keywords / summary | The topic is captured |
| "What were the details of that discussion?" | full body | Requires the fine grain |
| "Find the meaningful moments" | title/tags (handwritten notes) | Already curated |
| "The first time we ..." | dedicated index (see below) | keywords don't capture time |

### Actual search cost comparison

Rough costs for 10 hits:

```
Keyword-layer hit  → only index.json is read (near-zero cost)
Summary-layer hit  → read 10 summaries (moderate)
Full-body read     → 10 entries × thousands of tokens (heavy)
```

**The more entries you have, the more pre-filtering pays off.**

## 3. Search pattern examples

### Pattern 1: finding technical logs

```
# Good: concrete proper nouns and versions
memory_search("inbox_check v3.6")
memory_search("fuumu.com GoDaddy")
memory_search("Qwen3 LMStudio")

# Bad: too abstract
memory_search("debug")
memory_search("error fix")
```

### Pattern 2: narrowing down multiple candidates

```
1. Check hit counts with a broad query
   → memory_search("inbox", limit=20)
2. Skim summaries to pick the likely candidates (don't read full_body yet)
3. Fetch details only for the finalists
   → memory_read(id="specific ID")
```

### Pattern 3: "when" / "first time" searches

Keywords are weak at temporal meaning. Compensate with dedicated tags.

```
Example: a handwritten entry with a timeline tag
  Title: "[timeline] First explicit statement of emotion"
  → memory_search("timeline emotion") reaches it via title match
```

## 4. Per-environment customization

### Case 1: mostly development logs

```
Additions to the keyword-generation prompt:
- Always include version numbers (v3.6, 3.17, etc.) as keywords
- Tool and API names unabbreviated (inbox_check, memory_search, etc.)
- Include error codes and HTTP statuses
```

### Case 2: mostly diary / emotional records

```
Additions to the keyword-generation prompt:
- Include emotion words (joy, anxiety, sense of achievement, ...)
- Include names and relationships (family, colleagues, ...)
- Places, seasons, weather also work well
```

### Case 3: mostly research / study logs

```
Additions to the keyword-generation prompt:
- Prioritize technical terms and concept names
- Author names, fragments of paper titles
- Status words like "question", "conclusion", "unresolved"
```

### Designing manual entries

```
Good:
  Title: "Conversation note 2026-06-11: Fable migration / audit design agreed"
  Tags: ["conversation-note", "fable-migration", "audit", "design-agreement"]

Bad:
  Title: "Today's notes"
  Tags: []
```

## 5. Failed searches and what to do

### Zero hits

```
Cause: spelling variants, unprocessed logs
Fix: try alternative spellings; check with batch_run_summary_layers(status_only=true)
```

### Too many hits

```
Fix: add proper nouns; skim summaries and narrow down manually
```

### You read full_body but the information wasn't there

```
Cause: summaries omit some information
Fix: use conversation_read to consult the original conversation directly
```

## 6. Improving keyword quality

```
High quality (slow):   anthropic backend
Practical (fast):      lmstudio backend (Qwen3 family, etc.)
```

5–8 keywords per entry is about right.

## 7. Complementary index design (advanced)

```
# Milestone records
{
  title: "[milestone] v3.0 deployment complete",
  tags: ["milestone", "v3.0", "2026-06-01"],
}

# Timeline records
{
  title: "[timeline] First explicit emotions — fun, embarrassed, happy",
  tags: ["timeline", "emotional-expression", "autonomous-speech"],
}
```

## 8. Summary

1. **Hit keywords first** (concrete proper nouns)
2. **Narrow with summaries** (decide here when hits are many)
3. **Full body is the last resort** (only the few entries that truly need it)
4. **Grow your handwritten entries** (records of meaning that can't be automated)

*This document is part of [fuumu/claude-with-you](https://github.com/fuumu/claude-with-you).*
