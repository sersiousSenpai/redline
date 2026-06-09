# Redline as a Document IDE — north-star roadmap

**Status:** approved direction (2026-06-09), not yet started. Continuity in memory
`project_redline_collab_docx_vision`. This is the founding roadmap for turning
Redline from a plan-review companion into a **multiplayer, AI-native document
IDE** that edits either a Claude Code markdown plan or a Word-class document, with
each human paired with their own Claude Code.

---

## The one governing rule (read this first)

> **The internal document model is the product. Every file format — markdown,
> `.docx`, and any future native format — is a removable adapter plugged into a
> single socket. The rest of Redline only ever speaks the internal model; it
> never touches a file format directly.**

Everything below exists to honor that rule. It is what lets us (a) match SuperDoc
where it counts without rebuilding their engine, (b) defer the hard/expensive
arbitrary-import decision until we have real demand, and (c) keep the door open to
a native AI-native file type *years* from now without rearchitecting.

The internal model already exists in seed form and is the crown jewel:
- **Addressable units** — `rl:blk-` block identity (every block has a stable ID).
- **Provenance & history** — the change ledger + resolution blocks (who/what/why).
- **CRDT-native collaboration** — Yjs.
- **Intent / orchestration layer** — per-user Claude Code agents.

---

## The distinction everything hinges on: born-in-app vs arbitrary import

- **Born in Redline** — we *created* the document inside Redline, so we understand
  every byte of formatting because we put it there. Export to `.docx` is clean and
  predictable. **We can match SuperDoc here almost immediately.**
- **Arbitrary import** — a stranger's `.docx` (e.g. a 40-page law-firm contract
  with auto-numbered clauses, a TOC, footnotes, cross-references, prior tracked
  changes, custom styles). We must read formatting we didn't create, display it,
  let users edit it, and write it back without breaking the untouched parts. **This
  is SuperDoc's specialty and where they are years ahead.** The plan deliberately
  *defers* this behind the adapter socket.

Fidelity is proportional to scope. Nobody — not Google Docs, not LibreOffice — is
100% one-to-one with Word. The realistic bar is "indistinguishable for the
documents people actually pass around," anchored on the born-in-app path.

---

## Phase 0 — The seam (architectural commitment, do this first)

Define and freeze the boundary before building features on top of it.

- **Internal `DocModel`** = ProseMirror doc + Yjs CRDT state + `rl:blk-` identity
  sidecars + change ledger. Single source of truth.
- **Adapter interface**: `import(format, bytes) → DocModel` and
  `export(DocModel, format) → bytes`. Formats are pluggable and isolated; nothing
  outside an adapter knows about OOXML, markdown, or any wire format.
- **Isolation guarantee**: any future engine swap (our own, SuperDoc, a conversion
  service, a native format) is a single adapter implementation behind this
  interface — never a rewrite of the app. This is also what keeps acquisition IP
  clean: a copyleft/3rd-party engine, if ever adopted, lives in one removable box.

**Deliverable:** the interface + the existing markdown path reimplemented as the
first adapter, proving the seam.

---

## Phase 1 — Multiplayer born-in-app editor + clean export (the shippable core)

Everything here is permissive open source; Redline stays Apache-licensed.

**Canvas (feels like Word for everyday writing)**
- Headings, bold/italic/underline, color/highlight, lists, tables, links, images,
  quotes, code blocks. (Tiptap/ProseMirror — already in use.)

**Multiplayer (the "expensive" feature that is actually free)**
- Yjs + **self-hosted Hocuspocus** (MIT, the same stack SuperDoc/Tiptap use):
  several people in one doc, live cursors, presence, real-time conflict-free sync.

**Comments & track-changes, reworked onto the CRDT**
- Comments + threads + resolve (we have `CommentHighlights` foundations).
- Track-changes re-modeled as an **authored suggestion layer inside the Yjs doc**
  (marks carrying author + accept/reject state) — not the current single-doc
  base-vs-current diff. This is the hardest *original* engineering in Phase 1.

