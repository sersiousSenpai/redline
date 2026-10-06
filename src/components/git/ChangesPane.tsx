// SPDX-License-Identifier: Apache-2.0
// Read-only changed-files list + diff, shared by the commit detail and stashes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePersistedState } from "../../theme/usePersistedState";
import type { GitDiffFile } from "../../lib/git/types";
import { HunkDiff } from "./HunkDiff";
import { FileRow, codeForDiffStatus } from "./FileRow";

const pathOf = (file: GitDiffFile) => (file.newPath !== "/dev/null" ? file.newPath : file.oldPath);

export function ChangesPane({ files, header, error, label }: { files: GitDiffFile[] | null; header: ReactNode; error?: string | null; label: string }) {
  const [index, setIndex] = useState(0);
  const [wordDiffOn, setWordDiffOn] = usePersistedState("redline.git.wordDiff", false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setIndex(0), [files]);
  const file = files?.[index] ?? null;
  const id = (i: number) => `rl-git-changes-${i}`;
  useEffect(() => {
    document.getElementById(id(index))?.scrollIntoView?.({ block: "nearest" });
  }, [index]);
  return (
    <div className="rl-git-changes">
      <div className="rl-git-changes-side">
        <div className="rl-git-changes-meta">{header}</div>
        <div
          ref={listRef}
          className="rl-git-list-body"
          role="listbox"
          aria-label={label}
          tabIndex={0}
          aria-activedescendant={file ? id(index) : undefined}
          onKeyDown={(event) => {
            if (!files?.length) return;
            const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? files.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            setIndex(Math.max(0, Math.min(files.length - 1, next)));
          }}
        >
          {error ? (
            <div className="rl-git-list-empty rl-git-error">{error}</div>
          ) : files === null ? (
            <div className="rl-git-list-empty">Loading…</div>
          ) : files.length === 0 ? (
            <div className="rl-git-list-empty">No file changes</div>
          ) : (
            files.map((f, i) => (
              <FileRow
                key={`${pathOf(f)}:${i}`}
                id={id(i)}
                entry={{ path: pathOf(f), oldPath: f.status === "renamed" ? f.oldPath : undefined, status: codeForDiffStatus(f.status) }}
                selected={i === index}
                onClick={() => {
                  setIndex(i);
                  listRef.current?.focus();
                }}
              />
            ))
          )}
        </div>
      </div>
      <div className="rl-git-diffpane">
        {file && (
          <div className="rl-git-pane-head">
            <span className="rl-git-pane-path" title={pathOf(file)}>
              {file.status === "renamed" && <span className="rl-git-muted">{file.oldPath} → </span>}
              {pathOf(file)}
            </span>
            <label className="rl-git-toggle">
              <input type="checkbox" checked={wordDiffOn} onChange={(e) => setWordDiffOn(e.target.checked)} /> Word diff
            </label>
          </div>
        )}
        <div className="rl-git-diff-scroll">{file && <HunkDiff key={`${pathOf(file)}:${index}`} file={file} wordDiffOn={wordDiffOn} />}</div>
      </div>
    </div>
  );
}
