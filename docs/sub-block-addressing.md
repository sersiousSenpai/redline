# Sub-block addressing — design memo

Status: **implemented** — sidecar grammar (`SidecarId` enum in
`src-tauri/src/parser.rs` + TS mirror in `src/editor/markdown/sidecar.ts`),
selection-time capture (`src/hooks/useTextSelection.ts` →
`computeSubBlockId` in `src/editor/subBlockResolve.ts`), three-tier resolver
(`src/editor/extensions/CommentHighlights.ts` → sub-block id → char range →
quoted-text self-heal), and sentence-level diff decomposition
(`src/diff.ts::computeParagraphDiff` populates `subBlocks`;
`src/editor/extensions/RedlineDecorations.ts` paints inline gutter bars per
modified sentence). Companion to the precision-highlight work shipped earlier
(full-block paint suppressed when inline `rl_ins`/`rl_del` marks exist).

One adopted simplification vs. this memo: sub-block sidecars **never enter
the markdown body** — they live only on `CommentSelection.sub_block_id`
(persisted in the `sel_sub_block_id` column). The id is a stable name;
resolution tokenizes the current block body on demand. That eliminated the
need for a separate parser rebind pass for sub-block ids — when the parent
block survives rebinding, the sub-id resolves against the current body via
the segmenter; when it doesn't, the resolver falls through to char offsets
and then to quoted-text self-heal.

## Why this exists

Today the canonical identity unit is the **block** (`<!-- rl:blk-XXXXXXXX -->`,
minted in `src-tauri/src/parser.rs::mint_block_id`). Everything sub-block is
derived on demand:

- The block-level diff (`src/diff.ts::computeParagraphDiff`) keys on `blockId`
  → status `unchanged | added | modified | moved`.
- Word-level marks (`rl_ins` / `rl_del`) come from `diffWords` in
  `applyRevisionRedline` (`src/editor/docModel.ts`), recomputed on every paint.
- Comment selections (`CommentSelection { charStart, charEnd, quotedText }`
  in `src-tauri/src/state.rs`) anchor at character offsets inside the block's
  flat `textContent`, with a `quotedText` self-heal fallback.

This is fine in the small. It gets fragile when:

1. A revision swaps two adjacent lines inside one paragraph. We currently mark
   the whole paragraph as `modified`. With explicit line IDs we could mark
   `l2` as `moved` and `l3` as `moved` and leave the rest alone.
2. A comment is anchored at `(charStart=180, charEnd=215)` and Claude rewrites
   the first sentence, shifting every later offset. `quotedText` self-heal
   often saves us, but ambiguous matches drop the highlight silently.
3. Two reviewers (future case) want to comment on overlapping sub-spans. With
   char offsets we have to compare ranges; with structured `l/w` ids we have
   a stable key per span.

The "battleship-like cross hash" phrasing from the original request maps to
this: a stable two-axis (line × word) coordinate that survives reflow.

## Address grammar (proposed)

Extend the existing sidecar comment grammar rather than introducing a parallel
channel:

```
<!-- rl:blk-XXXXXXXX -->
<!-- rl:blk-XXXXXXXX.l2 -->                — line 2 of the block
<!-- rl:blk-XXXXXXXX.l2.w5 -->             — word 5 of line 2
<!-- rl:blk-XXXXXXXX.l2.w5-w8 -->          — words 5-8 inclusive
<!-- rl:blk-XXXXXXXX.l2.c14-c30 -->        — char range 14-30 within line 2
```

Constraints:

- Lines are 1-indexed within the block's serialized markdown (post-sidecar
  strip). A "line" is a soft-wrap-agnostic source line — what `'\n'.split` would
  give. Empty lines do not increment the counter.
- Words are 1-indexed within their line, using the same `/\s+/` tokenizer as
  `src/editor/wordDiff.ts` so a sub-block id stays consistent with what the
  word-diff sees.