**Per-user personal AI writer (our moat — SuperDoc has no equivalent)**
- Select text → your Claude Code rewrites **in place as a tracked suggestion**,
  streaming live while teammates watch; accept/reject like any other change.
- Kills the "copy a paragraph out to ChatGPT and paste it back" team workflow.

**Export / import adapters**
- `export → .docx`: clean Word file (born-in-app path) that opens correctly in
  Word/Google Docs and round-trips reliably. Plus markdown export (have it).
- `import ← .docx`: **simple** documents only (text, headings, lists, basic
  tables). Complex arbitrary import is explicitly out of scope here.

**Explicitly deferred in Phase 1:** high-fidelity arbitrary import; page-accurate
WYSIWYG (pagination); long-tail Word features (footnotes, fields/TOC,
cross-references, section-scoped headers/footers).

---

## Phase 2 — AI-with-you depth + the IDE around the document

- **Section-level intent**: instructions that travel with a block ("stay formal,
  under 200 words") that any agent editing it later must respect — the first taste
  of the intent layer that a native format would formalize.
- **Concurrent multi-user agents**: several people each editing alongside their own
  agent, all merged via the CRDT.
- **The document IDE**: project files, terminal, and browser beside the doc;
  transmute a Claude Code plan ↔ a document, anchors carried by `rl:blk-` identity.
- **Surfaced provenance**: see who / which prompt produced each block.

---

## Phase 3 — The arbitrary-import engine decision (the deferred fork)

Only now, with real demand and a real price quote, choose among — all slotting
behind the **same** Phase 0 import adapter, no app rewrite:

1. **Grow our own** OOXML engine (permissive, slow, full ownership).
2. **Adopt SuperDoc** under **AGPL** (best fidelity instantly, but Redline becomes
   copyleft — collides with Apache + CLA; a known acquisition-diligence red flag,
   though isolated to one adapter box).
3. **Adopt SuperDoc** under a **commercial license** (best fidelity, stay
   permissive, pay a negotiated OEM fee — rough model: ~$15–40k/yr, wide error
   bars, grows with us).
4. **Server-side conversion service** (e.g. Pandoc-class) behind the adapter.

Add page-accurate view / pagination here if customers demand it.

---

## Phase 4 / Horizon — the AI-native file type (optionality, adoption-gated)

Pursue **only** if traction warrants. This is *promotion* of the internal model to
a first-class, shareable, on-disk format — not a pivot. What it adds on top of what
we already have:

- **Per-unit embeddings** — every block carries a semantic vector → the document is
  RAG-native; agents navigate and retrieve by *meaning*, not string-matching.
- **Traveling intent** — the prompts/constraints governing each section ship inside
  the file, so any AI that later opens it respects them.
- **Full provenance / prompt history** — every unit knows the prompt and edits that
  produced it (we already record most of this).
- **Presentation-as-derived** — `.docx`/PDF/HTML become *renders of* the semantic
  document, not the document itself. The native format stores meaning + intent +
  history; looks are computed.

Because of the Phase 0 rule, this is "add one more adapter + enrich the model,"
not a rebuild. The thesis: Word/`.docx` is a frozen *picture of how a document
looks*; the AI-native format is a living record of *what it means and how it came
to be*.

---

## Honest sizing & sequencing

- Phases 0–1 are the real near-term build (multi-month): the seam, multiplayer,
  track-changes-over-CRDT, the agent-in-the-doc loop, clean export.
- Phase 2 deepens the differentiator.
- Phase 3 is a *decision*, not a sprint — taken late, on data.
- Phase 4 is a horizon bet, adoption-gated.

No phase forces paying or depending on a closed/copyleft vendor; the only place
"fully permissive" is ever at risk is a *conscious, isolated, reversible* Phase 3
choice. Build the model rich; keep the formats swappable; ship the born-in-app
experience first.
