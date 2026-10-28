// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// When an agent reaches you OUTSIDE what you are looking at: a macOS
// notification per transition while you're away, and the Dock badge counting
// the sessions still waiting on you. Every kind of agent speaks the same two
// words here — a plan session's CLI and its held plan, a terminal on a wall,
// a chat room — so one rule decides them all:
//
//  * "waiting": the agent is blocked on you (a permission card, an
//    AskUserQuestion, a plan held for review). Badged until seen.
//  * "finished": its turn ended (a terminal's your-turn, a plan that arrived
//    without being held, a chat's reply). Notified, never badged.
//
// The frontend owns both because "seen" and "visible" live here — the daemon
// only knows what the hooks said. Pure; `useAttentionAlerts` owns the timers,
// the window's focus and the plugin.

import { TERM_STATE_LABEL } from "./termState";

export type AlertKind = "waiting" | "finished";

/** Where a notification's click takes you: the workbench reveal route. */
export type AlertTarget =
  | { type: "terminal"; terminalId: string }
  | { type: "plan"; sessionId: string }
  | { type: "chat"; companionId: string };

/** One transition of one session, as an alert names it. */
export interface SessionNews {
  /** Whose news it is (`plan:<id>`, `launch:<id>`, `term:<id>`,
   *  `chat:<id>`): the badge counts sessions, never one twice, and a batch
   *  notifies once per session. */
  session: string;
  /** The transition: one notification each, ever. */
  key: string;
  kind: AlertKind;
  /** When it happened (Unix ms): anything older than the window's alerts
   *  arming happened before this window existed and is never news. */
  at: number;
  title: string;
  body: string;
  target: AlertTarget;
}

/** A terminal in a loud state. */
export interface LoudTerminal {
  id: string;
  state: "needs-you" | "your-turn";
  /** The transition's `at` — one notification per terminal per transition. */
  at: number;
  /** "redline 2" — the needs-you message is the same generic sentence for
   *  every terminal (measured), so the label is what tells them apart. */
  label: string;
  text: string | null;
}

/** A your-turn waits this long before it notifies: its excerpt can land in a
 *  second event, and a user's own blocking Stop hook makes a brief your-turn
 *  the agent then continues past (both measured, experiment (l)). A needs-you
 *  has already waited ~7 s in the CLI before its hook fired, so it goes now. */
export const YOUR_TURN_NOTIFY_DELAY_MS = 2500;
/** A plan's arrival waits a beat: the ambient countdown's own notice (which
 *  says how long you have) lands just after it, and is the one to keep. */
export const PLAN_NOTIFY_DELAY_MS = 1500;

export function targetKey(t: AlertTarget): string {
  switch (t.type) {
    case "terminal":
      return `term:${t.terminalId}`;
    case "plan":
      return `plan:${t.sessionId}`;
    case "chat":
      return `chat:${t.companionId}`;
  }
}

/** A loud terminal's news. `owner` is the session it belongs to, when it
 *  belongs to one (a plan session's agent, a launch): its news is that
 *  session's, under the session's name. */
export function terminalNews(
  t: LoudTerminal,
  owner: { session: string; label: string | null } | null,
): SessionNews {
  const waiting = t.state === "needs-you";
  return {
    session: owner?.session ?? `term:${t.id}`,
    key: `term:${t.id}@${t.at}`,
    kind: waiting ? "waiting" : "finished",
    at: t.at,
    title: `${owner?.label || t.label} · ${TERM_STATE_LABEL[t.state]}`,
    body: t.text ?? (waiting ? "Its agent is waiting on you." : "Its agent finished its turn."),
    target: { type: "terminal", terminalId: t.id },
  };
}

/** What a plan session's latest revision says, for `planNews`. */
export interface PlanNewsInput {
  sessionId: string;
  label: string;
  held: boolean;
  /** The version the reader sees (restores skipped). */
  version: number;
  /** The latest revision's arrival; null when there is none yet. */
  receivedAt: number | null;
  /** The latest revision is a restore of a plan already reviewed. */
  restored: boolean;
}

/** A plan session's latest arrival. Held, the agent is blocked on your
 *  review: waiting. Not held (passed through, or approved before you
 *  looked): finished. One transition per arrival, so a held plan being
 *  approved is not news again, and a revision is. A restore is the user's
 *  own doing and never news. */
export function planNews(p: PlanNewsInput): SessionNews | null {
  if (p.receivedAt === null || p.restored) return null;
  return {
    session: `plan:${p.sessionId}`,
    key: `plan:${p.sessionId}@${p.receivedAt}`,
    kind: p.held ? "waiting" : "finished",
    at: p.receivedAt,
    title: p.label,
    body: p.held ? `Plan v${p.version} ready · waiting for you` : `Plan v${p.version} arrived`,
    target: { type: "plan", sessionId: p.sessionId },
  };
}

