// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Pure helpers for the virtualized file viewer. Kept dependency-free and
//! side-effect-free so the windowing math is unit-testable without a DOM.

export interface Range {
  start: number;
  end: number;
}

/** The line index range to render for a scroll position, padded by `overscan`
 *  lines on each side. `[start, end)`; clamped to `[0, lineCount]`. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  lineCount: number,
  lineHeight: number,
  overscan: number,
): Range {
  if (lineCount <= 0 || viewportHeight <= 0 || lineHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const first = Math.floor(scrollTop / lineHeight);
  const visible = Math.ceil(viewportHeight / lineHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(lineCount, first + visible + overscan);
  return { start, end };
}

/** Chunk indices covering the half-open line range `[start, end)` at the given
 *  chunk size. Empty when the range is empty. */
export function chunksForRange(
  start: number,
  end: number,
  chunkSize: number,
): number[] {
  if (end <= start || chunkSize <= 0) return [];
  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.floor((end - 1) / chunkSize);
  const out: number[] = [];
  for (let c = firstChunk; c <= lastChunk; c++) out.push(c);
  return out;
}
