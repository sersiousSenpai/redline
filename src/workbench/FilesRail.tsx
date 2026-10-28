// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The rail's Files tab (W4): the project tree rooted at the session's
// folder — on Home, a root picker over the folders that are open — with git
// badges from `git_gui_status`, file-type icons, and the preview / pin /
// ⌘-click-tab opens of `FileTree`. Mounted only while the tab is shown, so
// its status reads stop the moment another tab is.

import { memo, useMemo } from "react";
import { Search } from "lucide-react";

import { FileTree, type FileOpenMode } from "../components/FileTree";
import { treeGitStatus, useRepoStatus } from "./useRepoStatus";
import "./rail.css";

export interface FilesRailProps {
  /** The tree's root: the session's project, or the root picked on Home. */
  root: string | null;
  /** Home's picker: the open folders. Absent on a session's rail. */
  roots?: readonly string[];
  onPickRoot?: (path: string) => void;
  activeFile: string | null;
  onOpenFile: (path: string, mode: FileOpenMode) => void;
  /** ⌘P over this root. */
  onQuickOpen: () => void;
}

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

function FilesRailBase({ root, roots, onPickRoot, activeFile, onOpenFile, onQuickOpen }: FilesRailProps) {
  const { status } = useRepoStatus(root);
  const git = useMemo(() => (root ? treeGitStatus(root, status) : null), [root, status]);
  const changed = git?.files.size ?? 0;
  return (
    <>
      <div className="rl-rail-head">
        {roots && roots.length > 1 && onPickRoot ? (
          <select
            className="rl-rail-root-pick"
            aria-label="Folder"
            value={root ?? ""}
            onChange={(e) => onPickRoot(e.target.value)}
            title={root ?? undefined}
          >
            {roots.map((r) => (
              <option key={r} value={r}>
                {base(r)}
              </option>
            ))}
          </select>
        ) : (
          <span className="truncate" style={{ fontWeight: 600, color: "var(--color-ink)" }} title={root ?? undefined}>
            {root ? base(root) : "Files"}
          </span>
        )}
        {changed > 0 && <span style={{ color: "var(--color-ink-muted)" }}>{changed} changed</span>}
        <span className="rl-rail-spacer" />
        {root && (
          <button type="button" className="rl-rail-icon" title="Go to file (⌘P)" aria-label="Go to file" onClick={onQuickOpen}>
            <Search size={14} aria-hidden />
          </button>
        )}
      </div>
      <div className="rl-rail-scroll rl-thin-scroll-y" style={{ padding: "4px 6px" }}>
        {root ? (
          <FileTree key={root} root={root} activeFile={activeFile} onOpenFile={(path, mode) => onOpenFile(path, mode ?? "preview")} git={git} />
        ) : (
          <div className="rl-rail-empty">
            No project folder here yet. Open a terminal in a project, or pick a plan session, and its files show up here.
          </div>
        )}
      </div>
    </>
  );
}

export const FilesRail = memo(FilesRailBase);
export default FilesRail;
