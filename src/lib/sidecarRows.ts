// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ThreadMessage } from "../types";

/** A turn from the quick chat beside a comment's report. Everything else —
 *  every row from before the Chat view included — is the report's. */
export function isChatRow(m: ThreadMessage): boolean {
  return m.mode === "chat";
}

/** The mode a reply files under: its question's, the latest user row. The
 *  backend stamps the persisted reply the same way, so a locally appended
 *  reply and its persisted twin always agree. */
export function askedMode(rows: readonly ThreadMessage[]): ThreadMessage["mode"] {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === "user") return rows[i].mode;
  }
  return undefined;
}

/** One line of the report view: a report row, or one run of chat turns folded
 *  into a chip. */
export type ReportItem =
  | { kind: "row"; msg: ThreadMessage }
  | { kind: "chat"; key: string; count: number; last: boolean };

/** The report view's lines. Each run of consecutive chat rows becomes one
 *  chip counting its messages; `last` marks a run that ends the thread, which
 *  is the one a write-up can follow. */
export function reportItems(rows: readonly ThreadMessage[]): ReportItem[] {
  const items: ReportItem[] = [];
  for (const m of rows) {
    const prev = items[items.length - 1];
    if (!isChatRow(m)) items.push({ kind: "row", msg: m });
    else if (prev?.kind === "chat") prev.count += 1;
    else items.push({ kind: "chat", key: m.id, count: 1, last: false });
  }
  const tail = items[items.length - 1];
  if (tail?.kind === "chat") tail.last = true;
  return items;
}