- Char offsets are byte-safe (use grapheme-cluster boundaries, not raw bytes
  or UTF-16 code units) — match the comment-selection model already in
  `useTextSelection`.
- Word ranges (`w5-w8`) and char ranges (`c14-c30`) are inclusive at both ends
  to match how the user thinks ("highlight words 5 through 8"), not how slice
  semantics work. Convert at the boundary.

Sidecars stay HTML comments so they survive every markdown renderer; they
stay strippable via the existing `parser::strip_sidecar_lines` (just need to
broaden the regex to allow the `.lN.wN` suffix).

Sidecar density: a sub-block id is only emitted when something references it
(a comment, a diff op, a tracked move). The default state is "block id only"
exactly as today — no churn on the wire format for unchanged docs.

## Rebind invariants

Block-id rebind (`parser::rebind_block_ids_from_previous`) is conservative —
it only rebinds when exactly one v1 candidate matches a paragraph's signature.
Sub-block rebind is *much* harder because reflow is the common case:

- **Line rebind**: a "line" in markdown is a hard newline. If a paragraph
  goes from three short lines to two long lines (or vice versa), there is no
  meaningful 1:1 line mapping. Skip rebinding: drop sub-block ids and let
  fresh ones mint. The block-level rebind already preserves the parent block,
  so comments and diffs anchored at block-level keep working — only `l/w`-
  anchored comments will fall back to their `quotedText` self-heal.
- **Word rebind**: only attempt within a rebound `l`. Use the same word
  tokenizer; signature is `(word_index, normalized_word_text)`. Same
  conservative rule: rebind only when exactly one v1 candidate matches.
- **Char rebind**: don't rebind at all — char offsets are too fine-grained
  to survive any reflow. Char-ranged comments degrade to `quotedText` self-
  heal exactly like today.

Concretely: extend `parser::rebind_block_ids` into a second pass that, for
each rebound block whose paragraph text is *byte-identical* (no reflow), copies
over its v1 sub-block sidecars into the same byte offsets. Anything else gets
fresh sub-block ids. This is the conservative "do no harm" path.

## Comment-anchoring impact

`CommentSelection { charStart, charEnd, quotedText }` is already
char-precise. The question is whether to **replace** char offsets with `(blk,
l, w)` triples or **augment** them.

Recommendation: augment. The data model becomes:

```rust
pub struct CommentSelection {
    pub char_start: u32,           // unchanged
    pub char_end: u32,             // unchanged
    pub quoted_text: String,       // unchanged
    pub sub_block_id: Option<String>,  // new: "blk-XXX.l2.w5-w8" if available
}
```

