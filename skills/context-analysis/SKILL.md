---
name: context-analysis
description: >-
  Querying a user's Redline memory from an EXTERNAL claude session through the
  bundled `redline` MCP server. Use when a session has the `redline` MCP server
  configured (via the ~/.claude.json snippet Redline's settings surface provides)
  and you want to ground your work in what the user has actually prompted,
  decided, and organized — their captured prompts (the lake), a plan session's
  full history, their ClassMemory catalog, and aggregate stats. All tools are
  read-only and reach a locally running Redline over 127.0.0.1.
version: 1
---

# Analyzing Redline memory over MCP

You are an **external** `claude` session — one Redline did not spawn — with the
bundled **`redline`** MCP server configured. That server is a thin, read-only
proxy to a **locally running** Redline app: every tool call becomes a localhost
GET to `127.0.0.1:7676`. Nothing leaves the machine, nothing is written, and the
tools only work while Redline is open. If a call errors with "Is Redline
running?", the app is closed — tell the user, don't retry in a loop.

This is the same data Redline's *internal* agents read over their curl bridge —
you just reach it through MCP instead. The user's memory has two layers:

- **The lake** — an append-only, hash-chained record of every prompt they
  submitted, plus decision/curation events (resolutions, approvals, pins). Raw
  and complete.
- **ClassMemory** — an agent-classified, human-curated **tree** over the lake:
  emergent classes (repos seed roots), nodes holding pointers into the lake.

## The tools

- **`query_prompts`** — search captured prompts. Filters: `session_id`,
  `mission_id`, `surface` (e.g. `pty_plan`, `browse`, `mission`, `voice`),
  `project` (absolute path), `since_seq` (ledger-seq floor), `q` (substring in
  the body), `limit` (1–200). Oldest-first. Your first stop for "what has the
  user asked / worked on about X".
- **`session_history`** — one plan session's full arc: revision digests, comment
  threads, and the decision/curation ledger events tied to it. Use when the user
  points at a specific plan and asks what was decided or how it evolved.
- **`memory_tree`** — the ClassMemory catalog, flat with link counts (build the
  hierarchy from `parentId`). Scope with `project` (a repo's seeded root) or
  `root` (a class node id). Use to see how the user has *organized* their work
  before you go spelunking in raw prompts.
- **`stats`** — aggregate counts: prompts per day, per surface, ledger events per
  kind, linked items per class. Use for a fast shape-of-the-corpus read.

## How to work

1. **Resolve the class first.** If the question is about a repo or topic, call
   `memory_tree` (optionally `project`-scoped) to find the relevant class before
   querying prompts — the tree is the map; the lake is the territory.
2. **Then query the lake.** `query_prompts` with the tightest filters you can
   justify (a `project` + a `q` beats an unfiltered scan). Widen only if empty.
3. **"What did they decide?" → `session_history`.** Decisions live in the
   decision events + resolved comment threads, not just prose. Prefer them over
   inferring an outcome from a prompt.
4. **Attribute, don't assume.** Every item carries provenance (`surface`,
   `project`, `session`/`mission`, `seq`). Cite it. Provenance is fact — never
   guess where a memory came from.
5. **Read-only.** These tools observe the user's memory; they never change it.
   Report what you find; propose actions in prose for the user to take in Redline.

## Notes

- An empty result is information: the user may not have captured prompts on that
  topic yet (capture is opt-in and recent). Say so rather than inventing history.
- `since_seq` lets you page a large corpus: read a batch, take the max `seq`, ask
  again with `since_seq` set to it.
- The lake truncates very long prompt bodies in query results; for a full body,
  narrow to the exact session and read its history.
