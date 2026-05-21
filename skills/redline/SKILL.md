---
name: redline
description: >-
  Plan-authoring and revision contract for Claude Code sessions whose plans are
  reviewed in Redline. Use when a plan has come back for revision through
  Redline — when the context contains a Redline review payload, comment feedback
  tagged [edit], [feedback], or [question], or a REDLINE_RESOLUTIONS block.
  Covers presentation-aware plan markdown (never raw HTML), preserving rl:blk-
  block-identity sidecars, and emitting the resolution block.
version: 1
---

# Redline review protocol

Redline is a desktop plan-review companion for Claude Code. When the user runs
Claude Code with Redline installed, a hook intercepts `ExitPlanMode`: instead of
the plan going straight to the user as a chat message, it opens in Redline's
track-changes editor. The user marks it up — inline edits, feedback notes,
questions, whole-block structural changes — and Redline returns that review to
you as a structured feedback payload (the `permissionDecisionReason` of a denied
`ExitPlanMode` call).

Treat a returned Redline payload as the user's reviewed, attested feedback on
your plan. This document is that contract, given to you up front so your plans
render well and your revisions round-trip cleanly.

## 1. Write presentation-aware markdown — never raw HTML

Redline renders the plan with a real markdown pipeline: document-grade
typography, syntax-highlighted code, and rendered diagrams. Lean on that so a
plan reads like a polished artifact, not a chat message:

- **Language-tag every fenced code block** (` ```rust `, ` ```ts `, ` ```bash `).
  Redline syntax-highlights it.
- **Use ` ```mermaid ` fenced blocks for diagrams** — flowcharts, sequence,
  state. Redline renders them as actual diagrams. Prefer this over ASCII art.
- **Use markdown tables** for structured comparisons; they render as real
  tables.
- **Keep a clean, well-nested heading hierarchy** (`#`, `##`, `###`). Headings
  drive the section outline (§A, §A.1, …) the reviewer navigates and anchors
  comments to. Don't skip levels.
- **Use blockquotes (`>`)** for callouts and asides.

Keep the plan body as **markdown**. **Never emit raw HTML** for layout or
styling — Redline's renderer, diff engine, and block-identity system all operate
on markdown, and an HTML plan cannot carry the block-id sidecars or participate
in track-changes. The only HTML in a plan is the two Redline control comments
described below.

## 2. Preserve block-identity sidecars on a revision

When Redline asks you to revise, the payload's `CURRENT PLAN` section is your
previous plan's markdown with `<!-- rl:blk-XXXXXXXX -->` comments inserted before
each block. These are **block-identity sidecars** — Redline tracks each block
across versions by them to compute its track-changes diff.

The payload states the rule; honor it exactly:

> preserve every `<!-- rl:blk-… -->` marker exactly where its block's content
> remains; add fresh markers only for genuinely new blocks; delete markers only
> for blocks you remove.

- **Edit the `CURRENT PLAN` body in place** — do not rewrite it from scratch.
- A block you keep or only reword: leave its sidecar unchanged, right before it.
- A genuinely new block: just omit a sidecar — Redline mints one. Never invent
  `rl:blk-` ids yourself.
- A block you delete: delete its sidecar with it.

If you strip or shuffle the sidecars, Redline's diff can't tell what changed and
paints the whole plan as new. (Redline has a fallback that re-matches blocks by
their text, but it is best-effort — preserving the markers is the reliable path.)

## 3. Answer every comment in a REDLINE_RESOLUTIONS block

Every comment in the payload carries a `COMMENT_ID` (e.g. `c-001`). When you call
`ExitPlanMode` again, include a resolution block in the plan body. Redline reads
it and strips it before rendering — it is a side channel, not plan content:

```
<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Done — tightened the intro as suggested.",
  "c-002": "Good catch; switched to a bounded queue."
}
-->
```

- It is a JSON object: comment id → a short note on how you addressed (or, for a
  question, answered) that comment.
- **Every comment id from the payload must appear as a key. Do not skip any.**
- Place it at the top of the plan body (anywhere in the body is parsed, but the
  top is conventional).

## 4. The feedback payload — comment kinds and the two modes

A payload always opens with `The user reviewed your plan in Redline and has
requested revisions.` It then lists comments, each tagged by kind:

- **`[edit, local]`** — an inline text edit, shown as `ORIGINAL:` / `REVISED:`.
  Apply the revised wording.
- **`[feedback, local]` / `[feedback, structural]`** — a prose note under a
  `USER COMMENT (verbatim):` frame. Address it in the plan. `structural` means
  the concern is about a whole section rather than one line.
- **`[question]`** — a question under a `USER COMMENT (verbatim):` frame.
  **Answer it in the resolution block only — a question never drives a change to
  the plan body.**
- **`[structural: insert|delete|move]`** — a whole-block insert, delete, or move
  the reviewer made, described declaratively under `STRUCTURAL CHANGES:`. Apply
  it.

The payload comes in two shapes:

- **Revise** — it has a `FEEDBACK:` (and possibly `STRUCTURAL CHANGES:`) section
  and a `CURRENT PLAN`. Produce the next version of the plan: incorporate the
  edits, address the feedback, apply the structural changes, keep the sidecars
  (§2), add the resolution block (§3), and call `ExitPlanMode`.
- **Ask** — it has only a `QUESTIONS:` section and the instruction *"Call
  ExitPlanMode again with the plan body EXACTLY as you previously submitted
  it."* The user wants answers, not changes. Re-submit the **same plan body,
  byte-for-byte unchanged** — do not add, remove, reword, or restructure
  anything — with the answers in the resolution block. Changing the body during
  an Ask round-trip is flagged as a violation.

The payload is self-contained and restates these rules every time; this skill is
the same contract delivered ahead of time, so your *first* plan is already
presentation-aware and your revisions are already correct.

## 5. Discussion-thread forks

A reviewer can open a **discussion thread** on any comment. Redline answers it by
running a read-only fork of your session (it may Read, Grep, and Glob — nothing
else). If you are running as a discussion-thread fork, you are answering a
question about a plan inline: reply directly and concisely in markdown prose. Do
**not** call `ExitPlanMode`, do not produce a new plan, and do not edit files.

## Quick reference

- Plan body is markdown — never raw HTML.
- Language-tag every code fence; use ` ```mermaid ` for diagrams; use tables;
  keep a clean heading hierarchy.
- On a revision: edit the `CURRENT PLAN` in place and preserve every
  `<!-- rl:blk-… -->` sidecar.
- Always emit `<!-- REDLINE_RESOLUTIONS … -->` with a key for every `COMMENT_ID`.
- A `[question]` is answered in the resolution block — it never changes the plan
  body.
- Ask mode → resubmit the plan body unchanged; answers go in the resolutions.
