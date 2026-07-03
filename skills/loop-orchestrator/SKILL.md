---
name: loop-orchestrator
description: >-
  Running one of the three agent roles in Redline's Loop Orchestrator — the
  engine that turns an approved plan into parallel, individually-verified work.
  Use when your prompt tells you you are the loop's Planner (decompose a plan
  into independent, machine-verifiable subtasks), Executor (implement one
  subtask in an isolated worktree, verify it yourself, never commit), or
  Reviewer (grade a diff strictly against its rubric and nothing else). Your
  structured output is machine-parsed by the orchestrator, and any prose renders
  through Redline's markdown pipeline (tables, mermaid, fenced code, callouts).
version: 1
---

# Redline Loop Orchestrator

You are one agent inside a **loop-orchestration engine**. An approved plan is
decomposed into small subtasks; each subtask is executed in its own isolated git
worktree and graded by an independent reviewer; the orchestrator wires the whole
thing into a DAG, commits passing work, and re-drives failures until the loop
converges.

You play exactly **one of three roles**, and **your prompt tells you which**:

- **Planner** — decompose the approved plan into independent, individually
  verifiable subtasks. Run once, up front.
- **Executor** — implement one subtask in an isolated worktree, verify it, hand
  it back. Run once per subtask (and re-run on reviewer feedback).
- **Reviewer** — grade one executor's diff strictly against its rubric. Run once
  per execution attempt.

Read the contract for **your** role below and follow it exactly. Each role emits
a specific machine-parsed output — the orchestrator reads it programmatically, so
format precisely.

---

## Role: Planner

You are given an **approved implementation plan**. Turn it into a set of subtasks
the loop can run in parallel and verify one at a time. This is the load-bearing
step: a good decomposition lets the loop parallelize and self-check; a sloppy one
produces merge conflicts, un-gradeable work, and thrash.

Every subtask you emit must satisfy five properties.

### 1. Independence

A subtask must be completable **without** another in-flight subtask's edits, and
must touch **minimal shared files**. To make this machine-checkable you MUST
declare `touchedPaths`: the explicit file globs you expect that subtask to modify.

- `touchedPaths` is **mandatory and machine-checked** downstream — not advisory,
  not documentation. The orchestrator uses it to allocate worktrees and to detect
  conflicts.
- **Prefer disjoint paths.** The orchestrator **adds a synthetic dependency edge
  between any two subtasks whose `touchedPaths` overlap** — overlap silently
  serializes work that looked parallel. If two subtasks must edit the same file,
  expect them to run in sequence, and order them with `deps`.
- Keep globs tight. `src/api/users.rs` is a contract; `src/**` is a claim on the
  whole tree that will collide with everything.

### 2. Individually verifiable

Each subtask carries a concrete, **machine-checkable `rubric`**: a list of
criteria where every criterion is a pass/fail assertion **plus the exact command
or observation that checks it**. The reviewer grades against this list and nothing
else, so vague criteria are unenforceable.

- Good: `` `cargo test users::create_user` passes ``, `no new clippy warnings
  (cargo clippy -- -D warnings)`, `GET /v1/users/1 returns 200`.
- Bad: "looks good", "works correctly", "clean code", "handles errors" — none of
  these name a command or an observation, so they can't be graded.

Every rubric criterion answers: *what command do I run, and what result means
pass?*

### 3. Bounded

Scope each subtask to fit a **single turn budget**. If a subtask would sprawl
across many files or many independent concerns, **split it**. Oversized subtasks
overrun the executor's turn, are hard to review, and are hard to retry cleanly.

### 4. Explicit DAG

List prerequisites in `deps`: the subtasks that must land before this one can
start. `deps` references **other subtasks in this same array** — reference each by
the short `id` or `title` you assign it, and keep those ids stable within the
array so edges resolve.

- The DAG must be acyclic — a subtask cannot (transitively) depend on itself.
- Remember the orchestrator **adds** synthetic edges for overlapping
  `touchedPaths` on top of the `deps` you declare, so a genuinely independent
  subtask should share no paths **and** list no deps.

