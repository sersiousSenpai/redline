// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { drafterExtensions } from "./extensions/drafterExtensions";
import { planDocToMarkdown } from "./markdown/serializer";
import {
  acceptAllUserSuggestions,
  acceptDraftSuggestion,
  acceptUserSuggestion,
  applyDraftSuggestion,
  docIsEmpty,
  hasPendingUserSuggestions,
  rejectAllUserSuggestions,
  rejectDraftSuggestion,
  rejectUserSuggestion,
  suggestionLeaves,
  type DraftSuggestionRow,
} from "./drafterSuggestions";
import { USER_AUTHOR } from "./extensions/TrackChanges";

const editors: Editor[] = [];
function makeEditor(content?: object): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: drafterExtensions(),
    content,
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

function para(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function suggestion(over: Partial<DraftSuggestionRow>): DraftSuggestionRow {
  return {
    id: "sug-1",
    draftId: "d-1",
    op: "append",
    blockId: null,
    original: null,
    markdown: "",
    agentId: "draft-agent",
    body: null,
    status: "pending",
    createdAt: 0,
    ...over,
  };
}

function blockIds(editor: Editor): (string | null)[] {
  const ids: (string | null)[] = [];
  editor.state.doc.forEach((n) => ids.push(n.attrs.blockId ?? null));
  return ids;
}

describe("DraftBlockIds", () => {
  it("mints blk- ids for every top-level block on load and keeps them stable", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("one"), para("two")],
    });
    const ids = blockIds(editor).filter(Boolean) as string[];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(id).toMatch(/^blk-/);
    expect(new Set(ids).size).toBe(ids.length);

    // Editing a block keeps its identity.
    editor.commands.insertContentAt(2, "X");
    const after = blockIds(editor).filter(Boolean) as string[];
    expect(after[0]).toBe(ids[0]);
  });

  it("emits the ids as rl:blk sidecars in the markdown mirror", () => {
    const editor = makeEditor({ type: "doc", content: [para("hello")] });
    const md = planDocToMarkdown(editor.state.doc, { sidecars: true });
    expect(md).toMatch(/<!-- rl:blk-[a-z0-9]+ -->/);
    expect(md).toContain("hello");
  });
});

describe("applyDraftSuggestion", () => {
  it("append into an empty doc applies directly (whole-cloth drafting)", () => {
    const editor = makeEditor();
    expect(docIsEmpty(editor)).toBe(true);
    const outcome = applyDraftSuggestion(
      editor,
      suggestion({ op: "append", markdown: "# Goal\n\nShip auth." }),
    );
    expect(outcome).toBe("applied");
    expect(editor.state.doc.textContent).toContain("Ship auth.");
    // Settled content — no pending marks anywhere.
    let pending = 0;
    editor.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "rl_ins")) pending++;
      return true;
    });
    expect(pending).toBe(0);
  });

  it("append into a non-empty doc lands as pending tracked insertions", () => {
    const editor = makeEditor({ type: "doc", content: [para("existing")] });
    const outcome = applyDraftSuggestion(
      editor,
      suggestion({ op: "append", markdown: "new tail" }),
    );
    expect(outcome).toBe("proposed");
    let marked = "";
    editor.state.doc.descendants((n) => {
      if (
        n.isText &&
        n.marks.some(
          (m) => m.type.name === "rl_ins" && m.attrs.suggestionId === "sug-1",
        )
      ) {
        marked += n.text;
      }
      return true;
    });
    expect(marked).toContain("new tail");
  });

  it("replace_block paints an inline word-diff; reject restores; accept settles", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("keep this old ending")],
    });
    const bid = blockIds(editor)[0]!;
    const s = suggestion({
      op: "replace_block",
      blockId: bid,
      original: "keep this old ending",
      markdown: "keep this new ending",
    });
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    // Both the struck old word and the proposed new word are present.
    expect(editor.state.doc.textContent).toContain("old");
    expect(editor.state.doc.textContent).toContain("new");

    // Reject → back to the original text.
    expect(rejectDraftSuggestion(editor, s)).toBe(true);
    expect(editor.state.doc.textContent.trim()).toBe("keep this old ending");

    // Re-apply and accept → the rewrite settles.
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    expect(acceptDraftSuggestion(editor, s)).toBe(true);
    expect(editor.state.doc.textContent.trim()).toBe("keep this new ending");
  });

  it("delete_block strikes the block; accept removes it", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("first"), para("doomed")],
    });
    const bid = blockIds(editor)[1]!;
    const s = suggestion({ op: "delete_block", blockId: bid, markdown: "" });
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    expect(editor.state.doc.textContent).toContain("doomed");
    expect(acceptDraftSuggestion(editor, s)).toBe(true);
    expect(editor.state.doc.textContent).not.toContain("doomed");
    expect(editor.state.doc.textContent).toContain("first");
  });

  it("a stale blockId reports stale", () => {
    const editor = makeEditor({ type: "doc", content: [para("text")] });
    expect(
      applyDraftSuggestion(
        editor,
        suggestion({ op: "replace_block", blockId: "blk-gone", markdown: "x" }),
      ),
    ).toBe("stale");
  });

  it("suggestionLeaves finds a proposed run (the re-drain guard primitive)", () => {
    const editor = makeEditor({ type: "doc", content: [para("existing")] });
    const s = suggestion({ op: "append", markdown: "new tail" });
    expect(suggestionLeaves(editor, s.id).length).toBe(0);
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    expect(suggestionLeaves(editor, s.id).length).toBeGreaterThan(0);
    expect(suggestionLeaves(editor, "sug-unknown").length).toBe(0);
  });
});

