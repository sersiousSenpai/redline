// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildChangeSet } from "../changeLedger";
import { serializeBlocks, serializeDocBlocks } from "../docModel";
import { planExtensions } from "../extensions/planExtensions";
import { planMarkdownToDoc, planDocToMarkdown } from "../markdown";
import { isPlanYDocSeeded, seedPlanYDocIfEmpty } from "./planYDoc";

/**
 * M2 gates, headless: the Y.Doc binding must be invisible to the document
 * model — identical serialization (no phantom edits), persisted-copy-wins
 * reconciliation, Collaboration undo that still respects `addToHistory:
 * false`, and crash-recovery rehydration feeding the changeLedger.
 */

const editors: Editor[] = [];
function makeYEditor(ydoc: Y.Doc): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: planExtensions({ document: ydoc }),
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

const PLAN = [
  "<!-- rl:blk-aaaa1111 -->",
  "# Title",
  "",
  "<!-- rl:blk-bbbb2222 -->",
  "Original body paragraph.",
  "",
].join("\n");

const anchors = new Map([
  ["blk-aaaa1111", "A"],
  ["blk-bbbb2222", "A.p1"],
]);

/** End-of-text position inside the block with the given id. */
function endOfBlock(editor: Editor, blockId: string): number {
  let pos = -1;
  editor.state.doc.forEach((node, p) => {
    if (node.attrs?.blockId === blockId) pos = p + node.nodeSize - 1;
  });
  expect(pos).toBeGreaterThan(0);
  return pos;
}

describe("plan Y.Doc substrate", () => {
  it("a seeded Y.Doc bound to the editor reproduces the parse exactly (no phantom edits)", () => {
    const ydoc = new Y.Doc();
    expect(seedPlanYDocIfEmpty(ydoc, PLAN)).toBe(true);
    const editor = makeYEditor(ydoc);

    const headless = planMarkdownToDoc(PLAN);
    expect(editor.state.doc.toJSON()).toEqual(headless.toJSON());
    // Byte-identical markdown out of the bound editor → export adapters and
    // md sync see exactly what the non-CRDT editor produced.
    expect(planDocToMarkdown(editor.state.doc)).toBe(
      planDocToMarkdown(headless),
    );
    // And the headless baseline equals what onCreate used to capture.
    expect(serializeBlocks(editor, anchors)).toEqual(
      serializeDocBlocks(headless, anchors),
    );
  });

  it("seeding is guarded: a non-empty (persisted) doc wins and is never re-seeded", () => {
    const ydoc = new Y.Doc();
    expect(isPlanYDocSeeded(ydoc)).toBe(false);
    expect(seedPlanYDocIfEmpty(ydoc, PLAN)).toBe(true);
    expect(isPlanYDocSeeded(ydoc)).toBe(true);

    const before = Y.encodeStateAsUpdate(ydoc);
    expect(seedPlanYDocIfEmpty(ydoc, PLAN)).toBe(false);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
  });

  it("undo (Collaboration history) reverts user edits", () => {
    const ydoc = new Y.Doc();
    seedPlanYDocIfEmpty(ydoc, PLAN);
    const editor = makeYEditor(ydoc);

    editor.commands.insertContentAt(
      endOfBlock(editor, "blk-bbbb2222"),
      " USER",
    );
    expect(editor.state.doc.textContent).toContain("USER");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).not.toContain("USER");
  });

  it("undo skips addToHistory:false transactions (reconcile writes stay put)", () => {
    const ydoc = new Y.Doc();
    seedPlanYDocIfEmpty(ydoc, PLAN);
    const editor = makeYEditor(ydoc);

    // A programmatic write, tagged exactly like applyAnchorIds/reconcile.
    const tr = editor.state.tr.insertText(
      " PROG",
      endOfBlock(editor, "blk-bbbb2222"),
    );
    tr.setMeta("rl-sync", true);
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);

    // Then a genuine user edit on top.
    editor.commands.insertContentAt(
      endOfBlock(editor, "blk-bbbb2222"),
      " USER",
    );

    editor.commands.undo();
    const text = editor.state.doc.textContent;
    expect(text).not.toContain("USER"); // user edit reverted…
    expect(text).toContain("PROG"); // …derived write untouched

    // Nothing user-made left to undo — the programmatic write never entered
    // the undo stack, so further undos must not strip it either.
    editor.commands.undo();
    expect(editor.state.doc.textContent).toContain("PROG");
  });

  it("crash recovery: a rehydrated Y.Doc carries uncommitted edits the ledger can re-derive", () => {
    // Session A: seed, edit, "crash" — the persisted bytes are all that's left.
    const ydocA = new Y.Doc();
    seedPlanYDocIfEmpty(ydocA, PLAN);
    const editorA = makeYEditor(ydocA);
    editorA.commands.insertContentAt(
      endOfBlock(editorA, "blk-bbbb2222"),
      " UNCOMMITTED",
    );
    const persisted = Y.encodeStateAsUpdate(ydocA);

    // Relaunch: same revision → restore wins, no re-seed.
    const ydocB = new Y.Doc();
    Y.applyUpdate(ydocB, persisted);
    expect(seedPlanYDocIfEmpty(ydocB, PLAN)).toBe(false);
    const editorB = makeYEditor(ydocB);

    const current = serializeBlocks(editorB, anchors);
    expect(
      current.find((b) => b.blockId === "blk-bbbb2222")?.markdown,
    ).toContain("UNCOMMITTED");

    // Diffed against the clean headless baseline, the recovered edit comes
    // out as a change set — the flush then re-creates its comment, which is
    // the crash-recovery round-trip PlanEditor performs on mount.
    const base = serializeDocBlocks(planMarkdownToDoc(PLAN), anchors);
    const changes = buildChangeSet(base, current);
    expect(changes.some((c) => c.blockId === "blk-bbbb2222")).toBe(true);
  });

  it("a newer revision seeds fresh — stale content never leaks across keys", () => {
    // The revision bump gives the editor a brand-new Y.Doc (new key); the
    // old doc's edits must not appear in it.
    const REVISED = PLAN.replace("Original body paragraph.", "Revised body.");
    const ydoc = new Y.Doc();
    expect(seedPlanYDocIfEmpty(ydoc, REVISED)).toBe(true);
    const editor = makeYEditor(ydoc);
    expect(editor.state.doc.textContent).toContain("Revised body.");
    expect(editor.state.doc.textContent).not.toContain("Original");
  });
});