/** A chat room's reply: finished. */
export function chatNews(c: {
  companionId: string;
  messageId: string;
  at: number;
  title: string | null;
  body: string;
}): SessionNews {
  return {
    session: `chat:${c.companionId}`,
    key: `chat:${c.companionId}@${c.messageId}`,
    kind: "finished",
    at: c.at,
    title: `${c.title?.trim() || "Chat"} · replied`,
    body: excerpt(c.body) || "The reply is in.",
    target: { type: "chat", companionId: c.companionId },
  };
}

/** One line of at most `max` characters. */
export function excerpt(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The news not handled yet, in order, marking every current transition
 *  handled. A transition is handled the first time it is seen, whether or
 *  not it notified: you were here when it happened, and leaving later doesn't
 *  make it news. One older than `armedAt` predates this window (a reload, a
 *  late mount) and is handled without being news. Handled transitions that
 *  are no longer current are forgotten: one that stopped (read, answered,
 *  replaced, closed) never comes back with the same key, so the set stays
 *  the size of what is current. */
export function takeNews(
  current: readonly SessionNews[],
  handled: Set<string>,
  armedAt: number,
): SessionNews[] {
  const live = new Set(current.map((n) => n.key));
  for (const key of handled) if (!live.has(key)) handled.delete(key);
  const fresh: SessionNews[] = [];
  for (const n of current) {
    if (handled.has(n.key)) continue;
    handled.add(n.key);
    if (n.at >= armedAt) fresh.push(n);
  }
  return fresh;
}

/** One notification per session per batch: what is waiting outranks what
 *  finished, and the latest of a kind wins. Order kept by first appearance. */
export function onePerSession(news: readonly SessionNews[]): SessionNews[] {
  const best = new Map<string, SessionNews>();
  for (const n of news) {
    const held = best.get(n.session);
    if (!held || rank(n) > rank(held) || (rank(n) === rank(held) && n.at >= held.at)) best.set(n.session, n);
  }
  return [...best.values()];
}
const rank = (n: SessionNews) => (n.kind === "waiting" ? 1 : 0);

/** Whether `n` is on screen: its session is the one shown, or its own pane
 *  is (a Home terminal on the wall, a chat's pane). `visible` holds both
 *  kinds of key (workbench/onScreen). */
export function isVisible(n: SessionNews, visible: ReadonlySet<string>): boolean {
  return visible.has(n.session) || visible.has(targetKey(n.target));
}

/** Back in front after a notification: show what it was about only while it
 *  still WAITS on you — the same transition (key), still needing you, and
 *  not already on screen. A held plan approved meanwhile keeps its key but
 *  has finished; a terminal that answered itself is gone. Neither pulls you
 *  anywhere on the next ⌘Tab back. */
export function revealOnReturn(
  pending: { key: string } | null,
  news: readonly SessionNews[],
  visible: ReadonlySet<string>,
): boolean {
  if (!pending) return false;
  const still = news.find((n) => n.key === pending.key);
  return !!still && still.kind === "waiting" && !isVisible(still, visible);
}

/** Notify only what you'd otherwise miss: the window is not in front, or the
 *  session is not the one shown — and only the kinds you asked for. */
export function shouldNotify(
  n: SessionNews,
  at: { focused: boolean; visible: ReadonlySet<string>; prefs: Readonly<Record<AlertKind, boolean>> },
): boolean {
  if (!at.prefs[n.kind]) return false;
  return !at.focused || !isVisible(n, at.visible);
}

/** How long `n` waits before it notifies (and is re-checked). */
export function notifyDelay(n: SessionNews): number {
  if (n.target.type === "plan") return PLAN_NOTIFY_DELAY_MS;
  if (n.target.type === "terminal" && n.kind === "finished") return YOUR_TURN_NOTIFY_DELAY_MS;
  return 0;
}

/** The Dock badge: the sessions waiting on you that you have not seen —
 *  held plans, permission cards and questions alike, each session once
 *  however many of them it has. */
export function badgeCount(current: readonly SessionNews[], seen: ReadonlySet<string>): number {
  const sessions = new Set<string>();
  for (const n of current) if (n.kind === "waiting" && !seen.has(n.key)) sessions.add(n.session);
  return sessions.size;
}

/** Mark what is on screen in a window in front as seen, and forget what is
 *  no longer current. Returns `seen` itself when nothing changed. */
export function markSeen(
  seen: ReadonlySet<string>,
  current: readonly SessionNews[],
  focused: boolean,
  visible: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const n of current) {
    if (seen.has(n.key) || (focused && isVisible(n, visible))) next.add(n.key);
  }
  if (next.size === seen.size && [...next].every((k) => seen.has(k))) return seen;
  return next;
}

/** The session a terminal's news belongs to: the plan session whose agent
 *  runs in it, else the set that owns it unless that is Home (a launch);
 *  null for a plain terminal, whose news is its own. */
export function terminalSession(
  terminalId: string,
  sessionOfTerminal: ReadonlyMap<string, string>,
  owner: string | undefined,
): string | null {
  const sessionId = sessionOfTerminal.get(terminalId);
  if (sessionId) return `plan:${sessionId}`;
  return owner && owner !== "home" ? owner : null;
}
