// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The browser chat's conversation SCOPE, as data and one reducer.
//
// Which thread the page chat shows, which page a turn targets, and how every
// gesture moves those two are decided here and nowhere else. BrowserPane holds
// a `ChatWorld`, dispatches a `ChatEvent` from each handler, and renders
// `resolveConversation(world)`. Nothing else derives a thread id: not the dock
// descriptor, not the selection seed, not the mission pin.
//
// Every event goes through `normalize`, so the scope rules hold by
// construction rather than by an effect that runs after a render:
//   - the anchored and active tabs exist (BC-5),
//   - a flip only ever names the anchored conversation (BC-3, "mode wins"),
//   - a shared chat that is asked for already has an id (BC-9).
//
// Rule ids (BC-n) are catalogued in invariants.ts.

/** "regular" | <missionId> | "mosaic:<id>" — BrowserPane's `workspaceKey`. */
export type WorkspaceKey = string;
export type WorkspaceKind = "regular" | "mission" | "mosaic";
export const MOSAIC_PREFIX = "mosaic:";
/** The shared chat's name, the title BrowserPane has always given it. */
export const SHARED_TITLE = "Browser chat";

export function workspaceKind(key: WorkspaceKey): WorkspaceKind {
  if (key === "regular") return "regular";
  return key.startsWith(MOSAIC_PREFIX) ? "mosaic" : "mission";
}

/** The slice of a browser tab the chat cares about. BrowserPane's own tab
 *  record is a superset, so its tab list passes straight in. */
export interface ChatTab {
  /** Registry id (`t-…`); the native webview label is `browser-${id}`. */
  id: string;
  /** Durable thread key of the tab's OWN chat (BC-1). */
  browseId: string;
  title: string;
  url: string;
}

export interface ChatWorld {
  workspace: WorkspaceKey;
  /** In strip order: index + 1 is the tab NUMBER the user and agent share. */
  tabs: readonly ChatTab[];
  /** The tab on screen — always the page a turn targets. */
  activeId: string;
  /** The tab whose conversation is anchored. Equals `activeId` except after
   *  an agent opened a tab on the conversation's behalf (BC-5). */
  discussionId: string;
  /** The persisted global preference; off by default (BC-2). */
  linkedMode: boolean;
  /** The one browseId shown AGAINST the mode right now. Never persisted (BC-3). */
  flipFor: string | null;
  /** The shared conversation of each workspace (BC-4). Persisted. */
  shared: Readonly<Record<WorkspaceKey, string | undefined>>;
}

export type ChatEvent =
  /** A tab click, a tile focus, a keyboard next/previous tab. */
  | { type: "user-select-tab"; tabId: string }
  /** `POST /v1/browser/focus`: the agent switches the user INTO a tab. */
  | { type: "agent-focus-tab"; tabId: string }
  /** "+", ⌘T, a link the user opens in a new tab. */
  | { type: "user-open-tab"; tab: ChatTab }
  /** `POST /v1/browser/open`, `browse-open-tab`, a page's window.open. */
  | { type: "agent-open-tab"; tab: ChatTab }
  /** A cited source the user clicks in a reply: an open tab is selected, a
   *  new page opens beside the conversation without moving it. */
  | { type: "open-source"; tab: ChatTab; existing: boolean }
  /** The element picker attached an element from this tab. */
  | { type: "inspect"; tabId: string }
  | { type: "close-tab"; tabId: string }
  | { type: "reorder-tabs"; order: readonly string[] }
  | { type: "toggle-tab-chat" }
  | { type: "toggle-linked-mode" }
  /** Plan Search: always a FRESH tab, with its own chat (BC-6). */
  | { type: "plan-search-opened"; tab: ChatTab }
  /** "View result →" (quiet: false) or a Front Door recents reopen (quiet: true). */
  | { type: "reopen-tab"; tabId: string; quiet: boolean }
  /** `redline-open-conversation`: the exact thread a link names (BC-7). */
  | { type: "open-conversation"; browseId: string }
  | { type: "workspace-swapped"; workspace: WorkspaceKey; tabs: readonly ChatTab[]; activeId: string }
  /** Starting a mission from regular browsing carries the tabs AND the
   *  shared chat (BC-4). */
  | { type: "mission-started-from-regular"; missionId: string };

