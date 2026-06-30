---
name: redline
description: >-
  Plan-revision contract for plans reviewed in Redline. Use when the context
  contains a Redline review payload — comment feedback tagged [edit],
  [feedback], or [question], rl:blk- block-identity sidecars, or a
  REDLINE_RESOLUTIONS block. Covers presentation-aware plan markdown,
  preserving sidecars, and emitting resolutions.
version: 8
---

# Redline review protocol

Redline is a desktop plan-review companion for Claude Code. A hook intercepts
`ExitPlanMode`: the plan opens in Redline's track-changes editor, the user
marks it up, and Redline returns the review to you as a structured feedback
payload. Treat that payload as the user's reviewed, attested feedback on your
plan. This document is that contract, given up front so your first plan renders
well and revisions round-trip cleanly.

Sending a plan back keeps you in plan mode by **denying** the `ExitPlanMode`
call, which Claude Code renders as a red `Error:` line. **Nothing failed** — that
is the normal review round-trip. The denial reason is a single calm line that
hands you a URL; the full review is delivered out-of-band (see §0) so the denial
stays one line instead of a wall of text.

## 0. When a send-back denies ExitPlanMode — fetch the review

When your `ExitPlanMode` is denied with a reason that begins
`✅ Plan returned to Redline` (revise) or `✅ Returned to Redline` (questions),
the reviewer has sent the plan back. The reason carries a loopback URL; fetch the
full review from it before doing anything else:

```bash
curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/feedback
```

`<session_id>` is your Claude Code session id (the reason gives you the exact
URL). The response body is the structured payload covered by §2–§4 — read it,
then revise (or, for a questions-only Ask, re-submit unchanged) per the rest of
this contract. A `404` means nothing is pending (a duplicate fetch) — safe to
ignore.

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
a read-only fork of your session (Read, Grep, Glob, WebFetch, WebSearch — nothing
else). If you are running as a discussion-thread fork, follow the **`sidecar`
skill** for how to structure the reply. The invariants hold regardless: reply in
markdown prose, do **not** call `ExitPlanMode`, do not produce a new plan, and do
not edit files.

## 6. Suggesting edits into a live review (agent-in-doc)

While the user reviews a plan you can propose a tracked edit directly into the
open document. It appears inline as a tracked suggestion under your name and
as a sidebar card with Accept/Reject — the user resolves it in place. Use it
when the user asks you to (e.g. "suggest a fix for §B in Redline"), not to
bypass the normal revise loop.

Both endpoints are on the local daemon. The `session_id` is your Claude Code
session id (the same one the review payload belongs to).

**Read the plan's block structure first** — suggestions anchor by `blockId`,
never by position. Always take ids from this response; never invent them:

```bash
curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/plan
```

Returns `{ sessionId, versionNumber, rawPlanMarkdown, blocks }` where each
block is `{ blockId, anchorId, kind, markdown, openComment }`. A block with
`openComment: true` already carries an open comment — a suggestion against it
will be rejected.

**Post one suggestion per block:**

```bash
curl -s -X POST http://127.0.0.1:7676/v1/sessions/<session_id>/suggestions \
  -H 'Content-Type: application/json' \
  -d '{
    "blockId": "blk-abc12345",
    "kind": "edit",
    "original": "<the block markdown exactly as the plan response gave it>",
    "revised": "<your proposed block markdown>",
    "agentId": "claude-code",
    "body": "<optional one-line rationale shown on the card>"
  }'
```

- **Always send `original`** (verbatim from the plan response). It is the
  staleness guard: if the block changed since you read it, the POST fails
  with 409 — re-fetch the plan and retry against the current content.
- `409` also means the block already has an open comment (yours or the
  user's): leave it alone or wait for the user to resolve it.
- `kind` must be `"edit"`; `revised` must differ from the current block.
- The store sees the published revision plus comments — user keystrokes from
  the last second may not be visible yet; the 409 contract covers the rest.

An accepted suggestion rides the next feedback payload as a normal `[edit]` —
resolve it in `REDLINE_RESOLUTIONS` like any other comment id.

## 7. Restoring a reopened plan

When a reviewer reopens a detached plan, Redline resumes your session and asks
you to re-present your current plan. Two things are true of a resumed session:

- You start **outside** plan mode (a `--resume` lands you there even with
  `--permission-mode plan`).
- Your plan body is **not** in the restored context.

Neither matters, because **Redline already holds your current plan and
re-presents it itself** — a restore just needs you to re-establish the held
`ExitPlanMode`. Do the minimum; do **not** fetch the plan from the daemon or
retype it. Follow this fixed sequence:

1. **`EnterPlanMode`** — establishes plan mode and gives you a fresh plan-file
   path. (Don't list session directories.)
2. **Write exactly the `<!-- REDLINE_RESTORE:… -->` marker the resume command
   gave you** as your plan file's contents — a one-line placeholder carrying the
   held plan's session id (e.g. `<!-- REDLINE_RESTORE:36c1d078-… -->`). Write it
   verbatim, including the id; that id lets Redline rebind the restore even if
   this resumed session got a new id. Redline recognizes the marker, restores the
   plan it holds, and **ignores** whatever body you submit. (A bare
   `<!-- REDLINE_RESTORE -->` still works for an in-place restore.)
3. **`ExitPlanMode`** — the hook reopens the held plan in Redline's editor.

A restore is a **re-presentation, not a revision**: don't fetch the body, don't
retype it, and don't add a `REDLINE_RESOLUTIONS` block. Any actual changes flow
through the normal review/revise loop after the plan reopens.
