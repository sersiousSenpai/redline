// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useMemo, useState } from "react";

import type { DiffFile } from "../types";
import { displayPath } from "../lib/flattenDiff";
import { buildReviewTree, type ReviewTreeNode } from "../lib/reviewTree";

// Changed-files sidebar for the review pane: a collapsed-chain tree
// (`reviewTree.ts`) whose file rows carry the reviewer's working state —
// status letter, +/- counts, annotation badge, viewed check, and per-file
// search hits when a query is active. Click = jump the diff to that file.

interface ReviewFileTreeProps {
  files: DiffFile[];
  viewed: ReadonlySet<string>;
  /** Live annotation count per display path. */
  annotationCounts: ReadonlyMap<string, number>;
  /** Per-file match counts while a search is active (null = no search). */
  searchCounts: ReadonlyMap<string, number> | null;
  /** Paths currently hidden by the hide-viewed filter — rendered dimmed. */
  hiddenPaths: ReadonlySet<string>;
  onJump: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
}

const STATUS_LETTER: Record<DiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  binary: "B",
};

export default function ReviewFileTree({
  files,
  viewed,
  annotationCounts,
  searchCounts,
  hiddenPaths,
  onJump,
  onToggleViewed,
}: ReviewFileTreeProps) {
  const tree = useMemo(() => buildReviewTree(files), [files]);
  const stats = useMemo(() => {
    const m = new Map<string, { adds: number; dels: number }>();
    for (const f of files) {
      let adds = 0;
      let dels = 0;
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.kind === "add") adds++;
          else if (l.kind === "del") dels++;
        }
      }
      m.set(displayPath(f), { adds, dels });
    }
    return m;
  }, [files]);

  return (
    <nav
      className="rl-review-tree"
      aria-label="Changed files"
      style={{
        width: 240,
        flexShrink: 0,
        overflowY: "auto",
        borderRight: "1px solid var(--color-rule)",
        padding: "4px 0",
        fontSize: "12px",
      }}
    >
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          viewed={viewed}
          annotationCounts={annotationCounts}
          searchCounts={searchCounts}
          hiddenPaths={hiddenPaths}
          stats={stats}
          onJump={onJump}
          onToggleViewed={onToggleViewed}
        />
      ))}
    </nav>
  );
}

const TreeNode = memo(function TreeNode({
  node,
  depth,
  viewed,
  annotationCounts,
  searchCounts,
  hiddenPaths,
  stats,
  onJump,
  onToggleViewed,
}: {
  node: ReviewTreeNode;
  depth: number;
  viewed: ReadonlySet<string>;
  annotationCounts: ReadonlyMap<string, number>;
  searchCounts: ReadonlyMap<string, number> | null;
  hiddenPaths: ReadonlySet<string>;
  stats: ReadonlyMap<string, { adds: number; dels: number }>;
  onJump: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const indent = 8 + depth * 14;

  if (!node.file) {
    return (
      <div>
        <div
          className="rl-tree-row"
          role="button"
          tabIndex={0}
          style={{ paddingLeft: indent, cursor: "pointer", color: "var(--color-ink-muted)" }}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
        >
          <span style={{ width: 12, display: "inline-block" }}>{open ? "▾" : "▸"}</span>
          {node.name}
        </div>
        {open &&
          node.children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              viewed={viewed}
              annotationCounts={annotationCounts}
              searchCounts={searchCounts}
              hiddenPaths={hiddenPaths}
              stats={stats}
              onJump={onJump}
              onToggleViewed={onToggleViewed}
            />
          ))}
      </div>
    );
  }

  const path = node.path;
  const isViewed = viewed.has(path);
  const hidden = hiddenPaths.has(path);
  const anns = annotationCounts.get(path) ?? 0;
  const hits = searchCounts?.get(path) ?? 0;
  const st = stats.get(path);
  return (
    <div
      className="rl-tree-row"
      role="button"
      tabIndex={0}
      title={hidden ? `${path} — hidden by Hide viewed` : path}
      style={{
        paddingLeft: indent + 12,
        cursor: hidden ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        opacity: hidden || isViewed ? 0.55 : 1,
      }}
      onClick={() => {
        if (!hidden) onJump(path);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !hidden) {
          e.preventDefault();
          onJump(path);
        }
      }}
    >
      <span
        className="rl-review-pin-status"
        data-status={node.file.status}
        style={{ width: 12, flexShrink: 0 }}
      >
        {STATUS_LETTER[node.file.status]}
      </span>
      <span className="truncate" style={{ minWidth: 0, flex: 1 }}>
        {node.name}
      </span>
      {searchCounts && hits > 0 && (
        <span className="rl-tree-badge" data-kind="search">
          {hits}
        </span>
      )}
      {anns > 0 && (
        <span className="rl-tree-badge" data-kind="ann">
          💬{anns}
        </span>
      )}
      {st && (st.adds > 0 || st.dels > 0) && (
        <span style={{ flexShrink: 0, fontSize: "10.5px", fontFamily: "var(--font-mono, monospace)" }}>
          <span style={{ color: "var(--color-success)" }}>+{st.adds}</span>{" "}
          <span style={{ color: "var(--color-warning)" }}>−{st.dels}</span>
        </span>
      )}
      <span
        role="checkbox"
        aria-checked={isViewed}
        aria-label={`Mark ${node.name} viewed`}
        tabIndex={-1}
        style={{
          flexShrink: 0,
          width: 14,
          textAlign: "center",
          color: isViewed ? "var(--color-success)" : "var(--color-ink-muted)",
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleViewed(path);
        }}
      >
        {isViewed ? "✓" : "○"}
      </span>
    </div>
  );
});
