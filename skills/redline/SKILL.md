---
name: redline
description: >-
  Plan-revision contract for plans reviewed in Redline. Use when the context
  contains a Redline review payload — comment feedback tagged [edit],
  [feedback], or [question], rl:blk- block-identity sidecars, or a
  REDLINE_RESOLUTIONS block. Covers presentation-aware plan markdown,
  preserving sidecars, and emitting resolutions.
version: 2
---

# Redline review protocol

Redline is a desktop plan-review companion for Claude Code. A hook intercepts
`ExitPlanMode`: the plan opens in Redline's track-changes editor, the user
marks it up, and Redline returns the review to you as a structured feedback
payload (the `permissionDecisionReason` of the denied call). Treat that payload
as the user's reviewed, attested feedback on your plan. This document is that
contract, given up front so your first plan renders well and revisions
round-trip cleanly.

## 1. Write presentation-aware markdown — never raw HTML

Redline renders plans with a real markdown pipeline:

- **Language-tag every fenced code block** (` ```rust `, ` ```ts `, ` ```bash `)
  — they are syntax-highlighted.
- **Use ` ```mermaid ` fences for diagrams** (flowchart, sequence, state) —
  rendered as actual diagrams; prefer over ASCII art.
- **Use markdown tables** for structured comparisons.
- **Keep a clean, well-nested heading hierarchy** (`#`, `##`, `###`) — headings
  drive the section outline (§A, §A.1, …) reviewers navigate and anchor
  comments to. Don't skip levels.
- **Use blockquotes (`>`)** for callouts.

**Never emit raw HTML** for layout or styling — Redline's renderer, diff
engine, and block-identity system operate on markdown, and an HTML plan cannot
carry block-id sidecars or participate in track-changes. The only HTML in a
plan is the two Redline control comments described below.

## 2. Preserve block-identity sidecars on a revision

On a revision, the payload's `CURRENT PLAN` is your previous plan's markdown
with `<!-- rl:blk-XXXXXXXX -->` comments before each block. Redline tracks
blocks across versions by these to compute its track-changes diff. The payload
states the rule; honor it exactly:

> preserve every `<!-- rl:blk-… -->` marker exactly where its block's content
> remains; add fresh markers only for genuinely new blocks; delete markers only
> for blocks you remove.

- **Edit the `CURRENT PLAN` body in place** — do not rewrite it from scratch.
- A block you keep or only reword: leave its sidecar unchanged, right before it.
- A genuinely new block: omit a sidecar — Redline mints one. Never invent
  `rl:blk-` ids yourself.
- A block you delete: delete its sidecar with it.

Stripping or shuffling sidecars makes the diff paint the whole plan as new.
Sidecars may carry a sub-block suffix (`.lN`, `.sN`, `.wN[-wM]` — e.g.
`<!-- rl:blk-abc12345.s3.w2-w4 -->`) from sentence- or word-level comment
anchors: preserve the whole suffixed id exactly, and never emit sub-block ids
yourself — Redline mints them at parse time.

## 3. Answer every comment in a REDLINE_RESOLUTIONS block

Every comment carries a `COMMENT_ID` (e.g. `c-001`). When you call
`ExitPlanMode` again, include at the top of the plan body (Redline reads it and
strips it before rendering — it is a side channel, not plan content):

```
<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Done — tightened the intro as suggested.",
  "c-002": "Good catch; switched to a bounded queue."
}
-->
```

A JSON object: comment id → a short note on how you addressed (or, for a
question, answered) that comment. **Every comment id from the payload must
appear as a key. Do not skip any.**

## 4. The feedback payload — comment kinds and the two modes

Comments are tagged by kind:

- **`[edit, local]`** — an inline text edit (`ORIGINAL:` / `REVISED:`). Apply
  the revised wording.
- **`[feedback, local]` / `[feedback, structural]`** — a prose note under
  `USER COMMENT (verbatim):`. Address it in the plan; `structural` means a
  whole-section concern.
- **`[question]`** — answer it **in the resolution block only** — a question
  never drives a change to the plan body.
- **`[structural: insert|delete|move]`** — a whole-block change the reviewer
  made, described under `STRUCTURAL CHANGES:`. Apply it.

The payload comes in two shapes:

- **Revise** — has `FEEDBACK:` (possibly `STRUCTURAL CHANGES:`) and a
  `CURRENT PLAN`. Produce the next version: apply the edits, address the
  feedback, apply the structural changes, keep the sidecars (§2), add the
  resolution block (§3), and call `ExitPlanMode`.
- **Ask** — has only `QUESTIONS:` and the instruction to resubmit the plan
  exactly as previously submitted. Re-submit the same plan body
  **byte-for-byte unchanged** — changing the body during an Ask round-trip is
  flagged as a violation — with the answers in the resolution block.

## 5. Discussion-thread forks

A reviewer can open a discussion thread on any comment; Redline answers it with
a read-only fork of your session (Read, Grep, Glob — nothing else). If you are
running as a discussion-thread fork, reply directly and concisely in markdown
prose. Do **not** call `ExitPlanMode`, do not produce a new plan, and do not
edit files.
