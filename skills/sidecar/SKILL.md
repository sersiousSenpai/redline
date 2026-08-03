---
name: sidecar
description: >-
  Structuring replies in a Redline sidecar discussion thread. Use when running
  as a read-only discussion-thread fork answering a reviewer's comment or
  question on a plan section — replies render through Redline's markdown
  pipeline (tables, mermaid diagrams, fenced code, callouts). Covers when to use
  prose vs a table vs a flowchart/architecture/sequence diagram vs a chart, with
  strict-mode mermaid snippets, and the read-only / no-ExitPlanMode rules.
version: 2
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
Glob, WebFetch, and WebSearch, plus a read-only `curl` to Redline's local memory
bridge (`/v1/memory/*`, see the class-router below) — use them to ground your
answer in the actual code, sources, and the user's own captured history. Never
emit raw HTML; the renderer escapes it.

<!-- CLASS-ROUTER:BEGIN — byte-identical across sidecar & conversation; skill.rs guards this -->
## Class-router — resolve the class, then route the reply

Before you answer, orient. Redline captures the user's prompts and decisions into a
hash-chained **lake** and organizes them into an emergent **ClassMemory** tree
(repos seed root classes; topics earn sub-classes). You can read that memory to
ground your reply in what the user has actually decided and researched — but first
resolve *which class* the question lives in, then shape the reply to the question.

**Step 0 — resolve the likely class.**

- The **cwd repo is a strong prior** — a discussion forked in the `redline` repo is
  almost certainly about `redline`.
- An **explicitly named repo or class overrides** the cwd ("in muslimlegalconnect,
  how did we…" → the `muslimlegalconnect` class, not the repo you're sitting in).
- When no repo is named, `~general` and the other classes **compete on equal
  footing** — pick by subject; don't reflexively default to the cwd.

**Then route the reply along four axes** (they compose — read the question through
all four):

- **Subject matter → the domain's conventions.** An auth question wants precise
  token/session/redirect vocabulary; an infra question wants a topology; a product
  question wants user-facing framing. Speak the subject's language.
- **Topic → altitude/depth.** A broad "how does X work" wants the shape first
  (altitude); a pointed "why does line 40 deadlock" wants depth on the one thing.
  Match the zoom the question is asking for.
- **Sentence → form.** Let the question's *form* pick the artifact: a yes/no or a
  single fact → prose; "compare A vs B vs C" → a table; "what's the flow / what
  calls what" → a `flowchart` or `sequenceDiagram`. (In conversation mode, stay
  prose unless one small artifact truly unlocks it.)
- **Predicate → verb class.** The main verb says what *kind* of answer to give:
  *explain* → walk the mechanism; *compare* → weigh options with a recommendation;
  *decide* → give a verdict + the condition that would flip it; *act* → the concrete
  next step. Answer the verb the user actually used.

## Reading ClassMemory (the vectorless tree-walk)

When answering "what did I decide / research / build about X" would benefit from the
user's own history, walk the catalog through the local memory bridge (already
permitted — a read-only `curl` to `127.0.0.1:7676`, no approval needed). It is a
**tree-walk, not a similarity search**:

1. **Get the tree**, scoped to the class you resolved in step 0:
   `curl -s http://127.0.0.1:7676/v1/memory/tree` — pass `?project=<repo path>` or
   `?root=<class id>` to scope to that class.
2. **Descend to the topic node and read its links:**
   `curl -s http://127.0.0.1:7676/v1/memory/node/<id>` — returns the node, its
   children, and its links (pointers into the lake).
3. **Route by the question's verb** (this is where the predicate earns its keep):
   - **"what did I *decide*"** → weight **decision events first** (`approval` /
     `resolution` / `review_verdict` links), *not* the prose that merely debated it.
   - **"what was I *researching*"** → weight `prompt` links with
     `surface = browse/mission` (and any `source_trust`).
   - **"how did I *build / wire*"** → weight `prompt` (plan/rust) + `revision`.
4. **Expand a `digest` node only when detail is needed** — its `summary` answers
   most questions; when you need specifics, follow its `cite_seqs` to the exact
   ledger rows. Pull bodies with
   `curl -s http://127.0.0.1:7676/v1/memory/prompts`.

The **project binding fences the walk**: never cross from the resolved class into a
same-named topic under a different repo ("Clerk" exists under two projects — the
`project_path` tells them apart). If the memory is empty or has nothing on point,
say so in a phrase and answer from the code/sources instead — never invent a memory.
<!-- CLASS-ROUTER:END -->

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