// Text of every leaf carrying `markName`, concatenated.
function markedText(editor: Editor, markName: string): string {
  let out = "";
  editor.state.doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === markName))
      out += n.text ?? "";
    return true;
  });
  return out;
}

describe("Suggesting mode (TrackChangesInput in the drafter)", () => {
  it("starts in Editing: typing stays a plain edit", () => {
    const editor = makeEditor({ type: "doc", content: [para("hello")] });
    editor.commands.insertContentAt(3, "X");
    expect(editor.state.doc.textContent).toBe("heXllo");
    expect(markedText(editor, "rl_ins")).toBe("");
  });

  it("setSuggesting(true) paints typing as a pending USER insertion", () => {
    const editor = makeEditor({ type: "doc", content: [para("hello")] });
    editor.commands.setSuggesting(true);
    editor.commands.insertContentAt(3, "XY");
    const authors = new Set<string>();
    editor.state.doc.descendants((n) => {
      if (!n.isText) return true;
      for (const m of n.marks)
        if (m.type.name === "rl_ins") authors.add(m.attrs.authorId as string);
      return true;
    });
    expect(markedText(editor, "rl_ins")).toBe("XY");
    expect(authors).toEqual(new Set([USER_AUTHOR]));

    // Flip back to Editing: typing is plain again.
    editor.commands.setSuggesting(false);
    editor.commands.insertContentAt(1, "Z");
    expect(markedText(editor, "rl_ins")).toBe("XY");
  });

  it("agent suggestions are NOT repainted as user edits while Suggesting", () => {
    const editor = makeEditor({ type: "doc", content: [para("existing")] });
    editor.commands.setSuggesting(true);
    applyDraftSuggestion(
      editor,
      suggestion({ op: "append", markdown: "tail" }),
    );
    const authors = new Set<string>();
    editor.state.doc.descendants((n) => {
      if (!n.isText) return true;
      for (const m of n.marks)
        if (m.type.name === "rl_ins") authors.add(m.attrs.authorId as string);
      return true;
    });
    expect(authors).toEqual(new Set(["draft-agent"]));
  });

  it("strikeSelection strikes in place even in Editing mode", () => {
    const editor = makeEditor({ type: "doc", content: [para("strike me")] });
    editor.commands.setTextSelection({ from: 1, to: 7 });
    expect(editor.commands.strikeSelection()).toBe(true);
    expect(markedText(editor, "rl_del")).toBe("strike");
    expect(editor.state.doc.textContent).toBe("strike me");
  });

  it("tracked marks attach to inline code (the excludes fix)", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "path/to.ts", marks: [{ type: "code" }] },
          ],
        },
      ],
    });
    editor.commands.setTextSelection({ from: 1, to: 11 });
    expect(editor.commands.strikeSelection()).toBe(true);
    expect(markedText(editor, "rl_del")).toBe("path/to.ts");
    // The code mark survives alongside the strike.
    expect(markedText(editor, "code")).toBe("path/to.ts");
  });
});

