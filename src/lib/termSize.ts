// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** A proposed terminal geometry (what FitAddon.proposeDimensions returns). */
export interface TermSize {
  cols: number;
  rows: number;
}

/** True when a proposed terminal geometry is worth applying. FitAddon floors
 *  a squished host at 2 cols × 1 row — which passes a `> 0` check but
 *  corrupts a full-screen TUI (claude) the moment the PTY hears about it.
 *  Undefined means the host had no usable geometry at all. */
export function isUsableTermSize(
  dims: TermSize | null | undefined,
): dims is TermSize {
  return !!dims && dims.cols > 2 && dims.rows > 1;
}

export const RESIZE_SETTLE_MS = 100;

export interface ResizeScheduler {
  /** Queue a size for the PTY. `immediate` sends now (single-shot paths like
   *  tab-shown / window-focus); otherwise a trailing debounce collapses a
   *  divider-drag storm into one send at rest. Either way the send is skipped
   *  when the size is unusable or identical to the last one sent. */
  schedule(size: TermSize, immediate: boolean): void;
  /** Drop any pending debounced send (unmount). */
  cancel(): void;
}

/** Debounced, deduped PTY-resize scheduler — one per terminal. Extracted pure
 *  so the storm behavior is unit-testable with fake timers. */
export function createResizeScheduler(
  send: (size: TermSize) => void,
  settleMs: number = RESIZE_SETTLE_MS,
): ResizeScheduler {
  let lastSent: TermSize | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const flush = (size: TermSize) => {
    if (!isUsableTermSize(size)) return;
    if (lastSent && lastSent.cols === size.cols && lastSent.rows === size.rows)
      return;
    lastSent = size;
    send(size);
  };

  return {
    schedule(size: TermSize, immediate: boolean) {
      clear();
      if (immediate) {
        flush(size);
      } else {
        timer = setTimeout(() => {
          timer = null;
          flush(size);
        }, settleMs);
      }
    },
    cancel: clear,
  };
}
