// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The browser chat panel's memory, per tab.
//
// It used to be a plain `useState` pair in `BrowserPane` — and `BrowserPane` is
// unmounted whenever the main surface changes (App mounts it only while
// `mainSurface === "browser"`) and re-parented on every document-pin toggle. So
// a round-trip to Code Review closed the chat, every time, with no way to say
// "leave it as I had it".
//
// The key is `browseId`, the tab's DURABLE id: it survives the tab-id re-mint
// that a reload and a mission restore both perform, so the panel reopens on the
// tab the user actually left it open on rather than on whatever tab inherited
// its slot.

/** Which discussion the split shows. `list` is the fourth pill — a tab's
 *  working list, which is not a conversation at all. */
export type ChatPill = "page" | "mission" | "linked" | "list";

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
  const live = new Set(liveBrowseIds);
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

/** Read a tab's panel state. The default is closed-on-page: a tab that has
 *  never had the chat open opens without one, which is the deliberate behavior
 *  change here — switching to such a tab now CLOSES the panel, where before it
 *  stayed open and swapped threads under you. */
export function chatEntryFor(
  state: ChatStateMap,
  browseId: string | null | undefined,
): ChatEntry {
  if (!browseId) return CHAT_CLOSED;
  return state[browseId] ?? CHAT_CLOSED;
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
  const cur = state[browseId];
  const next: ChatEntry = { ...(cur ?? CHAT_CLOSED), ...patch, at: now };
  if (cur && cur.open === next.open && cur.pill === next.pill) return state;
  return { ...state, [browseId]: next };
}
