---
name: orchestrate
description: >-
  Executing an approved Redline plan as a multi-agent workflow. Use when your
  launch prompt says a Redline plan session was approved via Orchestrate: you
  fetch the reviewed plan over the local curl bridge, treat it as the scope
  contract, author a native multi-agent Workflow (pipeline by default, a
  machine-checkable verify stage per subtask), leave every change uncommitted,
  POST the structured exit report, and finish by opening the blocking
  /redline-code-review curl so the human reviews the diff line-by-line. Covers
  the plan fetch + sidecar stripping, the never-git-stash preflight, the
  sequential fallback when the Workflow tool is unavailable, and the
  only-the-orchestrator-reviews rule.
version: 2
---

# Redline Orchestrate

The user reviewed a plan in Redline and approved it with **Orchestrate**: the
session that wrote the plan was stood down, and YOU execute it — as a
multi-agent workflow when the Workflow tool is available, sequentially when it
is not. The run ends with a structured exit report and a human line-by-line
code review. Everything in between is yours.

## 1. Fetch the plan

Your launch prompt names the plan session id. Read the approved plan from the
local bridge (pre-authorized in exactly this shape):

```bash
curl -s "http://127.0.0.1:7676/v1/sessions/<plan_session_id>/plan"
```

`rawPlanMarkdown` in the response is the reviewed, approved plan — the exact
text the human signed off on. It may carry `<!-- rl:blk-… -->` sidecar
comments: those are review identity, not content — strip them before reasoning
about the plan, and never let them leak into code, commit text, or the report.

## 2. The plan is the scope contract

The deliverable is **exactly the plan's stated changes — nothing more**. No
opportunistic refactors, no drive-by cleanups, no "while I'm here" fixes. The
human approved this text, not your improvements to it. If the plan is
impossible as written, do the closest faithful subset and say so in the exit
report — don't substitute your own design.

**Never enter plan mode.** The plan is already approved — you execute, you do
not plan. Do not call ExitPlanMode: Redline recognizes orchestrator sessions
and will refuse it rather than open a review nobody asked for.

## 3. Preflight

Run `git status --porcelain` before touching anything. A dirty tree is
information, not an obstacle: other live sessions may own those edits.
**Never `git stash`** — you would be shelving another session's work in
flight. Work around existing changes, keep your hands off files you didn't
change, and note any overlap in the exit report.

## 4. Author the workflow

Decompose the plan into subtasks and run them with the Workflow tool:

- **Pipeline by default.** Prefer pipeline depth over fan-out width; only use
  a barrier when a stage genuinely needs all prior results at once.
- **Worktree isolation only when needed.** Per-agent worktree isolation is for
  parallel agents that mutate files and would collide — don't pay for it
  otherwise.
- **A machine-checkable verify stage per subtask.** Every subtask ends with a
  check a machine can pass or fail (a test run, a build, a grep for the
  expected symbol) — "looks done" is not a verification.
- **Size conservatively.** Respect the session's workflow size guideline, and
  route mechanical stages to cheaper models via per-agent model overrides —
  reserve the big model for design and verification.
- The workflow run writes its script to a path it reports at start — capture
  that script path for the exit report.

**Fallback:** if the Workflow tool is unavailable (older CLI, workflows
disabled, plan tier), execute the same stages sequentially yourself, in the
same order, with the same per-subtask verify discipline. The contract with the
reviewer is identical either way; set `workflowRan: false` in the report.

**Alternative — fan out over filed work items.** When the plan's work already
lives in Redline's durable work graph (the plan or your launch prompt names
work item ids, or says to drain the ready frontier), you MAY skip
re-decomposing the plan and instead fan out over the ready items for this
project. List them from the open read route (no token needed):

```bash
curl -s "http://127.0.0.1:7676/v1/work/ready?project=$PWD"
```

**Claim before building, close after verifying.** Claim an item before any
agent touches it, and close it only after its verify stage passes, with a
reason. Both are write routes — import the token exactly as the exit report
does (never write the variable inline; the sandbox rejects shell expansion):

```bash
curl -s "http://127.0.0.1:7676/v1/work/<item_id>/claim" \
  --variable %REDLINE_DAEMON_TOKEN= \
  --expand-header "Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"assignee":"orchestrator:<plan_session_id>"}'
```

```bash
curl -s "http://127.0.0.1:7676/v1/work/<item_id>/close" \
  --variable %REDLINE_DAEMON_TOKEN= \
  --expand-header "Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"reason":"done: <how the verify stage passed>"}'
```

A 409 on claim means another run took the item — skip it, never fight for it.
Each claimed item still gets the same machine-checkable verify stage as a
plan-decomposed subtask, and each maps into the exit report's `subtasks` like
any other (name the item id in `notes`). Items the run cannot verify stay
open for the next run — never close an item just to tidy the list; an
unverified claim simply lapses (the lease expires and the item returns to the
ready frontier). **Work outlives the run that discovered it.**

## 5. Leave ALL changes uncommitted

The review reads the **uncommitted diff** — staged, unstaged, and untracked.
Do not commit, do not push, do not stage-and-commit "checkpoints". No commit
or push happens unless the user asks for one **after** the review. Subagents
inherit this rule: no agent in the workflow commits anything.

## 6. POST the exit report

When the workflow ends (success or partial), file the structured exit report
**before** opening the review. This is a write route — import the token, never
write `$REDLINE_DAEMON_TOKEN` into the command yourself (the sandbox rejects
shell expansion; curl ≥ 8.3 imports it):

```bash
curl -s http://127.0.0.1:7676/v1/orchestration/report \
  --variable %REDLINE_DAEMON_TOKEN= \
  --expand-header "Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"planSessionId":"<plan_session_id>","scriptPath":"<workflow script path>","workflowRan":true,"summary":"<what happened, 2-4 sentences>","subtasks":[{"title":"<subtask>","planSection":"<plan heading it implements>","verified":true,"skipped":false,"notes":"<how it was verified / why skipped>"}]}'
```

Map every subtask to the plan section it implements — the report is how
Redline pairs your claims against the ground truth it observed. Skipped or
unverified subtasks are reported as such, never omitted.

## 7. Finish with the human review

**Only the orchestrator session — this session — opens the review, and only
after the workflow returns.** Subagents inherit the user's allowlist and must
never open a held review POST mid-fan-out: a blocking curl inside the workflow
deadlocks the run against the reviewer's attention.

Run the blocking review curl from the repo root with the **maximum Bash
timeout** (pass `timeout: 600000` — it blocks while the human reviews; that is
the mechanism, not a hang):

```bash
curl -s "http://127.0.0.1:7676/v1/reviews/start?repo=$PWD&source=uncommitted&plan=<plan_session_id>"
```

The `plan=` parameter ties the review to the plan session so Redline's run
lifecycle follows along. Address feedback rounds per the redline-code-review
skill (line-anchored blocks, `REDLINE_REVIEW_RESOLUTIONS`), re-running the
same curl for each round. When you report back, resolve subtask → plan-section:
say which plan sections landed, which changed under review, and which were
skipped.

## Rules

- The plan is scope; the sidecars are noise; the diff stays uncommitted.
- Never `git stash`, never commit, never push — the review owns what happens
  to the diff.
- The exit report POSTs before the review opens, every run, even a failed one.
- Only this session runs the blocking review curl, only after the workflow
  returns.
