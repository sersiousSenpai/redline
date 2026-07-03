---
name: classmemory
description: >-
  Classifying Redline's prompt/decision "lake" into an emergent, human-curated
  class catalog, and retrieving from it. Use when running as the ClassMemory
  classifier (organizing captured prompts + decision/curation events into a
  reviewable class tree by emitting structured-JSON proposals) OR when an agent
  needs to RETRIEVE from ClassMemory to answer "what did I decide / research
  about X". Covers the emergent-taxonomy rules (repos seed roots; topics earn
  promotion by size × coherence × recency), the six proposal ops (file / create
  / promote / split / merge / collapse), the proposals-only + provenance-as-
  ground-truth discipline, and the vectorless tree-walk retrieval contract.
version: 1
---

# Redline ClassMemory

ClassMemory is a **catalog over the lake**. The *lake* (Phase 1) is the raw,
append-only, hash-chained record of every prompt, plan revision, and
decision/curation signal — never reorganized. ClassMemory is an emergent tree of
**class nodes** whose leaves are only *pointers* into that lake. Reorganizing the
tree never touches or re-copies the underlying data.

You act in one of two roles. Read the section for yours.

---

## Role A — Classifier (you organize the tree)

You are handed: the **accepted class tree** and a **delta** of new lake items
(prompts + decision events since the last run). You return a JSON object of ops.
**By default Redline applies your ops directly** — you are the orchestrator that
organizes the lake, not a suggestion box. There is no required human approval
step; the human curates *after* if they want (rename, pin, move, undo in the 🧠
pane), and every reorganization you make is written to the hash-chained ledger as
a `taxonomy_reorg` event, so the whole taxonomy is auditable and reversible. That
safety net is *why* you can organize directly — so organize with judgment, and be
especially conservative with the one destructive op (`collapse`, below).

(A reviewer may switch Redline into review-before-apply mode, in which your ops
stage as proposals to accept in the pane. Your output is identical either way —
you always just emit the best organization; write it as if it will be applied.)

### Ground rules (do not violate)

1. **Provenance is ground truth — never infer it.** Every lake item carries its
   `project_path` and `surface` as fact (a session knows its repo; a browse tab
   resolved to a project). File items under the root their `project_path` names.
   Never guess a project from the *words* of a prompt. This is load-bearing:
   "Clerk" appears under *two* projects (muslimlegalconnect and nplajobportal) —
   only the `project_path` tells them apart. Getting this wrong corrupts
   retrieval.
