// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { CommentSelection, NewCommentRequest } from "../types";
import {
  reconstructReturnEdits,
  reconstructWholeBlockEdit,
} from "./returnEditReconstruct";
import { diffWords } from "./wordDiff";

function sel(
  charStart: number,
  quotedText: string,
  overrides: Partial<CommentSelection> = {},
): CommentSelection {
  return {
    charStart,
    charEnd: charStart + quotedText.length,
    quotedText,
    ...overrides,
  };
}

describe("reconstructWholeBlockEdit", () => {
  it("splices a snippet replacement into a plain paragraph", () => {
    const block = "The plan evaluates each facet against the actual codebase.";
    const out = reconstructWholeBlockEdit(
      block,
      sel(block.indexOf("each facet"), "each facet"),
      { original: "each facet", revised: "every single facet" },
    );
    expect(out).toEqual({
      original: block,
      revised:
        "The plan evaluates every single facet against the actual codebase.",
    });
  });

  it("yields a fine-grained diff, not a whole-paragraph strike", () => {
    const block =
      "Verdict in one line: the codebase survey shows the real gap precisely.";
    const quoted = "the codebase survey sh";
    const out = reconstructWholeBlockEdit(block, sel(block.indexOf(quoted), quoted), {
      original: quoted,
      revised: "the codebase survey shut up!",
    });
    expect(out).not.toBeNull();
    const parts = diffWords(out!.original, out!.revised);
    const struck = parts
      .filter((p) => p.kind === "delete")
      .map((p) => p.text)
      .join("");
    // Only the tail the reviewer touched is struck — the paragraph head
    // ("Verdict in one line: …") stays an equal run.
    expect(parts[0].kind).toBe("equal");
    expect(parts[0].text).toContain("Verdict in one line:");
    expect(struck).not.toContain("Verdict");
  });

  it("preserves surrounding formatting and inherits marks at the range start", () => {
    const block = "Alpha **bold words matter** omega.";
    // textContent: "Alpha bold words matter omega."
    const out = reconstructWholeBlockEdit(block, sel(6, "bold words"), {
      original: "bold words",
      revised: "brave words",
    });
    expect(out).toEqual({
      original: block,
      revised: "Alpha **brave words matter** omega.",
    });
  });

  it("self-heals drifted offsets via quotedText", () => {
    const block = "One two three four five.";
    const out = reconstructWholeBlockEdit(
      block,
      // Stale offsets (block shifted since capture) but the snippet survives.
      { charStart: 2, charEnd: 7, quotedText: "three" },
      { original: "three", revised: "3" },
    );
    expect(out).toEqual({ original: block, revised: "One two 3 four five." });
  });

  it("picks the occurrence nearest charStart when the snippet repeats", () => {
    const block = "xx foo yy foo zz";
    const out = reconstructWholeBlockEdit(
      block,
      // Stale range (slice ≠ quotedText) near the SECOND occurrence.
      { charStart: 9, charEnd: 12, quotedText: "foo" },
      { original: "foo", revised: "bar" },
    );
    expect(out).toEqual({ original: block, revised: "xx foo yy bar zz" });
  });

  it("returns null when the snippet is nowhere in the block", () => {
    const out = reconstructWholeBlockEdit(
      "A completely rewritten paragraph.",
      sel(0, "vanished words"),
      { original: "vanished words", revised: "anything" },
    );
    expect(out).toBeNull();
  });

  it("handles a pure deletion (empty revised)", () => {
    const block = "Keep this drop that keep this too.";
    const out = reconstructWholeBlockEdit(
      block,
      sel(block.indexOf(" drop that"), " drop that"),
      { original: " drop that", revised: "" },
    );
    expect(out).toEqual({
      original: block,
      revised: "Keep this keep this too.",
    });
  });

  it("handles delete-then-add as struck-removed plus inserted-added", () => {
    const block = "The mechanism was wrong and is now struck from scope.";
    const quoted = "wrong and is now struck";
    const out = reconstructWholeBlockEdit(block, sel(block.indexOf(quoted), quoted), {
      original: quoted,
      revised: "right",
    });
    expect(out).toEqual({
      original: block,
      revised: "The mechanism was right from scope.",
    });
    const parts = diffWords(out!.original, out!.revised);
    expect(
      parts.some((p) => p.kind === "delete" && p.text.includes("struck")),
    ).toBe(true);
    expect(
      parts.some((p) => p.kind === "insert" && p.text.includes("right")),
    ).toBe(true);
  });

  it("works on a heading block", () => {
    const block = "## Part 1 — Facet-by-facet evaluation";
    const out = reconstructWholeBlockEdit(block, sel(9, "Facet-by-facet"), {
      original: "Facet-by-facet",
      revised: "Point-by-point",
    });
    expect(out).toEqual({
      original: block,
      revised: "## Part 1 — Point-by-point evaluation",
    });
  });

  it("returns null on a no-op replacement", () => {
    const block = "Nothing changes here.";
    const out = reconstructWholeBlockEdit(block, sel(0, "Nothing"), {
      original: "Nothing",
      revised: "Nothing",
    });
    expect(out).toBeNull();
  });

  it("returns null when the replacement escapes the single-block shape", () => {
    const block = "A paragraph of prose.";
    const out = reconstructWholeBlockEdit(block, sel(2, "paragraph"), {
      original: "paragraph",
      revised: "paragraph\n\nand a second one",
    });
    expect(out).toBeNull();
  });
});

describe("reconstructReturnEdits", () => {
  const block = "The quick brown fox jumps over the lazy dog.";
  const seed = new Map([["blk-1", block]]);

  function editReq(overrides: Partial<NewCommentRequest>): NewCommentRequest {
    return {
      type: "edit",
      anchorId: "A.1.p1",
      blockId: "blk-1",
      body: "",
      ...overrides,
    };
  }

  it("rebuilds a viewer-shaped snippet edit into a whole-block edit", () => {
    const req = editReq({
      edit: { original: "brown fox", revised: "red fox" },
      selection: sel(block.indexOf("brown fox"), "brown fox"),
    });
    const [out] = reconstructReturnEdits([req], seed);
    expect(out.edit).toEqual({
      original: block,
      revised: "The quick red fox jumps over the lazy dog.",
    });
    // Selection is preserved — it keeps driving the highlight.
    expect(out.selection).toEqual(req.selection);
  });

  it("passes an already-whole-block edit through untouched", () => {
    const req = editReq({
      edit: { original: block, revised: "Something else entirely." },
      selection: sel(0, block),
    });
    expect(reconstructReturnEdits([req], seed)[0]).toBe(req);
  });

  it("keeps the raw request when the snippet cannot be located", () => {
    const req = editReq({
      edit: { original: "gone words", revised: "whatever" },
      selection: sel(0, "gone words"),
    });
    expect(reconstructReturnEdits([req], seed)[0]).toBe(req);
  });

  it("ignores non-edit comments and edits without a selection", () => {
    const feedback = editReq({ type: "feedback", body: "what is going on?" });
    const noSelection = editReq({
      edit: { original: "brown fox", revised: "red fox" },
    });
    const out = reconstructReturnEdits([feedback, noSelection], seed);
    expect(out[0]).toBe(feedback);
    expect(out[1]).toBe(noSelection);
  });

  it("keeps the raw request for a block missing from the seed", () => {
    const req = editReq({
      blockId: "blk-unknown",
      edit: { original: "brown fox", revised: "red fox" },
      selection: sel(block.indexOf("brown fox"), "brown fox"),
    });
    expect(reconstructReturnEdits([req], seed)[0]).toBe(req);
  });
});
