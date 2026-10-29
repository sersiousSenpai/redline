// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The app's half of terminals that outlive it (PTY helper plan §4). Loaded
// lazily from App: nothing here is on the boot path.
//
// - `syncKeptMeta`: every live terminal's placement (its owner in the
//   workbench, its session, its name) goes to the helper with `pty_set_meta`
//   whenever it changes, so a relaunch can put it back where it was.
// - `adoptedBinds`: on a launch that adopted kept terminals, which sessions
//   they run, so the session ↔ terminal map and the conversation mirror are
//   seeded before any hook fires again (the CLI that kept running already
//   sent its SessionStart to the Redline that quit).

import { invoke } from "@tauri-apps/api/core";

import { parseKeptMeta, type KeptMeta, type LivePty } from "./terminalWorkspace";

export interface MetaRow {
  id: string;
  meta: KeptMeta;
}

/** What was last written per terminal, so an unchanged placement costs
 *  nothing. A terminal the helper doesn't hold ignores the write. */
const sent = new Map<string, string>();

export function syncKeptMeta(rows: readonly MetaRow[], write: (id: string, meta: KeptMeta) => Promise<unknown> = (id, meta) => invoke("pty_set_meta", { id, meta })): number {
  let writes = 0;
  const live = new Set(rows.map((r) => r.id));
  for (const id of [...sent.keys()]) if (!live.has(id)) sent.delete(id);
  for (const { id, meta } of rows) {
    const clean = parseKeptMeta(meta) ?? {};
    const key = JSON.stringify(clean);
    if (sent.get(id) === key) continue;
    sent.set(id, key);
    writes++;
    void write(id, clean).catch(() => sent.delete(id));
  }
  return writes;
}

/** For tests. */
export function resetKeptMeta(): void {
  sent.clear();
}

/** The `{sessionId, terminalId}` pairs a launch's adopted terminals carry. */
export function adoptedBinds(list: readonly LivePty[]): { sessionId: string; terminalId: string }[] {
  const out: { sessionId: string; terminalId: string }[] = [];
  for (const pty of list) {
    if (!pty.kept || !pty.alive) continue;
    const sessionId = parseKeptMeta(pty.meta)?.sessionId;
    if (sessionId) out.push({ sessionId, terminalId: pty.id });
  }
  return out;
}
