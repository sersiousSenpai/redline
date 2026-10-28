// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What the workbench is showing, as the keys an alert names its news by
// (lib/attentionAlerts): the session on screen (`plan:<id>`, `launch:<id>`)
// and every pane in its active tab — a wall's tiles and an Agent pane as
// `term:<id>`, a plan as `plan:<id>`, a chat room as `chat:<id>`. Home is
// no session: a Home terminal is on screen only on a wall that is.

import { HOME_KEY, visiblePaneIds, type WorkbenchState } from "./model";

export function visibleTargets(state: WorkbenchState): string[] {
  const out: string[] = [];
  const key = state.activeKey;
  if (key !== HOME_KEY) out.push(key);
  const set = state.sets[key];
  if (!set) return out;
  for (const id of visiblePaneIds(set)) {
    const pane = set.panes[id];
    if (!pane) continue;
    if (pane.kind === "terminals") for (const tile of pane.data.tiles) out.push(`term:${tile}`);
    else if (pane.kind === "plan") out.push(`plan:${pane.data.sessionId}`);
    else if (pane.kind === "chat") {
      if (pane.data.source === "companion") out.push(`chat:${pane.data.companionId}`);
      else {
        out.push(`term:${pane.data.terminalId}`);
        if (pane.data.sessionId) out.push(`plan:${pane.data.sessionId}`);
      }
    }
  }
  return [...new Set(out)];
}

/** A store selector: the same string while the same things are on screen,
 *  so a subscriber re-renders only when they change. */
export function visibleTargetsKey(state: WorkbenchState): string {
  return visibleTargets(state).sort().join("\n");
}