export interface ResolvedConversation {
  kind: "tab" | "shared";
  /** The thread the chat shows and sends on. */
  browseId: string;
  /** Header title: the anchored tab's title, or the shared chat's name. */
  title: string;
  /** The page a turn grounds on and acts on: always the tab on screen (BC-12). */
  targetLabel: string;
  /** That tab's own thread key, which the turn's rows keep (BC-24). */
  targetBrowseId: string;
  targetTitle: string;
  /** 1-based strip position of the target, which is what the user calls it (BC-1). */
  targetNumber: number;
  scope: "pinned-page" | "following-tabs";
  /** Only for an agent-opened tab: the title of the tab the conversation
   *  started on. Never the shared chat's own name. */
  anchoredFrom: string | null;
  /** This chat is the exception to linked mode, the only case in which the
   *  UI names the kind of chat in words (BC-3). */
  exception: boolean;
}

const tabById = (w: ChatWorld, id: string) => w.tabs.find((t) => t.id === id);
/** An open event for a page that is already open brings it forward instead
 *  of listing it twice: the pane opens an address once, by URL. */
const withTab = (w: ChatWorld, tab: ChatTab) => (tabById(w, tab.id) ? w.tabs : [...w.tabs, tab]);

function anchoredTab(w: ChatWorld): ChatTab | undefined {
  return tabById(w, w.discussionId) ?? tabById(w, w.activeId) ?? w.tabs[0];
}

/** Whether the anchored conversation shows its tab's OWN chat. */
function showsOwn(w: ChatWorld): boolean {
  const flipped = w.flipFor !== null && w.flipFor === anchoredTab(w)?.browseId;
  return w.linkedMode ? flipped : !flipped;
}

export function resolveConversation(w: ChatWorld): ResolvedConversation | null {
  const discussion = anchoredTab(w);
  const active = tabById(w, w.activeId) ?? discussion;
  if (!discussion || !active) return null;
  const own = showsOwn(w);
  const sharedId = w.shared[w.workspace];
  // Unreachable after `normalize`. A hand-built world asking for the shared
  // chat with no id resolves to nothing rather than to the tab's own thread
  // dressed as shared (the 10/09 flash, when an effect minted it late).
  if (!own && !sharedId) return null;
  return {
    kind: own ? "tab" : "shared",
    browseId: own ? discussion.browseId : sharedId!,
    title: own ? discussion.title : SHARED_TITLE,
    targetLabel: `browser-${active.id}`,
    targetBrowseId: active.browseId,
    targetTitle: active.title,
    targetNumber: w.tabs.indexOf(active) + 1,
    scope: own ? "pinned-page" : "following-tabs",
    anchoredFrom: discussion.id !== active.id ? discussion.title : null,
    exception: own === w.linkedMode,
  };
}

/** The one line under the header that says what the chat is looking at. A
 *  shared chat names the page it follows; an anchored conversation names
 *  where it came from; a chat that is the exception to the mode says so. */
export function contextLine(c: ResolvedConversation): string[] {
  const parts: string[] = [];
  if (c.kind === "tab" && c.exception) parts.push("This tab’s own chat");
  if (c.kind === "shared" && c.exception) parts.push("Shared chat");
  if (c.kind === "shared" || c.anchoredFrom) parts.push(`On tab ${c.targetNumber} — ${c.targetTitle}`);
  if (c.anchoredFrom) parts.push(`From ${c.anchoredFrom}`);
  return parts;
}

/** What the dock advertises for the page conversation: the RESOLVED thread,
 *  whether or not the column is open, and never the tab's own id while the
 *  mode says shared (BC-10). */
export function dockDescriptor(w: ChatWorld): { browseId: string; title: string } | null {
  const c = resolveConversation(w);
  return c ? { browseId: c.browseId, title: c.title } : null;
}

/** The laws every world satisfies after any event. */
export function normalize(w: ChatWorld, mint: () => string): ChatWorld {
  if (!w.tabs.length) return { ...w, flipFor: null };
  let next = w;
  if (!tabById(next, next.activeId)) next = { ...next, activeId: next.tabs[0].id };
  if (!tabById(next, next.discussionId)) next = { ...next, discussionId: next.activeId };
  // Mode wins on any switch of the anchored conversation (BC-3).
  if (next.flipFor !== null && next.flipFor !== anchoredTab(next)?.browseId) next = { ...next, flipFor: null };
  // A shared chat that is asked for exists before anything renders it (BC-9).
  if (!showsOwn(next) && !next.shared[next.workspace]) next = { ...next, shared: { ...next.shared, [next.workspace]: mint() } };
  return next;
}

