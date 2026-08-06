// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  buildFolderTree,
  draftLabel,
  draftsInFolder,
  type BookshelfDraft,
  type BookshelfFolder,
} from "./bookshelf";

const folder = (
  folderId: string,
  parentId: string | null,
  name = folderId,
): BookshelfFolder => ({ folderId, parentId, name, createdAt: 0 });

const draft = (
  draftId: string,
  folderId: string | null,
  over: Partial<BookshelfDraft> = {},
): BookshelfDraft => ({
  draftId,
  title: draftId,
  projectPath: null,
  folderId,
  createdAt: 0,
  updatedAt: 0,
  sourceCount: 0,
  hasDoc: true,
  isTemplate: false,
  openCount: 0,
  lastOpenedAt: null,
  ...over,
});

describe("buildFolderTree", () => {
  it("nests children under their parent and sorts by name", () => {
    const tree = buildFolderTree([
      folder("b", null, "Beta"),
      folder("a", null, "Alpha"),
      folder("a1", "a", "Nested"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["Alpha", "Beta"]);
    expect(tree[0].children.map((n) => n.folderId)).toEqual(["a1"]);
  });

  it("re-hangs an orphan at the root instead of dropping it", () => {
    // A row whose parent was deleted must stay visible and fixable — silently
    // missing from the shelf is the failure mode worth guarding.
    const tree = buildFolderTree([folder("x", "gone")]);
    expect(tree.map((n) => n.folderId)).toEqual(["x"]);
  });

  it("surfaces a cycle rather than looping or hiding it", () => {
    const tree = buildFolderTree([folder("a", "b"), folder("b", "a")]);
    const ids = tree.map((n) => n.folderId).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("treats a self-parented folder as a root", () => {
    const tree = buildFolderTree([folder("a", "a")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(0);
  });
});

describe("draftsInFolder", () => {
  it("splits documents between the shelf root and a folder", () => {
    const drafts = [draft("d1", null), draft("d2", "f1"), draft("d3", "f1")];
    expect(draftsInFolder(drafts, null).map((d) => d.draftId)).toEqual(["d1"]);
    expect(draftsInFolder(drafts, "f1").map((d) => d.draftId)).toEqual([
      "d2",
      "d3",
    ]);
  });

  it("sorts templates ahead of ordinary documents, keeping recency within", () => {
    // Backend order is updated_at DESC; ★ rises without reshuffling the rest.
    const drafts = [
      draft("recent", "f1"),
      draft("tpl-b", "f1", { isTemplate: true }),
      draft("older", "f1"),
      draft("tpl-a", "f1", { isTemplate: true }),
    ];
    expect(draftsInFolder(drafts, "f1").map((d) => d.draftId)).toEqual([
      "tpl-b",
      "tpl-a",
      "recent",
      "older",
    ]);
  });
});

describe("draftLabel", () => {
  it("falls back to a placeholder for a blank or missing title", () => {
    expect(draftLabel(draft("d", null, { title: "  " }))).toBe(
      "Untitled document",
    );
    expect(draftLabel(draft("d", null, { title: null }))).toBe(
      "Untitled document",
    );
    expect(draftLabel(draft("d", null, { title: "Spec" }))).toBe("Spec");
  });
});
