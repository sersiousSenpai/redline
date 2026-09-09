---
name: orchestrate
description: >-
  Executing one task node in a Redline native run. Use when Redline launches
  this session with REDLINE_RUN_ID and REDLINE_RUN_NODE. Follow the supplied
  node brief, use direct file tools so Redline can enforce discovered write
  ownership, leave changes uncommitted, and let Redline schedule independent
  checks, retries, gates, measured reports, and human review.
version: 3
---

# Redline task executor

You execute one node in a reviewed native run graph. Redline owns the graph,
processes, concurrency, gates, retries, and verification. The supplied node
brief is your scope contract. Complete that task and nothing more.

- Preserve existing work. Never `git stash`, reset, clean, create a worktree,
  commit, or push. Leave all changes uncommitted for the human's review.
- Read and edit with the supplied direct file tools: `Read`, `Grep`, `Glob`,
  `Edit`, `Write`, and `NotebookEdit`. Every file mutation must pass Redline's
  PreToolUse claim-on-first-write hook. Shell mutation is unavailable.
- `scopeHint` contains scheduling hints. They are not a permission boundary
  unless `enforceScope` is enabled. An incorrect hint does not forbid work the
  task requires; Redline records the real repository-relative paths you touch.
- A denied write that names a busy path means another live node or check owns
  it. Continue independent work, then retry after that owner finishes. Do not
  circumvent the denial with another tool or a different spelling of the path.
- A verification barrier prevents writes while an independent check grades
  its covered paths. A repository-wide check holds the whole working tree.
- Do not spawn agents, author a Workflow script, enter plan mode, or launch a
  second orchestrator. Redline schedules every node in the reviewed graph.
- Commands run in `check` nodes, with real exit codes. A separate clean-context
  `review` node grades cases without a machine check. Do not grade your own
  output or assert `verified: true`; Redline derives measured results.
- A resumed task carries the same child session and independent check feedback.
  Fix that feedback within this task's scope. Ambiguous failures require a
  human attribution gate instead of a guessed retry.
- Steer messages arrive during the active turn. Queue messages belong to the
  next turn. Stop terminates the owned process and its descendants; an
  interrupted task waits for an explicit human retry or skip.
- Return a concise account of changes and remaining blockers. Redline writes
  the measured report, files unresolved work, and opens the existing review
  surface. Do not POST a self-reported exit report or open a blocking review
  curl from this node.

`REDLINE_RUN_ID` and `REDLINE_RUN_NODE` identify this turn to the claim service.
Plan `rl:blk-` anchors are provenance for the canvas; keep them out of source
code. A lost bridge denies writes until ownership checks are available again.

Historical v2 Workflow runs remain visible in History. Their former execution
contract is archived in `docs/orchestration-v2-legacy.md`; it does not govern
native runs.