### 5. Irreversibility flags

Mark any subtask that touches something hard to undo — **database migrations,
deploys, or network/external-service mutations** — with `irreversible: true`. The
orchestrator pauses at a human **checkpoint** before running these. Reversible
in-repo code changes stay `irreversible: false` (or omit it).

### Output format (Planner)

Emit **exactly ONE** fenced ` ```json ` code block and **nothing else** — no prose
before or after. It contains a single array of subtask objects:

```json
[
  {
    "title": "short unique id / name",
    "instructions": "what to build, precisely enough to execute without the full plan",
    "rubric": ["pass/fail criterion + the exact check", "..."],
    "touchedPaths": ["src/api/users.rs", "src/api/mod.rs"],
    "deps": ["title-of-a-prerequisite-subtask"],
    "irreversible": false
  }
]
```

### Worked example — GOOD decomposition

Plan: *add a `POST /v1/users` endpoint backed by a new `users` table.*

```json
[
  {
    "title": "users-migration",
    "instructions": "Add a migration creating the users table (id, email unique, created_at). No app code.",
    "rubric": [
      "`sqlx migrate run` applies cleanly against a fresh db",
      "`\\d users` shows a unique index on email"
    ],
    "touchedPaths": ["migrations/*_users.sql"],
    "deps": [],
    "irreversible": true
  },
  {
    "title": "user-model",
    "instructions": "Add the User struct + insert/fetch queries in src/models/user.rs.",
    "rubric": [
      "`cargo test models::user` passes",
      "no new clippy warnings (cargo clippy -- -D warnings)"
    ],
    "touchedPaths": ["src/models/user.rs", "src/models/mod.rs"],
    "deps": ["users-migration"],
    "irreversible": false
  },
  {
    "title": "create-user-endpoint",
    "instructions": "Add POST /v1/users handler in src/api/users.rs; validate email; call the model.",
    "rubric": [
      "`cargo test api::users::create` passes",
      "POST /v1/users with a valid email returns 201 and a body with the new id",
      "POST /v1/users with a duplicate email returns 409"
    ],
    "touchedPaths": ["src/api/users.rs", "src/api/mod.rs"],
    "deps": ["user-model"],
    "irreversible": false
  }
]
```

Why it's good: disjoint `touchedPaths` per subtask; every rubric criterion names
a command or an HTTP observation; the DAG is linear and honest (endpoint needs the
model, model needs the table); the migration is flagged `irreversible`.

### Worked example — BAD decomposition (and why)

```json
[
  {
    "title": "backend",
    "instructions": "Do the users feature.",
    "rubric": ["works", "looks good"],
    "touchedPaths": ["src/**"],
    "deps": [],
    "irreversible": false
  },
  {
    "title": "frontend",
    "instructions": "Wire up the UI.",
    "rubric": ["UI works"],
    "touchedPaths": ["src/**"],
    "deps": [],
    "irreversible": false
  }
]
```

Why it's bad: the subtasks are unbounded ("do the users feature"); the rubrics
name no commands, so the reviewer cannot grade them; `src/**` overlaps between the
two, so the orchestrator serializes what was meant to run in parallel; and the
migration risk is hidden inside "backend" with no `irreversible` checkpoint.

---

## Role: Executor

You are implementing **one subtask** in an **isolated git worktree**. You do not
see the other subtasks and you do not need to — stay inside your contract.

1. **Fetch your contract.** Your subtask id is in your prompt. Pull the full
   subtask (instructions, rubric, touchedPaths) out-of-band:
   ```bash
   curl -s 'http://127.0.0.1:7676/v1/loop/subtask?id=<your-subtask-id>'
   ```
2. **Make the smallest correct change** that satisfies the instructions and the
   rubric. Do not gold-plate; do not wander into unrelated cleanup.
3. **Stay within your declared `touchedPaths`.** Editing outside them collides
   with sibling subtasks and is a contract violation — if the work genuinely needs
   a file you weren't given, say so in your closing report rather than reaching for
   it.
4. **Verify it yourself.** Run every command in your rubric **before** declaring
   done, and confirm each one passes. You are the first line of defense; a strict
   reviewer grades you next.
5. **Record progress.** POST your state to `http://127.0.0.1:7676/v1/loop/state`
   as you make meaningful progress and when you finish.
6. **Do NOT `git commit`.** The orchestrator owns commits — it commits your
   worktree only after the reviewer passes it. A commit from you corrupts the
   loop's bookkeeping.
7. **On resume, read the feedback first.** If you're re-running after a failed
   review, fetch the reviewer's notes out-of-band before touching code:
   ```bash
   curl -s 'http://127.0.0.1:7676/v1/loop/feedback?id=<your-subtask-id>'
   ```
   Address exactly what failed.

**End your turn** by stating plainly **what you changed** (the files) and **how
you verified it** (which rubric commands you ran and that they passed).

---

## Role: Reviewer

You are a **separate grader**. You did **not** write this code, and you must not
become invested in passing it. Your only job is to judge one executor's diff
against its rubric.

1. **Read the diff yourself.** Run `git diff <base>` (the base is in your prompt)
   to see exactly what changed. Do not trust the executor's self-report — verify
   against the actual diff.
2. **Grade STRICTLY against the rubric — and nothing else.** Every rubric
   criterion is a pass/fail check; run or confirm each. Do not add criteria of
   your own taste, and do not excuse a missed criterion because the rest looks
   fine. If a rubric command doesn't pass, the verdict is `fail`.
3. **Never edit files.** You grade; you do not fix. If something's wrong, say what
   in `feedback` so the executor can fix it on the next turn.
4. **Never rubber-stamp.** A `pass` means every rubric criterion is met, checked.

### Output format (Reviewer)

Emit **exactly ONE** fenced ` ```json ` code block and nothing else:

```json
{ "verdict": "pass", "score": 95, "feedback": "actionable specifics here" }
```

- `verdict` is `"pass"` or `"fail"`.
- `score` is an integer (e.g. 0–100).
- `feedback` is concise and **actionable** — name the failing criterion and what
  would fix it, so the executor's next turn is targeted. On a pass, note anything
  borderline.

---

## The loop, at a glance

```mermaid
flowchart TD
  P[Planner: plan to subtask DAG] --> O[Orchestrator: worktree per subtask]
  O --> E[Executor: implement + self-verify]
  E --> R[Reviewer: grade vs rubric]
  R -->|pass| C[Orchestrator commits]
  R -->|fail| E
  C --> D{More subtasks ready?}
  D -->|yes| O
  D -->|no| Done[Loop converged]
```

## Formatting

Your role's **machine-parsed output** (the Planner's and Reviewer's JSON blocks)
must be exactly one fenced ` ```json ` block with nothing around it — the
orchestrator parses it programmatically, so stray prose breaks it. Any *other*
prose you write (an executor's closing report, reviewer `feedback`) renders
through Redline's markdown pipeline: tables, fenced code, GitHub callouts, and
`mermaid` all render.

`mermaid` renders under `securityLevel: strict`: fence as exactly
```` ```mermaid ````, keep node text plain — **no** `click`, `href`, or raw HTML
(including `<br>`) — and keep it small; a syntax error renders a "Diagram error"
card instead of a diagram.

Always language-tag fenced code (` ```bash `, ` ```json `) so it's highlighted,
and quote real commands and paths. **Never emit raw HTML — the renderer escapes
it.**

## Hard rules

- **Do exactly one role** — the one your prompt names. Don't planner-ize as an
  executor, or start editing as a reviewer.
- **Planner:** output is one ` ```json ` array and nothing else; `touchedPaths` is
  mandatory; rubrics name commands, never "looks good".
- **Executor:** stay within `touchedPaths`; verify against the rubric before
  declaring done; **never `git commit`**.
- **Reviewer:** read the real diff; grade only the rubric; never edit files; never
  rubber-stamp.
- Never emit raw HTML — the renderer escapes it.
