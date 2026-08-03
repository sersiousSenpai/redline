# Polis Librarian — Spike 3a: friction taxonomy & priority order

**Phase 3 research spike.** Fixes the friction *taxonomy* and the *priority order*
the **Librarian** agent applies **before** the `librarian` SKILL.md hardcodes
it. (The plan's Phase 3 called this role "Orchestration"; it was renamed
**Librarian** — its flagship duty is stewarding the prompt/context *library*.) The
Librarian's flagship duty is stewarding the data lake; its output is a prioritized
next-actions checklist. This note decides what counts as friction and
in what order it should be surfaced.

Date: 2026-07-03. Author: Phase 3 build session.

## Corpus (grounded in the REAL database, with the empty-lake caveat)

The live lake was still essentially empty at spike time (Phases 1–2 are
GUI-unverified — the runtime DB has `ledger_events = 1`, `prompts = 1`, and the
`class_*` tables are not yet migrated into it). So the ClassMemory-specific
signals (backlog, held proposals, bulging branches) could not be measured on real
volume and were reasoned about structurally. Everything else was measured on the
**real** data that already exists in `com.redline.app/redline.db`:

- **7-repo registry** (`list_project_paths`), **2 missions** (`GMLG Data Breach
  Hub page` 3d old, `AI Memory` 0d old).
- **64 sessions**: 40 `approved`, 24 `in_review`.
- **100 comments**: 71 `resolved`, 18 `draft`, 8 `accepted`, 3 `submitted`.
- **In-review staleness is real and large.** The 6 oldest `in_review` sessions
  are 12–20 days old. The archetypal friction row: session `8388e9f8` (repo
  `redline`) — **15 unresolved comments, 19 days in review**. That single row is
  the clearest "you forgot about this" signal in the whole corpus.

This is enough to fix the order. When the lake fills, the ClassMemory rows (F1,
F2, F5 below) gain real magnitude; the order does not change.

## Friction taxonomy

Every friction is a **ground-truth signal** the Rust digest computes from existing
accessors (never inferred by the agent). Each carries a *magnitude* = count ×
staleness so the agent can escalate on size, not just category.

| id | friction | ground-truth signal (accessor) | reversible? | needs a human? |
|---|---|---|---|---|
| **F1** | Held structural/collapse proposal awaiting review | `list_class_proposals()` (collapse held by the auto-collapse interlock is the sharp case) | **no** (collapse deletes a subtree) | **yes** |
| **F2** | Unstructured lake backlog | `max_ledger_seq() − last_run_seq_to()` | yes (one Organize) | no (auto-applies) |
| **F3** | Stalled in-review session w/ unresolved comments | `load_all()` status=`in_review` × comments with `resolution_accepted_at IS NULL`, aged by `created_at` | yes | **yes** |
| **F4** | Aging in-review session (no open comments) | `load_all()` status=`in_review`, old `created_at` | yes | yes |
| **F5** | Bulging un-promoted branch | `list_class_nodes_with_counts()` — a large leaf pile under a root | yes (promote) | soft |
| **F6** | Un-exported approved plan | **NO BACKING STATE** — deferred to Phase 4 | — | — |
| **F7** | Mission in flight / abandoned | `list_missions()` + age | yes | soft |
| **F8** | Source-trust coverage | `domain_feedback_summary()` | — | no |

### F6 is deliberately NOT emitted

There is no export/mirror state anywhere in `db.rs`/`state.rs` today — an approved
plan carries no "was it exported/mirrored" flag (the export/mirror machinery lands
in **Phase 4**). The Librarian therefore must **not** claim "N un-exported
approved plans"; it would be fabricating a signal it cannot measure. F6 re-enters
the taxonomy once Phase 4 adds mirror/export bookkeeping. Until then the digest
omits it entirely (documented so a future reader knows it was a conscious gap, not
an oversight).

## Priority order (the decision this spike fixes)

**Ordering principle:** `cost-of-inaction × irreversibility × human-decision-
required`, with a magnitude escalation so extreme size can float a lower category
up. Destructive-and-pending outranks hygiene; the flagship lake-stewardship duty
(F2) escalates with backlog size but sits below the two things that are either
destructive (F1) or actively losing in-flight work (F3).

1. **F1 — Held structural/collapse proposals.** A queued `collapse` is one accept
   from deleting a catalog subtree; it is sitting *because* the safety interlock
   was unsure. Destructive + pending a human = top.
2. **F3 — Stalled in-review sessions with unresolved comments.** In-flight work
   with forgotten decisions (the 19-day / 15-comment session). Highest *non-
   destructive* cost: continuity is bleeding away.
3. **F2 — Unstructured lake backlog** (the flagship stewardship signal). Scaled by
   size relative to the lake — a large backlog degrades retrieval; a trivial one is
   noise. Non-destructive and one Organize fixes it, so it ranks below F1/F3, **but
   a large backlog escalates** (see rule below).
4. **F5 — Bulging un-promoted branches.** Taxonomy drift; retrieval quality. Fix =
   review a promote proposal.
5. **F4 — Aging in-review sessions without open comments.** Hygiene: approve/abort
   cleanup.
6. **F7 / F8 — Informational** (missions in flight, source-trust coverage).
   Surfaced only when nothing above dominates.
7. **F6 — Deferred** (no state until Phase 4).

**Magnitude escalation (so category is a default, not a straitjacket):** each item
carries `count` + `staleness`. The agent may float a lower category above a higher
one when its magnitude is extreme — a 500-event backlog (F2) outranks a single
2-day-old in-review session (F3/F4); a lone trivial backlog of 3 events stays below
a 19-day stalled review. The Rust digest supplies the magnitudes as ground truth;
the SKILL encodes this base order + the escalation rule; the agent applies
judgment, exactly as the classifier does for taxonomy ops.

## What the Librarian emits

A prioritized `checklist` (JSON, machine-parsed like the classifier's proposals):
each item is `{priority, category, title, detail, action?, count?}`, most-urgent
first, plus a one-line `summary`. `category` is one of the friction ids above
(`held_proposal`, `unstructured_backlog`, `stalled_review`, `bulging_branch`,
`aging_session`, `mission`, `source_trust`). `action` is an optional hint the UI
maps to a button (`organize`, `review_proposals`, `open_session`, …). On-demand
only — no background daemon.

## Handoff

The `librarian` SKILL.md encodes this order + the escalation rule verbatim;
`context.rs` computes the ground-truth digest (and serves it at
`GET /v1/context/overview`); `librarian.rs` bakes the digest into the agent prompt
and parses the checklist back.
