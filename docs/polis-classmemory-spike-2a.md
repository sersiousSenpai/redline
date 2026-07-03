# Polis ClassMemory — Spike 2a: taxonomy shape & promotion threshold

**Question (from the plan):** on ~50 real captured prompts, what shape does an
emergent taxonomy take — how deep do branches get, and *when does a topic earn
promotion* to its own class? Plus two acceptance queries the accepted tree must
answer.

**Corpus caveat (honest):** the live `prompts` table is empty — Phase 1 shipped
but is GUI-unverified, so no interactive prompts have been captured yet. This
spike therefore runs on a **reconstructed corpus** drawn from ground truth that
*does* exist: the 7-path project registry (`list_project_paths()`), the 2 real
missions, 137 revisions, and the documented work history in the memory index.
Every project/topic named below was verified against the real repos (e.g. Clerk
appears in `muslimlegalconnect/package.json` and `nplajobportal/package.json`;
Loop Orchestrator was really removed in `a6861d9`). When real capture data
lands, re-run this spike — the SKILL's judgment rules are written to be corpus-
independent, but the thresholds should be sanity-checked against live depth.

## Reconstructed corpus (representative, ~50 items)

Seeded roots (one per registry path + `~general`):

| root | real signal |
|---|---|
| `redline` | this repo — Polis, collab, browser, voice, Loop Orch |
| `muslimlegalconnect` | Clerk auth, directory app |
| `nplajobportal` (+ `/client`) | Next 16 / React 19 / Clerk / Prisma job board |
| `albazianlaw.com` | law firm marketing site |
| `Specs Base Template` | spec scaffolding |
| `yusufalbazian` (`$HOME`) | repo-less sessions ran here |
| `~general` | web research with no repo |

Representative prompt clusters (surface in parens):

- **redline / Loop Engineering** — "wire the loop executor spawn+stream" (plan),
  "the loop orchestrator doesn't work, off core value prop" (discussion),
  *approval*: "remove Loop Orchestrator from the product" (decision/approval),
  "park working v1 on feature/loop-orchestrator" (revision). → 6 prompts + 2
  decisions.
- **redline / Collab** — invites, crypto revoke+rotation, joined shadow. → 5.
- **redline / Browser** — tab suspension, OAuth popups, fullscreen. → 5.
- **muslimlegalconnect / Auth / Clerk** — "wire Clerk backend session
  verification", "Clerk webhook for user.created", *research*: "Clerk vs
  self-host for the directory". → 4 prompts + 1 source-trust.
- **nplajobportal / Auth / Clerk** — "Clerk middleware for the job portal",
  "protect employer routes". → 3 (note: **same topic word "Clerk", different
  project** — the disambiguation stress test).
- **nplajobportal / Data / Prisma** — schema, migrations, seed. → 4.
- **~general / Investing / Quantum stocks** — 6 web-research prompts, no repo.
- **~general / Data breach (GMLG mission)** — competitor page teardown. → 5.
- Scattered one-offs (a stray "fix this typo", a "what's the git status") → 4.

## Findings

### 1. Depth is 2–3, and it is earned, not fixed

The natural shape is **root → topic → (sub-topic)**, i.e. depth 2 almost always,
depth 3 only when a sub-topic itself accumulates. `redline/Loop Engineering`,
`muslimlegalconnect/Auth/Clerk`, `~general/Investing/Quantum stocks`. A rigid
"level" enum would be wrong — hence the plan's decision that **a class is just a
root node and depth is emergent** (no level column). Confirmed: nothing in the
corpus wanted a fixed 3-level hierarchy; some branches are flat (`albazianlaw`
had 3 loose prompts, no sub-topic earned).

### 2. Promotion threshold — the rule that generalizes

A leaf pile earns promotion to a named class when **all three** hold (these are
the SKILL's *judgment* signals, never a hardcoded count):

- **Size** — roughly ≥4–6 linked items sharing a subject. Below that, filing
  under the parent is less noise than a near-empty class. (Clerk-in-mlc at 5
  earns it; `albazianlaw` at 3 loose items does not.)
- **Coherence** — the items share a *predicate-stable subject* (see 2b): "Clerk
  session/webhook/middleware" is one subject; "auth stuff + a CSS fix + a
  deploy" is not, even at 5 items.
- **Recency/activity** — a topic actively being worked (new items in the delta)
  promotes sooner than a cold pile of the same size, because promotion pays off
  for *retrieval you'll do soon*. A cold pile of 8 is a **collapse** candidate,
  not a promote candidate — same size, opposite action, decided by recency.

The load-bearing insight: **size alone is a trap.** Size × coherence × recency is
what separates promote / leave / collapse. This is written into the SKILL as a
rationale requirement, not a threshold constant.

### 3. Provenance disambiguates — the Clerk collision

"Clerk" appears under **two** projects. The retrieval query *"what was I
researching about Clerk when building muslimlegalconnect?"* MUST land on
`muslimlegalconnect → Auth → Clerk`, not `nplajobportal → Auth → Clerk`. This
works only because provenance (`project_path`) is fed to the classifier as
**ground truth, never inferred** — the mlc prompts carry `project_path =
…/muslimlegalconnect`, so the classifier files them under the mlc root and never
guesses from the word "Clerk". This is the single most important thing the SKILL
must not get wrong, and it's a data-fact guarantee, not a model judgment.

## Acceptance queries (the plan's two)

**Q1 — "what did I decide about the Loop Orch feature for the Beta?" (asked from
the redline repo).** Resolution walk:

1. cwd repo = redline → resolve root `redline` (strong prior).
2. Walk `redline` children → `Loop Engineering` class.
3. The question verb is **decide** → retrieval weights **decision events first**.
   The Loop Engineering leaf links include an `approval` event ("remove Loop
   Orchestrator from the product") and a `resolution`. Answer resolves to *those
   decision rows*, **not** the discussion prose that merely debated it.

This is why the SKILL's retrieval contract says *"'what did I decide' resolves to
decision events first"* — the ledger distinguishes what was *discussed* from what
was *decided*, and the query verb selects between them.

**Q2 — "what was I researching about Clerk when building muslimlegalconnect?"**
Resolution walk:

1. named project "muslimlegalconnect" overrides cwd → root `muslimlegalconnect`.
2. Walk children → `Auth` → `Clerk`.
3. verb **research** → weight `prompt` items tagged `surface=browse/mission` and
   `source_trust` over decisions. Lands on the Clerk-vs-self-host research prompt
   + the source-trust verdict. Never crosses into `nplajobportal/Auth/Clerk`
   because the project binding fenced the walk to the mlc root.

Both queries resolve correctly **through the accepted tree**, landing on decision
events where the verb asks "what did I decide." ✔

## What this locks into the SKILL

- Depth emergent (2–3), no level enum. ✔ (matches schema decision)
- Promotion = size × coherence × recency, stated as rationale, never a constant.
- Provenance (`project_path`/`surface`/dates) is ground truth fed in, never
  inferred — the Clerk collision proves why.
- Retrieval routes by **verb class**: decide→decisions, research→prompts/trust.
