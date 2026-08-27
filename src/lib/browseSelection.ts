// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** Highlight-to-chat: the pure half of the browser's selection action bar.
 *
 *  The bar itself is drawn *inside* the page by an injected shim (see
 *  `selection_shim_js` in `src-tauri/src/lib.rs`) — the child webview is an OS
 *  layer composited above the React DOM, so nothing here can overlay it and
 *  `window.getSelection()` in the host document never sees page text. What the
 *  shim hands back is a queue of plain objects the pane drains in its existing
 *  250 ms poll; this module turns that untrusted JSON into events, and events
 *  into the message the page-discussion agent actually receives.
 */

/** `copy` never reaches here — the shim handles it entirely in-page, so the
 *  clipboard write happens inside the click's user activation. */
export type SelectionAction = "ask" | "define" | "explain" | "research" | "list";

export interface SelectionEvent {
  /** Per-page counter from the shim. Only meaningful within one drain. */
  id: number;
  action: SelectionAction;
  /** The highlighted passage, trimmed and clamped. */
  text: string;
  url: string;
  title: string;
}

const ACTIONS: readonly SelectionAction[] = [
  "ask",
  "define",
  "explain",
  "research",
  "list",
];

/** Matches the shim's own cap. A passage past this is an accident (⌘A on a long
 *  article), not a question — clamp rather than send a whole page as a quote. */
export const MAX_SELECTION_CHARS = 4000;

/** The line appended under the quote. Empty for the intents that don't carry
 *  one: `ask` is waiting for the user's own question, and `list` never becomes
 *  a chat turn at all. */
const INTENT: Record<SelectionAction, string> = {
  ask: "",
  define: "Define this as it's used on this page.",
  explain: "Explain this simply, in the context of this page.",
  research:
    "Research this beyond this page — prefer WebSearch over re-reading the page, and cite what you find.",
  list: "",
};

/** Clamp a passage to `MAX_SELECTION_CHARS`, marking the cut so neither the
 *  user nor the agent mistakes a truncated quote for the whole passage. */
export function clampSelection(text: string): string {
  const t = text.trim();
  return t.length > MAX_SELECTION_CHARS
    ? `${t.slice(0, MAX_SELECTION_CHARS).trimEnd()}…`
    : t;
}

/** Read the shim's queue. Everything in it crossed a JSON boundary out of an
 *  arbitrary web page, so nothing is trusted: a row missing its action, naming
 *  one we don't have, or carrying no text is dropped rather than dispatched. */
export function parseSelectionEvents(raw: unknown): SelectionEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: SelectionEvent[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const action = typeof o.action === "string" ? o.action : "";
    if (!ACTIONS.includes(action as SelectionAction)) continue;
    const text = typeof o.text === "string" ? clampSelection(o.text) : "";
    if (!text) continue;
    out.push({
      id: typeof o.id === "number" && Number.isFinite(o.id) ? o.id : 0,
      action: action as SelectionAction,
      text,
      url: typeof o.url === "string" ? o.url : "",
      title: typeof o.title === "string" ? o.title : "",
    });
  }
  return out;
}

/** The message the highlight becomes: the passage as a blockquote, then the
 *  intent. Quoting follows `quoteItem`'s convention in browseList.ts — including
 *  the trailing blank line, which is what leaves the caret BELOW the quote when
 *  the composer is only seeded (`ask`) rather than sent. */
export function promptForSelection(ev: SelectionEvent): string {
  const quoted = clampSelection(ev.text)
    .split("\n")
    .map((line) => `> ${line}`.trimEnd());
  const intent = INTENT[ev.action] ?? "";
  return [...quoted, "", intent].join("\n");
}

/** Whether tapping this action sends the turn straight away.
 *
 *  Only `ask` waits: it has no question in it yet. Define/Explain/Research are
 *  already complete instructions, so making the user press ⌘↵ to confirm what
 *  they just tapped would be friction with no payoff. (`list` never reaches the
 *  composer — it's appended to the tab's working list instead.) */
export function autoSends(action: SelectionAction): boolean {
  return action !== "ask";
}
