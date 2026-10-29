// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Adopted terminals that are hidden attach one per idle frame (PTY helper
// plan §4). A launch that adopts fourteen kept terminals would otherwise land
// fourteen replays (up to 256 KB each) in one task; spike 3 measured a
// 3.6–4 MB show-time drain as exactly the cost to avoid. A visible terminal,
// and any terminal that wasn't just adopted, attaches at once.

type Idle = (cb: () => void, opts?: { timeout: number }) => number;

const queue: (() => void)[] = [];
let scheduled = false;
/** Terminals a launch just adopted, until each has attached. */
const adopted = new Set<string>();

export function markAdopted(ids: Iterable<string>): void {
  for (const id of ids) adopted.add(id);
}

function next(): void {
  const idle = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback;
  const run = () => {
    scheduled = false;
    const job = queue.shift();
    job?.();
    if (queue.length) schedule();
  };
  if (idle) idle(run, { timeout: 100 });
  else setTimeout(run, 16);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  next();
}

/** Run `attach` now, unless its terminal was just adopted and its view is
 *  hidden: then in the idle queue. */
export function scheduleAttach(id: string, visible: boolean, attach: () => void): void {
  const staggered = adopted.delete(id);
  if (visible || !staggered) {
    attach();
    return;
  }
  queue.push(attach);
  schedule();
}

/** For tests: how many hidden attaches are waiting. */
export function pendingAttaches(): number {
  return queue.length;
}
