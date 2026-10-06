// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Build a `git apply` patch from a selection of diff lines.
//!
//! The repository view stages, unstages and discards single hunks or single
//! lines by handing `git_gui_apply_patch` a patch cut from the displayed diff:
//!
//! - "stage" (worktree -> index, applied forward): an unselected `+` line is
//!   dropped and an unselected `-` line becomes context.
//! - "reverse" (unstage, discard; applied with `-R`): an unselected `-` line is
//!   dropped and an unselected `+` line becomes context.
//!
//! The patch is always written in the diff's own orientation (old -> new); the
//! caller passes `reverse` to the command for the second mode. Hunk headers keep
//! the original starts and carry recomputed counts (the backend also passes
//! `--recount`). "\ No newline at end of file" markers survive: the side being
//! matched against the target keeps git's original markers, and the side being
//! produced only ends without a newline when its final line did originally.
import type { GitDiffFile, GitDiffLine } from "./types";

export type PatchMode = "stage" | "reverse";

const NO_EOL = "\\ No newline at end of file";
const DEV_NULL = "/dev/null";

/** Selection key for line `line` of hunk `hunk`. */
export function lineKey(hunk: number, line: number): string {
  return `${hunk}:${line}`;
}

/** Every changed (`+`/`-`) line of one hunk: the selection a hunk button uses. */
export function hunkSelection(file: GitDiffFile, hunk: number): Set<string> {
  const keys = new Set<string>();
  file.hunks[hunk]?.lines.forEach((line, index) => {
    if (line.kind !== "context") keys.add(lineKey(hunk, index));
  });
  return keys;
}

/** Every changed line of the file. */
export function fileSelection(file: GitDiffFile): Set<string> {
  const keys = new Set<string>();
  file.hunks.forEach((_, index) => hunkSelection(file, index).forEach((key) => keys.add(key)));
  return keys;
}

interface Row {
  text: string;
  old: boolean;
  new: boolean;
  /** The source line carried a "\ No newline" marker. */
  noEol: boolean;
}

/** C-style quoting, the way git writes a path it cannot print bare. */
function quoteName(name: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x1f"\\\x7f]|[^\x00-\x7f]/.test(name)) return name;
  const bytes = new TextEncoder().encode(name);
  let out = '"';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (char === '"' || char === "\\") out += "\\" + char;
    else if (byte === 7) out += "\\a";
    else if (byte === 8) out += "\\b";
    else if (byte === 9) out += "\\t";
    else if (byte === 10) out += "\\n";
    else if (byte === 11) out += "\\v";
    else if (byte === 12) out += "\\f";
    else if (byte === 13) out += "\\r";
    else if (byte < 0x20 || byte >= 0x7f) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += char;
  }
  return out + '"';
}

/** A `---`/`+++` name; git appends a TAB when a bare name contains a space. */
function sideName(prefix: string, path: string | null): string {
  if (path === null) return DEV_NULL;
  const quoted = quoteName(prefix + path);
  return quoted.startsWith('"') || !path.includes(" ") ? quoted : `${quoted}\t`;
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Keep the original start. git writes an empty range as the line BEFORE it,
 *  so a side that empties moves back one and a side that was empty and gained
 *  lines moves forward one. */
function fixStart(start: number, count: number, originalCount: number): number {
  if (count === 0 && originalCount > 0) return Math.max(0, start - 1);
  if (count > 0 && originalCount === 0) return start + 1;
  return start;
}

/**
 * Build the patch for `selected` (keys from {@link lineKey}) over `file`.
 * Returns null when the selection contains no change to apply, or the file is
 * binary. Context lines in the selection are ignored.
 */
export function buildPatch(
  file: GitDiffFile,
  selected: ReadonlySet<string>,
  mode: PatchMode,
): string | null {
  if (file.binary) return null;
  const stage = mode === "stage";
  const path = file.newPath !== DEV_NULL ? file.newPath : file.oldPath;
  const wasNew = file.status === "added" || file.oldPath === DEV_NULL;
  const wasDeleted = file.status === "deleted" || file.newPath === DEV_NULL;
  const hunks: string[] = [];
  let oldEmpty = true;
  let newEmpty = true;

  file.hunks.forEach((hunk, hunkIndex) => {
    const rows: Row[] = [];
    let changed = false;
    hunk.lines.forEach((line: GitDiffLine, lineIndex) => {
      const picked = selected.has(lineKey(hunkIndex, lineIndex));
      const noEol = !!line.noNewline;
      if (line.kind === "context") {
        rows.push({ text: line.text, old: true, new: true, noEol });
      } else if (line.kind === "del") {
        if (picked) {
          rows.push({ text: line.text, old: true, new: false, noEol });
          changed = true;
        } else if (stage) {
          rows.push({ text: line.text, old: true, new: true, noEol });
        }
      } else if (picked) {
        rows.push({ text: line.text, old: false, new: true, noEol });
        changed = true;
      } else if (!stage) {
        rows.push({ text: line.text, old: true, new: true, noEol });
      }
    });
    if (!changed) return;

    // The preimage side (old when staging, new when reversing) is matched
    // against the target, so it keeps git's markers verbatim. The postimage
    // side lacks a final newline only on its last line, and only when that
    // line lacked one originally.
    let lastOld = -1;
    let lastNew = -1;
    rows.forEach((row, index) => {
      if (row.old) lastOld = index;
      if (row.new) lastNew = index;
    });
    const out: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    rows.forEach((row, index) => {
      const oldNoEol = row.old && row.noEol && (stage || index === lastOld);
      const newNoEol = row.new && row.noEol && (!stage || index === lastNew);
      if (row.old) oldCount++;
      if (row.new) newCount++;
      if (row.old && row.new && oldNoEol === newNoEol) {
        out.push(` ${row.text}`);
        if (oldNoEol) out.push(NO_EOL);
        return;
      }
      if (row.old) {
        out.push(`-${row.text}`);
        if (oldNoEol) out.push(NO_EOL);
      }
      if (row.new) {
        out.push(`+${row.text}`);
        if (newNoEol) out.push(NO_EOL);
      }
    });
    if (oldCount > 0) oldEmpty = false;
    if (newCount > 0) newEmpty = false;
    const oldStart = fixStart(hunk.oldStart, oldCount, hunk.oldLines);
    const newStart = fixStart(hunk.newStart, newCount, hunk.newLines);
    const trailer = hunk.header ? ` ${hunk.header}` : "";
    hunks.push(
      `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${trailer}\n${out.join("\n")}\n`,
    );
  });
  if (hunks.length === 0) return null;

  // A creation stays a creation only while the old side stays empty, and a
  // deletion only while the new side does; otherwise the cut is a modification.
  const creates = wasNew && oldEmpty;
  const deletes = wasDeleted && newEmpty;
  const header = [`diff --git ${quoteName(`a/${path}`)} ${quoteName(`b/${path}`)}`];
  if (creates) header.push("new file mode 100644");
  if (deletes) header.push("deleted file mode 100644");
  header.push(`--- ${sideName("a/", creates ? null : path)}`);
  header.push(`+++ ${sideName("b/", deletes ? null : path)}`);
  return `${header.join("\n")}\n${hunks.join("")}`;
}
