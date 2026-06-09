// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { DirEntry } from "../types";
import { subscribeFsChange } from "../hooks/useFsWatch";
import { preloadCodeView } from "./FileViewer";

interface FileTreeProps {
  /** Absolute path of the folder this tree is rooted at. */
  root: string;
  /** Absolute path of the file currently open in the viewer, for highlight. */
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

// A VSCode-style file explorer rooted at one project folder. Each directory
// lazy-loads its children the first time it's expanded (one `list_dir` per
// level), so opening a huge repo never walks the whole tree up front.
export function FileTree({ root, activeFile, onOpenFile }: FileTreeProps) {
  // Warm the code-viewer chunk the moment the explorer is shown, so the first
  // file click never waits on the JS chunk (which would stack a Suspense flash
  // on top of CodeView's own loader — the "double flash").
  useEffect(() => preloadCodeView(), []);

  return (
    <div className="py-1" style={{ fontSize: "13px" }}>
      <DirChildren
        path={root}
        depth={0}
        activeFile={activeFile}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

interface DirChildrenProps {
  path: string;
  depth: number;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

// Lists and renders the immediate children of one directory. Owns the fetch so
// each expanded directory loads independently and caches its own result.
function DirChildren({ path, depth, activeFile, onOpenFile }: DirChildrenProps) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reload this directory's listing. Used both on first expand and whenever the
  // filesystem watcher reports a change here. A refresh (unlike the initial
  // load) keeps the current entries on screen instead of flashing the "…"
  // placeholder, and silently ignores a now-unreadable dir.
  const load = useCallback(
    (refresh: boolean) => {
      let cancelled = false;
      if (!refresh) {
        setEntries(null);
        setError(null);
      }
      void (async () => {
        try {
          const list = await invoke<DirEntry[]>("list_dir", { path });
          if (!cancelled) {
            setEntries(list);
            setError(null);
          }
        } catch (e) {
          if (!cancelled && !refresh) setError(String(e));
        }
      })();
      return () => {
        cancelled = true;
      };
    },
    [path],
  );

  // Initial load when this level is expanded.
  useEffect(() => load(false), [load]);

  // Watch this directory for the lifetime of the node and re-list it live when
  // anything inside changes (file created/deleted/renamed in a terminal, etc.).
  useEffect(() => {
    void invoke("watch_dir", { path }).catch(() => {});
    const unsubscribe = subscribeFsChange(path, () => load(true));
    return () => {
      unsubscribe();
      void invoke("unwatch_dir", { path }).catch(() => {});
    };
  }, [path, load]);

  if (error) {
    return <Indented depth={depth} muted italic>can’t read folder</Indented>;
  }
  if (entries === null) {
    return <Indented depth={depth} muted>…</Indented>;
  }
  if (entries.length === 0) {
    return <Indented depth={depth} muted italic>empty</Indented>;
  }
  return (
    <>
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

function TreeNode({ entry, depth, activeFile, onOpenFile }: TreeNodeProps) {
  const [open, setOpen] = useState(false);
  const isActive = !entry.isDir && entry.path === activeFile;

  const indent = 8 + depth * 14;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => (entry.isDir ? setOpen((o) => !o) : onOpenFile(entry.path))}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            entry.isDir ? setOpen((o) => !o) : onOpenFile(entry.path);
          }
        }}
        title={entry.name}
        className="flex items-center gap-1 cursor-pointer rl-tree-row"
        style={{
          paddingLeft: `${indent}px`,
          paddingRight: "8px",
          paddingTop: "2px",
          paddingBottom: "2px",
          background: isActive ? "var(--color-bg-elevated)" : "transparent",
          color: isActive ? "var(--color-ink)" : "var(--color-ink-muted)",
        }}
      >
        <span
          style={{
            width: "12px",
            flexShrink: 0,
            fontSize: "9px",
            color: "var(--color-ink-muted)",
            visibility: entry.isDir ? "visible" : "hidden",
          }}
        >
          {open ? "▼" : "▶"}
        </span>
        <span className="truncate">{entry.name}</span>
      </div>
      {entry.isDir && open && (
        <DirChildren
          path={entry.path}
          depth={depth + 1}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
        />
      )}
    </>
  );
}

interface IndentedProps {
  depth: number;
  muted?: boolean;
  italic?: boolean;
  children: React.ReactNode;
}

function Indented({ depth, muted, italic, children }: IndentedProps) {
  return (
    <div
      style={{
        paddingLeft: `${8 + depth * 14 + 13}px`,
        paddingTop: "2px",
        paddingBottom: "2px",
        fontSize: "12px",
        fontStyle: italic ? "italic" : undefined,
        color: muted ? "var(--color-ink-muted)" : "var(--color-ink)",
      }}
    >
      {children}
    </div>
  );
}