Capture: `useTextSelection` already walks DOM text nodes to compute
`charStart`/`charEnd`. Same walk can record the line index (count `\n` in the
prefix) and the word index (split the line's prefix on `/\s+/`). Emit the
sub-block id when the selection lands on a whole-word or whole-line boundary;
fall through to char offsets otherwise.

Resolve: `CommentHighlights.resolveRange` consults the sub-block id first
(stable across reflow), falls through to char offsets (today's behavior),
finally to the `quotedText` self-heal.

DB migration: add `sub_block_id TEXT NULL` to `comments` next to the existing
`sel_*` columns. Same `ALTER TABLE … ADD COLUMN` pattern as Phase B
(`src-tauri/src/db.rs:183`).

## Diff implications

`computeParagraphDiff` today returns one of four statuses per paragraph.
With sub-block ids, the diff can decompose:

- A `modified` paragraph that touched only line 2 emits `unchanged` for
  l1/l3/l4 and `modified` for l2. The block-level paint can then show only
  the l2 line in `.rl-block-changed-bar` style.
- A reordered paragraph emits `moved` for the affected line ids and
  `unchanged` for the rest.

`RedlineDecorations` would shift from "one decoration per node" to "one
decoration per sub-block range" (line 0..n, words a..b). Pieces in place:
the precision-highlight code already walks descendants and inspects marks.

`diffWords` stays the workhorse for inline marks; sub-block ids are an
*addressing* layer, not a different diff algorithm.

## Compatibility and migration

- **v1 plans without sub-block sidecars** load exactly as today. The parser
  walks blocks, mints `blk-…` ids for any block without one, and never emits
  `l/w` ids unless something asks for them.
- **First write of sub-block ids** happens lazily: when a comment is anchored
  at sub-block granularity, or when the diff decomposes. The block remains
  the indivisible unit on the wire; sub-block sidecars are append-only.
- **Rebind across versions** works for unchanged blocks (byte-identical
  paragraph text); other blocks lose their sub-block ids and re-mint, falling
  back to char-offset + `quotedText` self-heal for comment highlights.
- **SKILL.md contract** stays unchanged: Claude is asked to preserve
  `<!-- rl:blk-… -->` sidecars exactly. Extending the regex it cares about to
  also tolerate the `.l/w` suffix is a one-line change. Claude is not asked
  to *emit* sub-block ids — Redline does that on parse.

## What would actually need to change

For the smallest credible implementation:

1. `src-tauri/src/parser.rs`
   - Broaden `parse_sidecar_id` to accept the `.lN[.wM[-wK]]` suffix and
     return a richer enum (`BlockId | LineId | WordRangeId | CharRangeId`).
   - Add `mint_sub_block_id(parent, line, word)` and a second-pass rebind
     that preserves sub-block ids only when the parent block's paragraph text
     is byte-identical between revisions.

2. `src-tauri/src/state.rs` + `src-tauri/src/db.rs`
   - Add `sub_block_id: Option<String>` to `CommentSelection`.
   - Add a `sub_block_id TEXT NULL` column to `comments`.

3. `src/editor/markdown/sidecar.ts` + `src/editor/markdown/parser.ts`
   - Mirror the broadened sidecar grammar on the TS side so the roundtrip
     gate (`roundtrip.test.ts`) stays green.

4. `src/hooks/useTextSelection.ts`
   - Compute the sub-block id alongside `charStart` / `charEnd`. Emit only
     for whole-word or whole-line selections.

5. `src/editor/extensions/CommentHighlights.ts`
   - Resolve sub-block id → range first, then existing char-offset path, then
     `quotedText` self-heal.

6. `src/diff.ts` + `src/editor/extensions/RedlineDecorations.ts`
   - Optional, but the visible payoff: sub-block-aware diff decomposition so
     the gutter bar can sit next to one line instead of the whole paragraph.

7. `skills/redline/SKILL.md`
   - One sentence noting the extended sidecar grammar.

## Non-goals

- Mutating Claude's plan content to insert sub-block ids before it sees them.
  Sub-block ids are a Redline-side addressing layer; Claude only sees block
  ids on the wire.
- Tracking word edits *across reflowed paragraphs*. The block-level rebind
  covers paragraph-level continuity; sub-block continuity is best-effort.
- Replacing `diffWords`. Word diff stays the source of truth for what changed
  inside a line; sub-block ids are stable *names* for spans, not the diff
  algorithm.

## Open questions

- ~~Should `c14-c30` exist at all, or is "char range" always derived from a
  selection and never persisted as an id?~~ **Closed (no)**: char ranges live
  in `CommentSelection.charStart`/`charEnd` only; the sidecar grammar tops
  out at `.wN[-wM]`. Char-precision below the word level travels with the
  comment record, not with an id.
- For tables and code blocks, "line" is well-defined; for a paragraph with
  soft line breaks the markdown source has one line but the render has many.
  We address against the *markdown source*, not the rendered DOM, because the
  source is what travels on the wire.
- Mixed-content blocks (paragraph with inline code spans) — the word
  tokenizer treats `` `foo` `` as one word. Probably fine; verify on first
  real use.

Revisit after the precision-highlight change has been used in practice for a
while; the `l/w` work is worth doing only if a recurring pain point points
back here.