function step(w: ChatWorld, e: ChatEvent): ChatWorld {
  switch (e.type) {
    case "user-select-tab":
    case "agent-focus-tab":
      // A full switch: page AND conversation follow (BC-5).
      return tabById(w, e.tabId) ? { ...w, activeId: e.tabId, discussionId: e.tabId } : w;
    case "user-open-tab":
      return { ...w, tabs: withTab(w, e.tab), activeId: e.tab.id, discussionId: e.tab.id };
    case "agent-open-tab":
      // The page comes forward; the conversation stays anchored (BC-5).
      return { ...w, tabs: withTab(w, e.tab), activeId: e.tab.id };
    case "open-source":
      return e.existing
        ? step(w, { type: "user-select-tab", tabId: e.tab.id })
        : step(w, { type: "agent-open-tab", tab: e.tab });
    case "inspect":
      // The picked element's tab is the one on screen; the chat anchors to it.
      return tabById(w, e.tabId) ? { ...w, activeId: e.tabId, discussionId: e.tabId } : w;
    case "close-tab": {
      const i = w.tabs.findIndex((t) => t.id === e.tabId);
      if (i < 0) return w;
      const tabs = w.tabs.filter((t) => t.id !== e.tabId);
      if (!tabs.length) return { ...w, tabs };
      const neighbour = tabs[Math.min(i, tabs.length - 1)].id;
      const activeId = w.activeId === e.tabId ? neighbour : w.activeId;
      const discussionId = w.discussionId === e.tabId ? activeId : w.discussionId;
      return { ...w, tabs, activeId, discussionId };
    }
    case "reorder-tabs": {
      // Numbers are positional; durable ids ride along (BC-1). An order that
      // is not exactly the open tabs (one missing, one twice) is ignored
      // rather than allowed to drop a tab.
      const byId = new Map(w.tabs.map((t) => [t.id, t]));
      const tabs = e.order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      return tabs.length === w.tabs.length && new Set(tabs).size === tabs.length ? { ...w, tabs } : w;
    }
    case "toggle-tab-chat": {
      // Relative to what is ON SCREEN (the anchored conversation), then
      // re-coupled to the visible tab, so "Tab chat" from an anchored shared
      // chat opens the visible tab's own chat.
      const showingOwn = showsOwn(w);
      const active = tabById(w, w.activeId)?.browseId ?? null;
      return { ...w, discussionId: w.activeId, flipFor: showingOwn === w.linkedMode ? null : active };
    }
    case "toggle-linked-mode":
      return { ...w, linkedMode: !w.linkedMode, flipFor: null, discussionId: w.activeId };
    case "plan-search-opened": {
      // Always a fresh tab and its OWN chat, whichever way the mode leans (BC-6).
      const next = { ...w, tabs: [...w.tabs, e.tab], activeId: e.tab.id, discussionId: e.tab.id };
      return { ...next, flipFor: w.linkedMode ? e.tab.browseId : null };
    }
    case "reopen-tab": {
      const tab = tabById(w, e.tabId);
      if (!tab) return w;
      const next = { ...w, activeId: e.tabId, discussionId: e.tabId };
      // "View result →" returns to that tab's own thread; a quiet reopen
      // leaves it to the mode.
      return { ...next, flipFor: !e.quiet && w.linkedMode ? tab.browseId : null };
    }
    case "open-conversation": {
      const tab = w.tabs.find((t) => t.browseId === e.browseId);
      if (tab) return { ...w, activeId: tab.id, discussionId: tab.id, flipFor: w.linkedMode ? tab.browseId : null };
      if (e.browseId === w.shared[w.workspace]) {
        const active = tabById(w, w.activeId)?.browseId ?? null;
        return { ...w, discussionId: w.activeId, flipFor: w.linkedMode ? null : active };
      }
      // Not here: the caller says the conversation's tab is no longer open.
      return w;
    }
    case "workspace-swapped":
      return { ...w, workspace: e.workspace, tabs: e.tabs, activeId: e.activeId, discussionId: e.activeId, flipFor: null };
    case "mission-started-from-regular":
      // No swap: the same tabs (and webviews) become the mission's, and the
      // regular shared chat goes with them; regular starts fresh (BC-4).
      if (w.workspace !== "regular") return w;
      return { ...w, workspace: e.missionId, flipFor: null, shared: { ...w.shared, [e.missionId]: w.shared.regular, regular: undefined } };
  }
}

export function reduceChatWorld(w: ChatWorld, e: ChatEvent, mint: () => string): ChatWorld {
  return normalize(step(w, e), mint);
}

/** A world restored from storage (or built at mount) obeys the same laws. */
export function hydrate(w: ChatWorld, mint: () => string): ChatWorld {
  return normalize({ ...w, flipFor: null }, mint);
}

/** Whether an event may move the composer caret. Only a gesture aimed at the
 *  composer does; tab switches, agent actions and background seeds never take
 *  focus (BC-33). */
export function eventTakesFocus(e: ChatEvent): boolean {
  return e.type === "inspect";
}
