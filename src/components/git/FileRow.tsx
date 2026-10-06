// SPDX-License-Identifier: Apache-2.0
import type { DiffFileStatus } from "../../types";
import type { FileCode, GitFileEntry } from "../../lib/git/types";

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const CODE_TITLE: Record<FileCode, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  "?": "Untracked",
  U: "Conflicted",
};

const DIFF_CODE: Record<DiffFileStatus, FileCode> = { added: "A", modified: "M", deleted: "D", renamed: "R", binary: "M" };
export const codeForDiffStatus = (status: DiffFileStatus): FileCode => DIFF_CODE[status];

export function StatusBadge({ code }: { code: FileCode }) {
  return (
    <span className="rl-git-badge" data-code={code === "?" ? "untracked" : code} title={CODE_TITLE[code]}>
      {code === "?" ? "?" : code}
    </span>
  );
}

export function FileRow({
  id,
  entry,
  selected,
  checkbox,
  onClick,
  onContextMenu,
}: {
  id?: string;
  entry: GitFileEntry;
  selected: boolean;
  checkbox?: { checked: boolean; label: string; disabled?: boolean; onChange: () => void };
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const dir = dirName(entry.path);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className="rl-git-file"
      title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
      onClick={(event) => {
        if (!(event.target instanceof HTMLInputElement)) onClick();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu?.(event);
      }}
    >
      {checkbox && (
        <input
          type="checkbox"
          tabIndex={-1}
          aria-label={checkbox.label}
          checked={checkbox.checked}
          disabled={checkbox.disabled}
          onChange={checkbox.onChange}
        />
      )}
      <StatusBadge code={entry.status} />
      <span className="rl-git-file-name">{fileName(entry.path)}</span>
      {dir && <span className="rl-git-file-dir">{dir}</span>}
    </div>
  );
}