describe("user-run Keep/Revert", () => {
  function userRunId(editor: Editor): string {
    let sid: string | null = null;
    editor.state.doc.descendants((n) => {
      if (!n.isText) return true;
      const m = n.marks.find(
        (m) =>
          (m.type.name === "rl_ins" || m.type.name === "rl_del") &&
          m.attrs.suggestionId,
      );
      if (m) sid = m.attrs.suggestionId as string;
      return true;
    });
    if (!sid) throw new Error("no user run in the doc");
    return sid;
  }

  it("Keep settles an insertion to plain text", () => {
    const editor = makeEditor({ type: "doc", content: [para("base")] });
    editor.commands.setSuggesting(true);
    editor.commands.insertContentAt(5, "XX");
    const sid = userRunId(editor);
    expect(acceptUserSuggestion(editor, sid)).toBe(true);
    expect(editor.state.doc.textContent).toBe("baseXX");
    expect(markedText(editor, "rl_ins")).toBe("");
  });

  it("Revert removes an insertion", () => {
    const editor = makeEditor({ type: "doc", content: [para("base")] });
    editor.commands.setSuggesting(true);
    editor.commands.insertContentAt(5, "XX");
    const sid = userRunId(editor);
    expect(rejectUserSuggestion(editor, sid)).toBe(true);
    expect(editor.state.doc.textContent).toBe("base");
  });

  it("Keep really deletes struck text; Revert lifts the strike", () => {
    const editor = makeEditor({ type: "doc", content: [para("strike me")] });
    editor.commands.setSuggesting(true);
    editor.commands.setTextSelection({ from: 1, to: 7 });
    editor.commands.strikeSelection();
    const sid = userRunId(editor);
    expect(rejectUserSuggestion(editor, sid)).toBe(true);
    expect(editor.state.doc.textContent).toBe("strike me");
    expect(markedText(editor, "rl_del")).toBe("");

    editor.commands.setTextSelection({ from: 1, to: 7 });
    editor.commands.strikeSelection();
    expect(acceptUserSuggestion(editor, userRunId(editor))).toBe(true);
    expect(editor.state.doc.textContent).toBe(" me");
  });
});

describe("Keep all / Revert all my changes", () => {
  it("settles every user run at once, leaving agent runs pending", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("alpha"), para("beta")],
    });
    editor.commands.setSuggesting(true);
    editor.commands.insertContentAt(6, "X"); // user run in block 1
    // Block 2 ("beta") now opens at pos 8; its text runs 9..13 — strike "be".
    editor.commands.setTextSelection({ from: 9, to: 11 });
    editor.commands.strikeSelection(); // user strike
    applyDraftSuggestion(
      editor,
      suggestion({ op: "append", markdown: "agent tail" }),
    );
    expect(hasPendingUserSuggestions(editor)).toBe(true);

    expect(acceptAllUserSuggestions(editor)).toBe(true);
    expect(hasPendingUserSuggestions(editor)).toBe(false);
    // User insertion kept plain, user strike really deleted…
    expect(editor.state.doc.textContent).toContain("alphaX");
    expect(editor.state.doc.textContent).toContain("ta"); // "beta" minus "be"
    expect(editor.state.doc.textContent).not.toContain("beta");
    // …while the agent's proposal is still pending.
    expect(markedText(editor, "rl_ins")).toContain("agent tail");
  });

  it("reverts every user run at once", () => {
    const editor = makeEditor({ type: "doc", content: [para("alpha")] });
    editor.commands.setSuggesting(true);
    editor.commands.insertContentAt(6, "XYZ");
    editor.commands.setTextSelection({ from: 1, to: 3 });
    editor.commands.strikeSelection();
    expect(rejectAllUserSuggestions(editor)).toBe(true);
    expect(editor.state.doc.textContent).toBe("alpha");
    expect(hasPendingUserSuggestions(editor)).toBe(false);
  });

  it("no-ops on a clean document", () => {
    const editor = makeEditor({ type: "doc", content: [para("alpha")] });
    expect(hasPendingUserSuggestions(editor)).toBe(false);
    expect(acceptAllUserSuggestions(editor)).toBe(false);
    expect(rejectAllUserSuggestions(editor)).toBe(false);
  });
});

