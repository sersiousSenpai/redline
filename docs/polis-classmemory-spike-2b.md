# Polis ClassMemory — Spike 2b: SVO / predicate decomposition

**Question (from the plan):** does decomposing captured prompts into
subject–verb–object (SVO) / predicate structure **improve retrieval, or add
noise**? Should the classifier (and the class-router in the discussion skills)
reason over an explicit SVO parse, or over the raw prompt + its provenance?

**Corpus:** same reconstructed corpus as [spike 2a](./polis-classmemory-spike-2a.md).

## The experiment

For each prompt, I compared two routing signals:

- **(A) Provenance + raw subject** — `project_path`, `surface`, and the noun
  phrase a human would file it under ("Clerk", "Loop Engineering", "Prisma").
- **(B) Full SVO parse** — extract subject, verb, object and route on all three,
  e.g. *"wire the Clerk backend session verification"* → S=`I`, V=`wire`,
  O=`Clerk backend session verification`.

Then I asked: for the two acceptance queries and ~10 ad-hoc recalls, which signal
put the right node first?

## Findings

### 1. The **object** (noun phrase) is the classifier's whole job; S and V are noise *for classification*

For deciding *where a prompt files*, only the object/subject-noun matters
("Clerk", "the loop executor", "quantum stocks"). The **subject** is almost
always "I / the user" — zero discriminating power. The **verb** ("wire",
"fix", "research") does not change *which class* a prompt belongs to: "wire
Clerk" and "debug Clerk" both file under `Auth/Clerk`. Feeding a full SVO parse
to the *classifier* added tokens without changing a single filing decision, and
in 3 cases actively hurt — a verb-led parse of *"remove Loop Orchestrator"* tried
to create a `Removal` class, splitting the Loop Engineering branch on the verb.
**Verdict: the classifier routes on object + provenance, not SVO.**

### 2. The **verb (predicate class) is decisive for *retrieval*, not classification**

The place predicate structure earns its keep is the **query side**. The verb
class of a *question* selects which links to surface within an already-resolved
class:

| question verb | predicate class | retrieval weight |
|---|---|---|
| "what did I **decide** about X" | decide | `approval`/`resolution`/`review_verdict` events **first** |
| "what was I **researching** about X" | research | `prompt` (browse/mission) + `source_trust` |
| "how did I **build/wire** X" | act | `prompt` (plan/rust) + `revision` |
| "what did I **think** about X" | discuss | discussion-surface prompts + reopen notes |

This is exactly the Loop-Orch acceptance case: same class, but *decide* vs
*research* land on different rows. So predicate decomposition **improves
retrieval** — but only as a coarse **verb→event-kind router**, not a full SVO
parse stored per prompt.

### 3. Storing an SVO parse per prompt = noise and drift

I considered persisting `(subject, verb, object)` columns per prompt. Rejected:

- The subject is constant; the object duplicates what `class_links` + the body
  already hold; the verb is recoverable from `surface`/`kind` at query time.
- A stored parse **drifts** from the raw body (the lake's record of truth) and
  would need its own re-derivation on every reword — exactly the kind of
  reorganized-copy the lake/catalog split exists to avoid.
- Vectors are already ruled out as store-of-record; a per-row SVO parse is the
  same category of derived index, and belongs (if ever) in the *future* recall-
  assist index, not the core store.

## Decision → what goes into the SKILL

- **Classifier:** route on **object/subject noun + provenance**. Do *not* parse
  or store SVO. A verb that looks like it wants its own class (`remove`, `fix`,
  `deploy`) is a **false promotion signal** — the SKILL explicitly warns against
  splitting a coherent subject on its verbs.
- **Retrieval (discussion skills + classmemory retrieval contract):** use the
  **question's verb as a predicate router** to pick event kinds within the
  resolved class — `decide`→decision events first. This is the one place
  predicate structure is load-bearing, and it costs nothing to store because it's
  computed from the query, not persisted.

**Net:** SVO decomposition as a *stored per-prompt structure* adds noise and is
rejected. Predicate (verb-class) routing *of the query* improves retrieval and is
adopted — lightweight, query-time, no schema.
