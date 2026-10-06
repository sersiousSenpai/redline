// SPDX-License-Identifier: Apache-2.0
// A purpose-built hunk view for the git client: monospace, line numbers, +/-
// tint, optional word diff, and (in File status) per-hunk Stage / Unstage /
// Discard plus click / shift-click line selection for the same actions on lines.
import { memo, useMemo, useState } from "react";
import { pairHunkLines, wordDiff, type WordSpan } from "../../lib/wordDiff";
import { lineKey } from "../../lib/git/patch";
import type { GitArea, GitDiffFile, GitDiffHunk } from "../../lib/git/types";

export type HunkAction = "stage" | "unstage" | "discard";

export interface HunkDiffActions {
  area: GitArea;
  busy?: boolean;
  /** Apply `action` to the selected line keys of `hunk` (all changes when whole hunk). */
  onApply: (action: HunkAction, keys: Set<string>) => void;
}

/** Render cap per file; the rest renders on request. */
const LINE_CAP = 2500;

interface Selection {
  hunk: number;
  keys: Set<string>;
  anchor: number;
}

function HunkDiffImpl({ file, actions, wordDiffOn }: { file: GitDiffFile; actions?: HunkDiffActions; wordDiffOn?: boolean }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [showAll, setShowAll] = useState(false);
  const total = useMemo(() => file.hunks.reduce((n, h) => n + h.lines.length, 0), [file]);

  if (file.binary) return <div className="rl-git-diff-note">Binary file — no text diff.</div>;
  if (file.hunks.length === 0) return <div className="rl-git-diff-note">No content changes{file.status === "renamed" ? " (rename only)" : ""}.</div>;

  const select = (hunkIndex: number, lineIndex: number, event: React.MouseEvent) => {
    const hunk = file.hunks[hunkIndex];
    if (hunk.lines[lineIndex].kind === "context") return;
    const key = lineKey(hunkIndex, lineIndex);
    setSelection((current) => {
      const same = current && current.hunk === hunkIndex;
      if (event.shiftKey && same) {
        const [from, to] = [Math.min(current.anchor, lineIndex), Math.max(current.anchor, lineIndex)];
        const keys = new Set<string>();
        for (let i = from; i <= to; i++) if (hunk.lines[i].kind !== "context") keys.add(lineKey(hunkIndex, i));
        return { hunk: hunkIndex, keys, anchor: current.anchor };
      }
      if ((event.metaKey || event.ctrlKey) && same) {
        const keys = new Set(current.keys);
        if (keys.has(key)) keys.delete(key);
        else keys.add(key);
        return keys.size ? { hunk: hunkIndex, keys, anchor: lineIndex } : null;
      }
      if (same && current.keys.size === 1 && current.keys.has(key)) return null;
      return { hunk: hunkIndex, keys: new Set([key]), anchor: lineIndex };
    });
  };

  let budget = showAll ? Infinity : LINE_CAP;
  return (
    <div className="rl-git-diff" data-selectable={actions ? "" : undefined}>
      {file.hunks.map((hunk, hunkIndex) => {
        if (budget <= 0) return null;
        const visible = Math.min(hunk.lines.length, budget);
        budget -= visible;
        const picked = selection?.hunk === hunkIndex ? selection.keys : null;
        return (
          <Hunk
            key={hunkIndex}
            hunk={hunk}
            hunkIndex={hunkIndex}
            visible={visible}
            picked={picked}
            actions={actions}
            wordDiffOn={!!wordDiffOn}
            onLine={select}
            onApply={(action) => {
              if (!actions) return;
              const keys = picked && picked.size ? picked : new Set(hunk.lines.flatMap((l, i) => (l.kind === "context" ? [] : [lineKey(hunkIndex, i)])));
              setSelection(null);
              actions.onApply(action, keys);
            }}
          />
        );
      })}
      {!showAll && total > LINE_CAP && (
        <button type="button" className="rl-git-btn rl-git-diff-more" onClick={() => setShowAll(true)}>
          Render the remaining {(total - LINE_CAP).toLocaleString()} lines
        </button>
      )}
    </div>
  );
}

export const HunkDiff = memo(HunkDiffImpl);

function Hunk({
  hunk,
  hunkIndex,
  visible,
  picked,
  actions,
  wordDiffOn,
  onLine,
  onApply,
}: {
  hunk: GitDiffHunk;
  hunkIndex: number;
  visible: number;
  picked: Set<string> | null;
  actions?: HunkDiffActions;
  wordDiffOn: boolean;
  onLine: (hunk: number, line: number, event: React.MouseEvent) => void;
  onApply: (action: HunkAction) => void;
}) {
  const words = useMemo(() => {
    if (!wordDiffOn) return null;
    const pairs = pairHunkLines(hunk);
    const spans = new Map<number, WordSpan[]>();
    pairs.forEach((partner, index) => {
      if (hunk.lines[index].kind !== "del") return;
      const result = wordDiff(hunk.lines[index].text, hunk.lines[partner].text);
      spans.set(index, result.del);
      spans.set(partner, result.add);
    });
    return spans;
  }, [hunk, wordDiffOn]);
  const lines = picked && picked.size > 0;
  const noun = lines ? (picked.size === 1 ? "line" : "lines") : "hunk";
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);
  return (
    <section className="rl-git-hunk" aria-label={`Hunk ${hunkIndex + 1}`}>
      <div className="rl-git-hunk-head">
        <code>
          @@ -{range(hunk.oldStart, hunk.oldLines)} +{range(hunk.newStart, hunk.newLines)} @@
          {hunk.header && <span> {hunk.header}</span>}
        </code>
        {actions && (
          <span className="rl-git-hunk-actions">
            {lines && <span className="rl-git-hunk-count">{picked.size} selected</span>}
            {actions.area === "unstaged" ? (
              <>
                <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={actions.busy} onClick={() => onApply("discard")}>
                  Discard {noun}
                </button>
                <button type="button" className="rl-git-btn rl-git-btn-sm rl-git-btn-primary" disabled={actions.busy} onClick={() => onApply("stage")}>
                  Stage {noun}
                </button>
              </>
            ) : (
              <button type="button" className="rl-git-btn rl-git-btn-sm" disabled={actions.busy} onClick={() => onApply("unstage")}>
                Unstage {noun}
              </button>
            )}
          </span>
        )}
      </div>
      {hunk.lines.slice(0, visible).map((line, lineIndex) => {
        const selected = picked?.has(lineKey(hunkIndex, lineIndex));
        const spans = words?.get(lineIndex);
        return (
          <div
            key={lineIndex}
            className="rl-git-line"
            data-kind={line.kind}
            data-selected={selected ? "" : undefined}
            onMouseDown={actions ? (event) => {
              if (event.button !== 0) return;
              if (event.shiftKey) event.preventDefault();
              onLine(hunkIndex, lineIndex, event);
            } : undefined}
          >
            <span className="rl-git-ln">{line.oldLine ?? ""}</span>
            <span className="rl-git-ln">{line.newLine ?? ""}</span>
            <span className="rl-git-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
            <span className="rl-git-code">
              {spans
                ? spans.map((span, i) => (span.changed ? <mark key={i}>{span.text}</mark> : span.text))
                : line.text || "​"}
              {line.noNewline && <span className="rl-git-noeol" title="No newline at end of file" aria-label="No newline at end of file">⊘</span>}
            </span>
          </div>
        );
      })}
    </section>
  );
}
