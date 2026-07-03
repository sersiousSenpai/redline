// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Changed-files tree for the review sidebar: a trie over the diff's display
//! paths with single-child directory chains collapsed (`a/b/c` reads as one
//! node). Pure and DOM-free; the component only renders what this returns.

import type { DiffFile } from "../types";
import { displayPath } from "./flattenDiff";

export interface ReviewTreeNode {
  /** Display name — a collapsed chain renders as "a/b/c". */
  name: string;
  /** Full path prefix for directories; the file's display path for leaves. */
  path: string;
  children: ReviewTreeNode[];
  /** Present on leaves. */
  file?: DiffFile;
}

/** Build the sidebar tree: trie → collapse single-child dir chains → sort
 *  (directories first, then files, both alphabetical). */
export function buildReviewTree(files: DiffFile[]): ReviewTreeNode[] {
  const root: ReviewTreeNode = { name: "", path: "", children: [] };

  for (const file of files) {
    const path = displayPath(file);
    const parts = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i];
      const childPath = node.path ? `${node.path}/${name}` : name;
      if (isLeaf) {
        node.children.push({ name, path, children: [], file });
      } else {
        let child = node.children.find((c) => !c.file && c.name === name);
        if (!child) {
          child = { name, path: childPath, children: [] };
          node.children.push(child);
        }
        node = child;
      }
    }
  }

  collapseChains(root);
  sortTree(root);
  return root.children;
}

/** Merge a directory with its sole directory child ("a" + "b" → "a/b"). */
function collapseChains(node: ReviewTreeNode): void {
  for (const child of node.children) collapseChains(child);
  node.children = node.children.map((child) => {
    let c = child;
    while (!c.file && c.children.length === 1 && !c.children[0].file) {
      const only = c.children[0];
      c = { ...only, name: `${c.name}/${only.name}` };
    }
    return c;
  });
}

function sortTree(node: ReviewTreeNode): void {
  node.children.sort((a, b) => {
    const aDir = !a.file;
    const bDir = !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}
