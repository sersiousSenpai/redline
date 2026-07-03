// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiffFile } from "../types";
import type { HlToken } from "../lib/composeSpans";
import { displayPath, hunkSideText } from "../lib/flattenDiff";

/** Per-file diff highlight: `segs[hunkIndex*2]` = old-side token rows,
 *  `segs[hunkIndex*2 + 1]` = new-side (matching `hunkSideText` order), each
 *  parallel to that side's lines. `"plain"` = no grammar / over cap / failed —
 *  final state, never re-requested. */
export type FileHighlight = HlToken[][][] | "plain";

/** Mirrors highlight.rs `MAX_DIFF_HIGHLIGHT_LINES` so an over-cap file never
 *  even ships its segments over IPC. */
const MAX_DIFF_HIGHLIGHT_LINES = 5_000;

/** How long the viewport must rest on a file before we ask for colors —
 *  fly-by files during a fast scroll are never requested. */
const REQUEST_DEBOUNCE_MS = 150;

/**
 * Cost-∝-visible syntax highlighting for the review diff: a file is tokenized
 * (once, content-cached in Rust) the first time it rests in the viewport.
 * Plaintext renders first in all cases — colors arrive by state update.
 */
export function useDiffHighlight(
  files: DiffFile[] | null,
  visiblePaths: readonly string[],
): Map<string, FileHighlight> {
  const [map, setMap] = useState<Map<string, FileHighlight>>(new Map());
  const pending = useRef<Set<string>>(new Set());
  // Bumped per diff snapshot: a response landing after the diff changed is
  // for stale content and must be dropped.
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current++;
    pending.current.clear();
    setMap(new Map());
  }, [files]);

  useEffect(() => {
    if (!files || visiblePaths.length === 0) return;
    const gen = genRef.current;
    const t = window.setTimeout(() => {
      for (const path of visiblePaths) {
        if (map.has(path) || pending.current.has(path)) continue;
        const file = files.find((f) => displayPath(f) === path);
        if (!file || file.binary) continue;
        const totalLines = file.hunks.reduce((s, h) => s + h.lines.length, 0);
        if (totalLines > MAX_DIFF_HIGHLIGHT_LINES) {
          setMap((m) => new Map(m).set(path, "plain"));
          continue;
        }
        const segments = file.hunks.flatMap((h) => [
          hunkSideText(h, "old"),
          hunkSideText(h, "new"),
        ]);
        pending.current.add(path);
        void invoke<HlToken[][][] | null>("highlight_diff", {
          req: { path, segments },
        })
          .then((res) => {
            if (genRef.current !== gen) return;
            setMap((m) => new Map(m).set(path, res ?? "plain"));
          })
          .catch(() => {
            if (genRef.current !== gen) return;
            setMap((m) => new Map(m).set(path, "plain"));
          })
          .finally(() => pending.current.delete(path));
      }
    }, REQUEST_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [files, visiblePaths, map]);

  return map;
}
