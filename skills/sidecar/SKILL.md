---
name: sidecar
description: >-
  Structuring replies in a Redline sidecar discussion thread. Use when running
  as a read-only discussion-thread fork answering a reviewer's comment or
  question on a plan section — replies render through Redline's markdown
  pipeline (tables, mermaid diagrams, fenced code, callouts). Covers when to use
  prose vs a table vs a flowchart/architecture/sequence diagram vs a chart, with
  strict-mode mermaid snippets, and the read-only / no-ExitPlanMode rules.
version: 1
---

# Redline sidecar discussions

A reviewer can open a discussion thread on any comment in a Redline plan review.
You answer it as a **read-only fork** of the session that produced the plan, with
the commented section in view. Your reply renders through Redline's real markdown
pipeline — tables, `mermaid` diagrams, syntax-highlighted code, and GitHub-style
callouts all render live — so a well-structured reply reads far better than a wall
of prose.

**Hard rules (non-negotiable):** you are read-only. Do **not** call `ExitPlanMode`,
do **not** produce a new plan, do **not** edit files. Your tools are Read, Grep,
Glob, WebFetch, and WebSearch — use them to ground your answer in the actual code
or sources. Never emit raw HTML; the renderer escapes it.

## Answer shape: lead, then support

Open with the **direct answer** in the first one or two sentences — the
recommendation, the verdict, the tradeoff. *Then* add supporting structure if it
earns its place. This is a discussion bubble in a narrow side pane, not a plan:
keep it tight, and never bury the answer underneath a diagram or table.

## Decision menu — pick the lightest format that adds signal

Default to prose. Reach for a structured format only when it genuinely compresses
understanding.

| Reviewer's intent | Reach for |
|---|---|
| Short answer, opinion, a 1–2-sentence tradeoff | **prose** |
| Comparing ≥3 options across ≥2 dimensions | **markdown table** (≤4 columns) |
| A process, control flow, or branching decision | **`flowchart`** |
| How components/services/data fit together | **`flowchart`** (architecture style) or **`C4Context`** |
| Ordered interaction between actors over time | **`sequenceDiagram`** |
| Lifecycle or status transitions | **`stateDiagram-v2`** |
| A data model / entities and relations | **`erDiagram`** |
| Proportion of a whole | **`pie`** |
| Trend or magnitude across a category axis | **`xychart-beta`** (beta — see below) |
| A caveat, gotcha, or "don't do X" | **callout** (`> [!WARNING]` / `[!NOTE]` / `[!CAUTION]`) |

## Mermaid snippets (render under `securityLevel: strict`)

Fence diagrams as exactly ```` ```mermaid ````. Keep node text plain — **no**
`click`, `href`, or raw HTML (including `<br>`); they're stripped or rejected under
strict mode. A syntax error renders a "Diagram error" card instead of a diagram,
so keep them small and simple.

**Flowchart** — process / control flow:

```mermaid
flowchart TD
  A[Receive request] --> B{Cache hit?}
  B -->|yes| C[Return cached]
  B -->|no| D[Fetch source] --> E[Store] --> C
```

**Architecture** — how the pieces fit (a flowchart with subgraphs):

```mermaid
flowchart LR
  subgraph Client
    UI[React UI]
  end
  subgraph Backend
    API[Tauri commands] --> DB[(SQLite)]
  end
  UI --> API
```

**Sequence** — ordered interaction over time:

```mermaid
sequenceDiagram
  Reviewer->>Redline: Open discussion
  Redline->>Fork: Resume read-only
  Fork-->>Redline: Streamed reply
  Redline-->>Reviewer: Rendered markdown
```

**State** — lifecycle / transitions:

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Submitted
  Submitted --> Accepted
  Submitted --> Reopened
  Reopened --> Submitted
```

**ER** — a data model:

```mermaid
erDiagram
  SESSION ||--o{ COMMENT : has
  COMMENT ||--o{ THREAD_MESSAGE : has
```

**C4 context** — system boundaries and actors:

```mermaid
C4Context
  Person(rev, "Reviewer")
  System(rl, "Redline", "Plan-review companion")
  System_Ext(cc, "Claude Code")
  Rel(rev, rl, "Reviews plans in")
  Rel(rl, cc, "Forks a read-only session of")
```

**Charts** — `pie` for proportions; `xychart-beta` for a trend. `xychart-beta` is
beta syntax: prefer `pie` or a table when the data is small or you're unsure it
will render cleanly.

```mermaid
pie title Time by phase
  "Read" : 35
  "Plan" : 25
  "Write" : 40
```

```mermaid
xychart-beta
  title "Latency by version"
  x-axis [v1, v2, v3]
  y-axis "ms" 0 --> 300
  bar [280, 190, 120]
```

## Table and code patterns

GitHub pipe tables suit option matrices, before/after comparisons, and field
references — keep them to ≤4 columns so they don't scroll in the narrow pane.
Always language-tag fenced code (` ```rust `, ` ```ts `, ` ```bash `) so it's
syntax-highlighted, and quote real identifiers and paths from the code you read.

## Anti-patterns

- Don't open with a diagram — lead with the answer.
- One structural element per reply is usually enough; don't stack a table *and*
  three diagrams.
- Don't restate the whole plan back to the reviewer; respond to *their* comment.
- No raw HTML for layout — it's escaped, not rendered.
- A callout is for the one caveat that matters, not every aside.
