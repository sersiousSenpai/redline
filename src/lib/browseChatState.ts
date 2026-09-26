// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Visibility belongs to the whole browser panel; each durable tab remembers
// its page/Cart choice. Legacy saved pills are normalized on read.
export type ChatPill = "page" | "cart" | "mission";

export interface ChatEntry {
  open: boolean;
  pill: ChatPill;
  /** Last write, for the prune below. */
  at: number;
}

export const CHAT_CLOSED: ChatEntry = { open: false, pill: "page", at: 0 };

export type ChatStateMap = Record<string, ChatEntry>;

/** How many closed-tab entries to keep. Small — this is UI memory for tabs that
 *  no longer exist in the open workspace, not a history. */
export const KEEP_IDLE = 32;

/** Keep the map bounded without ever forgetting a tab that still exists.
 *
 *  The obvious rule — drop everything not in the current tab list — is wrong
 *  here for exactly the reason this module exists. `tabs` is only the CURRENT
 *  workspace: entering a research mission swaps in that mission's tabs, so the
 *  naive prune would evict every regular tab's memory and coming back would
 *  land on a closed panel — the same round-trip amnesia, one level down.
 *
 *  So: live tabs are always kept, and everything else is kept by recency up to
 *  a cap. Bounded for the life of the install either way, which is the point;
 *  `SnapshotCache` (lib.rs) prunes for the same reason. */
export function pruneChatState(
  state: ChatStateMap,
  liveBrowseIds: string[],
  keepIdle = KEEP_IDLE,
): ChatStateMap {
  const live = new Set(["$panel", ...liveBrowseIds]);
  const entries = Object.entries(state);
  const idle = entries.filter(([id]) => !live.has(id));
  if (idle.length <= keepIdle) return state; // identity → no needless persist

  const keep = new Set(
    idle
      .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
      .slice(0, keepIdle)
      .map(([id]) => id),
  );
  const next: ChatStateMap = {};
  for (const [id, entry] of entries) {
    if (live.has(id) || keep.has(id)) next[id] = entry;
  }
  return next;
}

/** New tabs inherit panel visibility and start on their own page chat. */
export function chatEntryFor(
  state: ChatStateMap,
  browseId: string | null | undefined,
): ChatEntry {
  const entry = (browseId ? state[browseId] : undefined) ?? CHAT_CLOSED;
  const latest = state.$panel ?? Object.values(state).reduce((a, b) => b.at > a.at ? b : a, CHAT_CLOSED);
  return { ...entry, open: latest.open, pill: migrateChatPill(entry.pill) };
}

/** Apply a patch to one tab's entry, returning the map unchanged when nothing
 *  moved — `usePersistedState` writes to localStorage on every new object, so
 *  identity here is what keeps a no-op click from touching the disk. */
export function withChatPatch(
  state: ChatStateMap,
  browseId: string,
  patch: Partial<Omit<ChatEntry, "at">>,
  now: number,
): ChatStateMap {
  const cur = chatEntryFor(state, browseId);
  const next: ChatEntry = { ...(cur ?? CHAT_CLOSED), ...patch, at: now };
  if (cur && cur.open === next.open && cur.pill === next.pill) return state;
  return { ...state, [browseId]: next, ...(patch.open === undefined ? {} : { $panel: { open: patch.open, pill: "page" as const, at: now } }) };
}

/** Serializable dock identities. BrowserPane owns and portals the panels. */
export interface BrowserDockState {
  /** The tab whose conversation the pane is showing — usually the active tab,
   *  but pinned to its origin when an agent opened the visible tab. */
  browseId: string | null;
  title: string | null;
  /** The active tab's remembered pill, so the dock can lead with it. */
  pill: ChatPill;
  cartId: string;
  missionId: string | null;
  missionTitle: string | null;
}

export { NO_BROWSER_DOCK } from "./conversationContext";

export function migrateChatPill(pill: unknown): ChatPill {
  return pill === "list" || pill === "cart" ? "cart" : pill === "mission" ? "mission" : "page";
}

export interface LinkedConversation { browseId: string; title: string; originTabId: string }
export function pageChatIdentity(tab: { browseId: string }, activeId: string, linked: LinkedConversation | null) {
  return { browseId: linked?.browseId ?? tab.browseId, label: `browser-${activeId}` };
}

/** Shortcut origin must belong to this workspace. */
export function shortcutTabId(ids: string[], origin: string, direction: "next-tab" | "previous-tab"): string | null {
  const i = ids.indexOf(origin);
  return i < 0 ? null : ids[(i + (direction === "next-tab" ? 1 : ids.length - 1)) % ids.length] ?? null;
}