describe("block locking (pending agent suggestion)", () => {
  it("filters user edits in a locked block but lets verdicts through", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("locked content")],
    });
    const bid = blockIds(editor)[0]!;
    const s = suggestion({
      op: "replace_block",
      blockId: bid,
      original: "locked content",
      markdown: "agent rewrite",
    });
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    editor.commands.setLockedBlocks([bid]);

    const before = editor.state.doc.textContent;
    editor.commands.insertContentAt(2, "Z");
    expect(editor.state.doc.textContent).toBe(before);

    // The verdict is a derived write (rl-sync) — the lock lets it through.
    expect(acceptDraftSuggestion(editor, s)).toBe(true);
    expect(editor.state.doc.textContent.trim()).toBe("agent rewrite");
  });
});

// One emptiness predicate, shared with the launch gate.
//
// They disagreed, and the disagreement destroyed documents: `canSend` asked
// `editor.isEmpty` (a horizontal rule, a table, a heading with no words all
// count as content) while `docIsEmpty` asked `textContent.trim()` (all of those
// counted as empty). So an agent `append` into a structure-only document took
// the wholesale `setContent` branch and REPLACED it, reporting "applied" with
// no Accept/Reject card.
describe("docIsEmpty agrees with the launch gate", () => {
  it("an append into a structure-only doc PROPOSES rather than replacing", () => {
    const editor = makeEditor({
      type: "doc",
      content: [{ type: "horizontalRule" }, { type: "paragraph" }],
    });
    // The document has no text, but it is not empty — you can send it.
    expect(editor.state.doc.textContent.trim()).toBe("");
    expect(editor.isEmpty).toBe(false);
    expect(docIsEmpty(editor)).toBe(false);

    const before = editor.state.doc.childCount;
    const outcome = applyDraftSuggestion(
      editor,
      suggestion({ op: "append", markdown: "# Goal\n\nShip auth." }),
    );
    // A tracked insert with a card, not a wholesale replacement.
    expect(outcome).toBe("proposed");
    expect(editor.state.doc.childCount).toBeGreaterThan(before);
    // The structure that was there is still there.
    let rules = 0;
    editor.state.doc.forEach((n) => {
      if (n.type.name === "horizontalRule") rules++;
    });
    expect(rules, "the existing document was replaced").toBe(1);
    // ...and it arrived as a PENDING insert, so it can be rejected.
    let pending = 0;
    editor.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "rl_ins")) pending++;
      return true;
    });
    expect(pending).toBeGreaterThan(0);
  });

  it("a genuinely blank doc still takes the direct-apply path", () => {
    // The behaviour worth keeping: a first agent write into a blank document
    // shouldn't arrive as a review queue.
    const editor = makeEditor();
    expect(docIsEmpty(editor)).toBe(true);
    expect(
      applyDraftSuggestion(
        editor,
        suggestion({ op: "append", markdown: "Ship auth." }),
      ),
    ).toBe("applied");
  });

  it("whitespace-only is still empty — a stray space is not content", () => {
    const editor = makeEditor({ type: "doc", content: [para("   ")] });
    expect(docIsEmpty(editor)).toBe(editor.isEmpty);
  });
});
