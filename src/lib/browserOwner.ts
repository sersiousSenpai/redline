// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The per-session browser (W5, D17, spike 2): one workspace for every
// session, filtered by owner. Swapping the browser's `workspaceKey` per
// session tears every native webview down (about a second, the pages' JS
// state lost), so a session switch never swaps it. Instead each page
// remembers the session it was opened in (`owner`, a workbench session key:
// `plan:<id>` or `launch:<id>`), and a session's browser pane shows its own
// pages first: the rail groups them "This session" / "Other sessions". Home
// owns nothing and shows every page in the strip's own order. Suspension,
// mosaics and missions are untouched: the filter is the rail's reading.

/** A page's owner as stored: a plan or launch session key. Home is no owner. */
export function isOwnerKey(value: unknown): value is string {
  return typeof value === "string" && /^(plan|launch):[A-Za-z0-9_.:-]{1,200}$/.test(value);
}

/** The owner a page opened now takes: the session on screen, or none. */
export function ownerFor(sessionKey: string | null | undefined): string | undefined {
  return isOwnerKey(sessionKey) ? sessionKey : undefined;
}

export interface OwnerGroups<T> {
  here: T[];
  others: T[];
}

/** The pages split for a session's pane: its own, then everyone else's,
 *  each in the strip's order. Null when there is nothing to split by — Home
 *  (no owner), or a session with no page of another session's. */
export function groupByOwner<T extends { owner?: string }>(tabs: readonly T[], owner: string | null | undefined): OwnerGroups<T> | null {
  if (!isOwnerKey(owner)) return null;
  const here: T[] = [];
  const others: T[] = [];
  for (const tab of tabs) (tab.owner === owner ? here : others).push(tab);
  return others.length ? { here, others } : null;
}
