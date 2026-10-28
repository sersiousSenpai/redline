// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useCallback, useEffect, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode,
  FileCog,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  Image,
  Lock,
  Package,
  Palette,
  SquareCode,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

import type { DirEntry } from "../types";
import type { FileCode as GitCode } from "../lib/git/types";
import { fileIconKind, type FileIconKind } from "../lib/fileIcons";
import { subscribeFsChange } from "../hooks/useFsWatch";
import { preloadCodeView } from "./codeViewWarm";

/** How a row asks for its file: a plain click previews, a second click on
 *  the shown row (or a double-click) pins, ⌘-click opens a tab. */
export type FileOpenMode = "preview" | "pin" | "tab";

/** The tree's view of git: each changed file's code, keyed by absolute
 *  path, and every folder that holds one. */
export interface TreeGitStatus {
  files: ReadonlyMap<string, GitCode>;
  dirs: ReadonlySet<string>;
}

interface FileTreeProps {
  /** Absolute path of the folder this tree is rooted at. */
  root: string;
  /** Absolute path of the file currently open in the viewer, for highlight. */
  activeFile: string | null;
  onOpenFile: (path: string, mode?: FileOpenMode) => void;
  onPlanHere?: (path: string) => void;
  /** Git badges (the Files rail); absent, rows carry none. */
  git?: TreeGitStatus | null;
}

const ICON: Record<FileIconKind, LucideIcon> = {
  code: FileCode,
  test: FlaskConical,
  style: Palette,
  markup: SquareCode,
  data: Database,
  markdown: BookOpen,
  image: Image,
  package: Package,
  lock: Lock,
  config: FileCog,
  shell: SquareTerminal,
  text: FileText,
};

/** Badge tone per git code: amber for changed, green for added, muted for
 *  the rest. The palette has no red, so a deletion is muted too. */
function badgeTone(code: GitCode): string {
  if (code === "A") return "var(--color-success)";
  if (code === "M" || code === "R" || code === "T" || code === "U" || code === "C") return "var(--color-warning-text, var(--color-warning))";
  return "var(--color-ink-muted)";
}

// A VSCode-style file explorer rooted at one project folder. Each directory
// lazy-loads its children the first time it's expanded (one `list_dir` per
// level), so opening a huge repo never walks the whole tree up front.
function FileTreeBase({ root, activeFile, onOpenFile, onPlanHere, git = null }: FileTreeProps) {
  // Warm the code-viewer chunk the moment the explorer is shown, so the first
  // file click never waits on the JS chunk (which would stack a Suspense flash
  // on top of CodeView's own loader — the "double flash").
  useEffect(() => preloadCodeView(), []);

  return (
    <div className="py-1" style={{ fontSize: "13px" }}>
      {onPlanHere && <button type="button" className="rl-menu-item w-full text-left px-3 py-2" onClick={() => onPlanHere(root)}>＋ Plan here</button>}
      <DirChildren
        path={root}
        depth={0}
        activeFile={activeFile}
        onOpenFile={onOpenFile}
        git={git}
      />
    </div>
  );
}

interface DirChildrenProps {
  path: string;
  depth: number;
  activeFile: string | null;
  onOpenFile: (path: string, mode?: FileOpenMode) => void;
  git: TreeGitStatus | null;
}

// Lists and renders the immediate children of one directory. Owns the fetch so
// each expanded directory loads independently and caches its own result.
function DirChildren({ path, depth, activeFile, onOpenFile, git }: DirChildrenProps) {
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
          git={git}
        />
      ))}
    </>
  );
}

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  activeFile: string | null;
  onOpenFile: (path: string, mode?: FileOpenMode) => void;
  git: TreeGitStatus | null;
}

function TreeNode({ entry, depth, activeFile, onOpenFile, git }: TreeNodeProps) {
  const [open, setOpen] = useState(false);
  const isActive = !entry.isDir && entry.path === activeFile;
  const code = entry.isDir ? undefined : git?.files.get(entry.path);
  const dirChanged = entry.isDir && !!git?.dirs.has(entry.path);

  const indent = 8 + depth * 14;
  const Icon = entry.isDir ? (open ? FolderOpen : Folder) : ICON[fileIconKind(entry.name)];
  const Chevron = open ? ChevronDown : ChevronRight;
  const activate = (event: MouseEvent | null) => {
    if (entry.isDir) return setOpen((o) => !o);
    // ⌘-click: a tab of its own. A second click on the shown row, or a
    // double-click (its second click), pins the preview.
    const mode: FileOpenMode = event?.metaKey ? "tab" : (event && event.detail >= 2) || isActive ? "pin" : "preview";
    onOpenFile(entry.path, mode);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => activate(e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (entry.isDir) setOpen((o) => !o);
            else onOpenFile(entry.path, e.metaKey ? "tab" : "pin");
          }
        }}
        title={code ? `${entry.name} · ${code === "?" ? "untracked" : code}` : entry.name}
        data-active={isActive ? "" : undefined}
        className="flex items-center gap-1.5 cursor-pointer rl-tree-row rl-file-row"
        style={{
          height: "24px",
          paddingLeft: `${indent}px`,
          paddingRight: "8px",
          borderRadius: "5px",
          background: isActive ? "var(--color-bg-elevated)" : "transparent",
          color: isActive ? "var(--color-ink)" : "var(--color-ink-muted)",
        }}
      >
        <span style={{ width: "12px", flexShrink: 0, display: "grid", placeItems: "center", visibility: entry.isDir ? "visible" : "hidden" }}>
          <Chevron size={12} aria-hidden />
        </span>
        <Icon size={16} aria-hidden style={{ flexShrink: 0, opacity: 0.85 }} />
        <span className="truncate" style={{ flex: 1, minWidth: 0, color: code === "D" ? "var(--color-ink-muted)" : undefined, textDecoration: code === "D" ? "line-through" : undefined }}>
          {entry.name}
        </span>
        {code && (
          <span className="font-mono" aria-label={`git ${code}`} style={{ fontSize: "11px", fontWeight: 600, color: badgeTone(code) }}>
            {code}
          </span>
        )}
        {dirChanged && !open && (
          <span aria-label="holds changes" style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--color-warning)", flexShrink: 0 }} />
        )}
      </div>
      {entry.isDir && open && (
        <DirChildren
          path={entry.path}
          depth={depth + 1}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
          git={git}
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

/** Memoized: the tree reconciles every open folder, and a sidebar drag
 *  changes only its width. */
export const FileTree = memo(FileTreeBase);