2. **Organize with judgment.** You apply real structure — don't thrash (promote
   then merge back next run), don't create near-empty classes, and **collapse
   only branches you are confident are cold** (that op removes the catalog
   subtree; its sourcing survives only via the digest's `cite_seqs`).
3. **Rationale on every op.** State the *why* — it becomes the ledger record of
   the reorganization.

### The shape: emergent, 2–3 deep

- A **class is just a root node** (repos seed roots; `~general` holds repo-less
  research). Depth is emergent — most branches are `root → topic`, some reach
  `root → topic → sub-topic` (e.g. `muslimlegalconnect → Auth → Clerk`). There is
  no fixed level count. Some roots stay flat.
- **Decisions classify alongside the prompts they resolve.** A resolution/
  approval about the loop engine files under the same `Loop Engineering` node as
  the prompts that built it — so "what did I *decide*" and "how did I *build* it"
  live together, distinguished by event kind, not by tree location.

### When a topic earns promotion (the judgment, never a count)

A pile of leaves earns its own class when **size × coherence × recency** all hold
— these are *your judgment*, never a hardcoded threshold:

- **Size** — enough linked items to be worth a class (a near-empty class is more
  noise than filing under the parent). A handful sharing a subject, not two.
- **Coherence** — the items share a *predicate-stable subject*. "Clerk session /
  webhook / middleware" is one subject. "auth + a CSS fix + a deploy" is not,
  even at the same size. **Do not split a coherent subject on its verbs** — a
  `remove`/`fix`/`deploy` verb is *not* a new class; `remove Loop Orchestrator`
  files under `Loop Engineering`, it does not create a `Removal` class.
- **Recency** — an actively-worked topic promotes sooner (retrieval pays off
  soon). A *cold* pile of the same size is a **collapse** candidate, not a
  promote candidate — same size, opposite action, decided by recency.

### What "cold" means (so `collapse` has a defined scope)

`collapse` is the one destructive op — it removes a branch's catalog subtree,
leaving a digest that cites the exact ledger rows. So "cold" must be precise,
not a vibe. You are given the facts to judge it as **ground truth** — each branch
in the tree shows `items` (how much it holds) and `idle` (days since its newest
lake item), plus a **lake activity envelope** (the span of your whole history).
Judge coldness on three axes, in this scope:

1. **Temporal, relative to the lake's own span — never wall-clock.** The lake's
   *newest* event is "now" (Redline may have been closed for weeks). A branch is
   cold when its `idle` covers **most of the lake's span** — it went quiet while
   you did a substantial, more-recent chunk of other work. A branch touched
   within the freshest slice of the span is **not** cold, however old in calendar
   days. (Redline enforces this as a floor: a not-clearly-cold `collapse` is held
   for your manual review rather than auto-applied.)
2. **Storage / size — is it even worth collapsing?** A digest must *compress*
   something. Collapsing a 1–2 item branch loses granularity for no gain — leave
   tiny branches alone (or `merge` them). Collapse pays off on branches large
   enough that a summary genuinely declutters the tree.
3. **Terminal vs open.** A branch whose latest decision is *terminal* (approved-
   and-removed, shipped, abandoned — e.g. Loop Orch's "removed from the product")
   is a strong collapse signal: the topic reached a conclusion. A branch with
   open threads or unresolved comments is **not** cold, regardless of idle time.

**Pins are an absolute veto** — a pinned branch (or one with any pinned
descendant) never collapses, period. Coldness is scoped to the **branch's whole
subtree**: a class is cold only if *everything under it* went quiet, measured
against the whole lake's recency (so a dormant *project* doesn't self-collapse —
its branches are judged against your overall activity, not just each other).

### The six ops

Return `{"proposals": [ … ]}` — a JSON object, optionally in a ```json fence.
Each op:

| op | when | key fields |
|---|---|---|
| `file` | attach a lake item to a node (optionally into a new sub-class) | `parent_id`, `sub_class?`, `target_kind`, `target_id`, `note?` |
| `create` | a new class/sub-class earns its place | `parent_id`, `title` |
| `promote` | a grown sub-topic becomes its own class (re-parent) | `node_id`, `new_parent_id?` |
| `split` | one node holds two distinct subjects | `node_id`, `into:[{title,link_ids}]` |
| `merge` | duplicate/overlapping nodes are one subject | `node_ids:[…]`, `title?` |
| `collapse` | a cold, unpinned branch decays to a digest | `node_id`, `summary`, `cite_seqs:[…]` |

- `target_kind` ∈ `prompt | session | revision | mission | decision`;
  `target_id` is the lake id (prompt seq, session id, ledger seq, mission id).
- **`collapse` must cite exact ledger seqs.** The digest's `summary` is your
  agent-written gist; its `cite_seqs` are the exact ledger rows it summarizes.
  Blurriness lives at the summary level — sourcing stays perfect one hop away.
  Only collapse **cold, unpinned** branches (pins are anti-decay markers).
- **`promote` preserves everything** — id, links, pins, and the whole subtree
  ride along. That is why growing a topic and re-rooting it loses nothing.

Example:

```json
{"proposals":[
  {"op":"create","parent_id":"root-redline","title":"Loop Engineering","rationale":"6 loop-executor prompts + 2 decisions cohere and were active this week"},
  {"op":"file","parent_id":"root-redline","sub_class":"Loop Engineering","target_kind":"decision","target_id":"318","note":"approved: remove from product","rationale":"the beta decision, not just discussion"},
  {"op":"collapse","node_id":"cn-oldinvest","summary":"Explored quantum-computing stocks; parked, no position taken.","cite_seqs":[71,74,80],"rationale":"cold 5 weeks, unpinned, never queried"}
]}
```

Do **not** parse or store subject-verb-object structure per prompt — the object
(noun) plus provenance is all that decides filing; the verb is noise for
classification (it matters only at *retrieval* time, below). Emit only proposals
for genuine changes; an empty `proposals` array is a valid, correct answer when
the delta doesn't warrant reorganization.

---

## Role B — Retrieval (you read the tree to answer a question)

When you need memory to answer "what did I decide / research about X", walk the
catalog — it is a **vectorless tree-walk**, not a similarity search:

1. **Resolve the class (step 0).** The cwd repo is a strong prior. An explicitly
   named repo or class overrides it. `~general` and other classes compete on
   equal footing when no repo is named.
   - `curl -s http://127.0.0.1:7676/v1/memory/tree` — the accepted tree (pass
     `?project=<path>` or `?root=<id>` to scope).
2. **Descend to the topic node**, then read its links:
   - `curl -s http://127.0.0.1:7676/v1/memory/node/<id>` — the node, its
     children, and its links (pointers into the lake).
3. **Route by the question's verb** (this is where predicate structure earns its
   keep — at query time, not stored):
   - **"what did I *decide*"** → weight **decision events first**
     (`approval` / `resolution` / `review_verdict` links), *not* the discussion
     prose that merely debated it.
   - **"what was I *researching*"** → weight `prompt` links with
     `surface = browse/mission` and `source_trust`.
   - **"how did I *build/wire*"** → weight `prompt` (plan/rust) + `revision`.
4. **Expand a `digest` node only when detail is needed** — its `summary` answers
   most questions; when you need specifics, follow its `cite_seqs` links to the
   exact ledger rows.

Worked examples (both must resolve *through the accepted tree*):

- *"what did I decide about the Loop Orch feature for the Beta?"* (from the
  redline repo) → root `redline` → `Loop Engineering` → verb **decide** → the
  `approval` event ("remove Loop Orchestrator from the product"), not the debate.
- *"what was I researching about Clerk when building muslimlegalconnect?"* →
  named project overrides cwd → root `muslimlegalconnect` → `Auth` → `Clerk` →
  verb **research** → the Clerk-vs-self-host research + source-trust verdict.
  Never crosses into `nplajobportal/Auth/Clerk` — the project binding fences the
  walk.
