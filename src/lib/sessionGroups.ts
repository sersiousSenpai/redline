// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow sidebar's list, as data: which rows exist, which section each
//! sorts into, and in what order. Pure, so the truth table is a test rather
//! than something read off a screenshot.
//!
//! Plans, chats and launched terminal sessions are one list of rows. A launch
//! is a session from the moment it starts (board 4b): it has a row, a title
//! and a spinner before any plan row exists in the database, and the plan's
//! row replaces it once the plan arrives from the same terminal.
//!
//! Sections: **Needs you** first (Claude is blocked on you: a question or a
//! permission), only while something does; then **Projects**, one per
//! folder, the one with the newest plan first, each holding only its plans (and
//! the launches whose plan has not arrived) — the plan rows whole, no
//! subgroups — folding at five behind "Show N more", collapsible on its
//! header; a project only a chat names reads "No plans". Plans and launches
//! with no folder close the projects as "No project". Then **Chats**, one
//! flat list of every chat, its project a pill on the row, newest first,
//! collapsed until opened, folding at eight. A chat that became a plan
//! (`chatPlans`) leaves Chats once its plan exists: the plan is the thing
//! now, under its project, and its row's menu leads back to the chat.
//!
//! Where a row is in its life (planning, in review, approved, building,
//! built) is the row's own status line (`rowStatus`), in its colour, on every
//! row; not a section. A section per stage put a stale "building" (nothing
//! ever moves a plan out of it when the agent finishes) at the top of the
//! list for good, spinning.

import type { SessionSummary } from "../types";
import { computeRevisionDisplay } from "./revisionVersions";
import { planBuildState, sessionMode, type ModeKind } from "./sessionMode";

/** Why a row is in Needs you; the tag at the row's right end. */
export type NeedReason = "Question" | "Permission";

/** A terminal session launched from the start screen whose plan has not
 *  arrived. `title` is the prompt until a plan title (or the CLI's own
 *  terminal title) replaces it. */
export interface FlowLaunch {
  terminalId: string;
  title: string;
  startedAt: number;
  projectPath: string | null;
  working: boolean;
  /** Its agent is gone with no plan: the row reads stopped. */
  stopped?: boolean;
}

/** A chat (companion conversation), as much of it as the sidebar reads. */
export interface FlowChat {
  companionId: string;
  title: string;
  updatedAt: number;
  projectPath?: string | null;
  archivedAt?: number | null;
}

export type ItemKind = "plan" | "chat" | "launch";

export interface SidebarItem {
  /** `plan:<sessionId>` · `chat:<companionId>` · `launch:<terminalId>`. */
  key: string;
  kind: ItemKind;
  id: string;
  title: string;
  /** Recency: last activity for a plan or chat, launch time for a launch. */
  at: number;
  projectPath: string | null;
  /** Chat rows with a folder: the project's name as its header reads, for
   *  the row's pill. */
  projectLabel?: string;
  mode: ModeKind;
  need: NeedReason | null;
  working: boolean;
  archivedAt: number | null;
  /** Launch rows only: its agent is gone with no plan. */
  stopped?: boolean;
  /** Plan rows only. */
  session?: SessionSummary;
  /** Plan rows only: the chat this plan was made from, while that chat
   *  exists (its row's "Open chat"). */
  chatId?: string;
}

export type SectionKind = "needs" | "project";

export interface SidebarSection {
  /** `needs` · `project:<path>` (`project:` alone for rows with no folder).
   *  Stable across renders: it keys "Show N more" and the collapsed state. */
  id: string;
  kind: SectionKind;
  /** As written: Needs you's label, or the project's name. */
  label: string;
  /** The folder a project's "+" starts a session in; null otherwise. */
  projectPath: string | null;
  /** The rows to render, in order (none while collapsed). */
  rows: SidebarItem[];
  /** Rows folded behind "Show N more". */
  hidden: number;
  /** More rows than the section shows at rest, so it can fold back once
   *  opened ("Show less"). */
  foldable: boolean;
  /** Every row the section holds, shown or not. */
  count: number;
  /** The user folded the project away. Needs you never folds. */
  collapsed: boolean;
}

/** The one Chats list, after the projects. */
export interface SidebarChats {
  /** `chats`: keys its "Show N more". */
  id: "chats";
  /** The rows to render, in order (none while collapsed). */
  rows: SidebarItem[];
  hidden: number;
  foldable: boolean;
  /** Every chat the list holds, shown or not. */
  count: number;
  /** Chats whose agent is mid-turn: the header's spinner. */
  working: number;
  /** Closed: the default, until the user opens it. */
  collapsed: boolean;
}

export interface SidebarModel {
  /** Something needs you, so that section leads. */
  live: boolean;
  /** Needs you (while live), then the projects. */
  sections: SidebarSection[];
  chats: SidebarChats;
  /** Archived plans and chats, newest archive first, for the closing fold. */
  archived: SidebarItem[];
}

export interface SidebarInput {
  sessions: readonly SessionSummary[];
  chats?: readonly FlowChat[];
  launches?: readonly FlowLaunch[];
  /** Live needs by item key, from the conversation engine's open asks
   *  (Question, Permission). */
  needs?: Readonly<Record<string, NeedReason>>;
  /** Item keys whose Claude is mid-turn. A launch's own `working` counts too. */
  working?: ReadonlySet<string>;
  activeKey?: string | null;
  /** Section ids (and `chats`) the user opened past their "Show N more". */
  expanded?: ReadonlySet<string>;
  /** Project section ids the user collapsed. */
  collapsed?: ReadonlySet<string>;
  /** The user opened Chats; closed when absent. */
  chatsOpen?: boolean;
  /** Which plan each chat became: companion id → plan session id. */
  chatPlans?: Readonly<Record<string, string>>;
  /** Row keys that never fold away: the rows with terminals nested under
   *  them, so a terminal (one kept running after its wall closed above
   *  all) is always one click from its wall. */
  pinned?: ReadonlySet<string>;
}

/** Rows a list shows before "Show N more". Needs you never folds: each row
 *  there is something to act on. A project folds at five, Chats at eight. */
export const SECTION_LIMIT: Record<SectionKind | "chats", number> = {
  needs: Infinity,
  project: 5,
  chats: 8,
};

export const itemKey = (kind: ItemKind, id: string): string => `${kind}:${id}`;

/** A folder path with no trailing slash, so `/a/b` and `/a/b/` group as one. */
function folderKey(path: string | null | undefined): string | null {
  const trimmed = path?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** What a plan session's row is called: the user's name for it, the plan's
 *  own heading, then where it lives. */
function planRowTitle(s: SessionSummary): string {
  return s.titleOverride || s.planTitle || s.projectName || s.projectPath || s.sessionId;
}

/** A plan row's mode, in the top bar's own words (lib/sessionMode): the row
 *  you open wears the chip's colour. Claude mid-turn in its terminal is a
 *  revision being written; a plan with no mode to name (aborted, nothing
 *  live) reads as Plan mode. */
export function planRowMode(s: SessionSummary, busy: boolean): ModeKind {
  return sessionMode({
    target: "plan",
    status: s.status,
    held: s.held,
    revising: busy,
    revisions: s.revisions,
    runState: s.runState,
  })?.kind ?? "plan";
}

/** Each live chat→plan link as plan session id → companion id: both ends
 *  must exist, or there is nothing to elevate and nothing to go back to. */
export function planChats(input: Pick<SidebarInput, "sessions" | "chats" | "chatPlans">): Map<string, string> {
  const out = new Map<string, string>();
  if (!input.chatPlans) return out;
  const plans = new Set(input.sessions.map((s) => s.sessionId));
  const chats = new Set((input.chats ?? []).map((c) => c.companionId));
  for (const [chatId, sessionId] of Object.entries(input.chatPlans)) {
    if (plans.has(sessionId) && chats.has(chatId)) out.set(sessionId, chatId);
  }
  return out;
}

/** Every row the sidebar could show, unsorted. */
export function sidebarItems(input: SidebarInput): SidebarItem[] {
  const needs = input.needs ?? {};
  const working = input.working ?? new Set<string>();
  const items: SidebarItem[] = [];
  // A launch whose plan has arrived is that plan's row now: the plan was
  // intercepted from the launch's own terminal.
  const planned = new Set(input.sessions.map((s) => s.heldTerminalId).filter(Boolean));
  const fromChat = planChats(input);
  for (const s of input.sessions) {
    const key = itemKey("plan", s.sessionId);
    const busy = working.has(key);
    const chatId = fromChat.get(s.sessionId);
    items.push({
      key,
      kind: "plan",
      id: s.sessionId,
      title: planRowTitle(s),
      at: s.updatedAt,
      projectPath: folderKey(s.projectPath),
      mode: planRowMode(s, busy),
      need: needs[key] ?? null,
      working: busy,
      archivedAt: s.archivedAt ?? null,
      session: s,
      ...(chatId ? { chatId } : {}),
    });
  }
  for (const c of input.chats ?? []) {
    const key = itemKey("chat", c.companionId);
    items.push({
      key,
      kind: "chat",
      id: c.companionId,
      title: c.title,
      at: c.updatedAt,
      projectPath: folderKey(c.projectPath),
      mode: "chat",
      need: needs[key] ?? null,
      working: working.has(key),
      archivedAt: c.archivedAt ?? null,
    });
  }
  for (const l of input.launches ?? []) {
    if (planned.has(l.terminalId)) continue;
    const key = itemKey("launch", l.terminalId);
    items.push({
      key,
      kind: "launch",
      id: l.terminalId,
      // The prompt's first line: a pasted brief must not become a title.
      title: l.title.trim().split("\n")[0] || "New session",
      at: l.startedAt,
      projectPath: folderKey(l.projectPath),
      // Before its plan exists a terminal session is Claude planning.
      mode: "plan",
      need: needs[key] ?? null,
      working: !l.stopped && (l.working || working.has(key)),
      archivedAt: null,
      stopped: !!l.stopped,
    });
  }
  return items;
}

/** Newest first, ties by key so the order never flickers between reads. */
const byRecency = (a: SidebarItem, b: SidebarItem) => b.at - a.at || a.key.localeCompare(b.key);

/** The first `limit` rows, plus the open row and the pinned ones, so what
 *  you are looking at is always in the list. */
function folded(id: string, limit: number, rows: SidebarItem[], input: SidebarInput): { rows: SidebarItem[]; hidden: number; foldable: boolean } {
  const cap = input.expanded?.has(id) ? Infinity : limit;
  const visible = rows.filter((row, index) => index < cap || row.key === input.activeKey || !!input.pinned?.has(row.key));
  return { rows: visible, hidden: rows.length - visible.length, foldable: rows.length > limit };
}

function section(id: string, kind: SectionKind, label: string, projectPath: string | null, rows: SidebarItem[], input: SidebarInput): SidebarSection {
  const collapsed = kind === "project" && !!input.collapsed?.has(id);
  const shown = collapsed ? { rows: [], hidden: 0, foldable: false } : folded(id, SECTION_LIMIT[kind], rows, input);
  return { id, kind, label, projectPath, ...shown, count: rows.length, collapsed };
}

/** Each folder's name: a plan's recorded project name when one has it, else
 *  the folder's last segment. */
function projectLabels(items: readonly SidebarItem[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const item of items) {
    if (!item.projectPath) continue;
    const named = item.session?.projectName;
    if (named && !labels.has(item.projectPath)) labels.set(item.projectPath, named);
  }
  for (const item of items) {
    if (item.projectPath && !labels.has(item.projectPath)) labels.set(item.projectPath, basename(item.projectPath));
  }
  return labels;
}

/** Projects, the folder with the most recent plan first: a project holds
 *  only its plans and launches, so its place in the list is theirs. A
 *  folder only a chat names follows them, empty ("No plans"), its chats'
 *  recency ordering it among its kind. Plans and launches with no folder
 *  close the list, as "No project". */
function projectSections(rows: SidebarItem[], chats: readonly SidebarItem[], labels: Map<string, string>, input: SidebarInput): SidebarSection[] {
  const groups = new Map<string, { rows: SidebarItem[]; at: number }>();
  for (const row of rows) {
    const path = row.projectPath ?? "";
    const group = groups.get(path);
    if (group) {
      group.rows.push(row);
      group.at = Math.max(group.at, row.at);
    } else groups.set(path, { rows: [row], at: row.at });
  }
  for (const chat of chats) {
    if (!chat.projectPath) continue;
    const group = groups.get(chat.projectPath);
    if (!group) groups.set(chat.projectPath, { rows: [], at: chat.at });
    else if (group.rows.length === 0) group.at = Math.max(group.at, chat.at);
  }
  const ordered = [...groups.entries()].map(([path, group]) => ({ path, at: group.at, rows: group.rows.sort(byRecency) }));
  ordered.sort((a, b) => {
    // The folderless group is last whatever its recency: it is not a place.
    if (!a.path !== !b.path) return a.path ? -1 : 1;
    // A project with plans before one with none.
    if (!a.rows.length !== !b.rows.length) return a.rows.length ? -1 : 1;
    return b.at - a.at || a.path.localeCompare(b.path);
  });
  return ordered.map(({ path, rows: held }) =>
    path
      ? section(`project:${path}`, "project", labels.get(path) ?? basename(path), path, held, input)
      : section("project:", "project", "No project", null, held, input));
}

export function buildSidebar(input: SidebarInput): SidebarModel {
  const all = sidebarItems(input);
  const labels = projectLabels(all);
  for (const item of all) if (item.kind === "chat" && item.projectPath) item.projectLabel = labels.get(item.projectPath);
  const archived = all.filter((item) => item.archivedAt !== null).sort((a, b) => b.archivedAt! - a.archivedAt! || byRecency(a, b));
  const current = all.filter((item) => item.archivedAt === null);
  const needs = current.filter((item) => item.need !== null);
  const live = needs.length > 0;
  const sections: SidebarSection[] = [];
  if (live) sections.push(section("needs", "needs", "Needs you", null, needs.sort(byRecency), input));
  const rest = current.filter((item) => item.need === null);
  // A chat that became a plan is that plan now: the plan's row says where it
  // is in its life, under its project, and its menu leads back to the chat.
  const elevated = new Set(all.flatMap((item) => (item.chatId ? [item.chatId] : [])));
  const chatRows = rest.filter((item) => item.kind === "chat" && !elevated.has(item.id)).sort(byRecency);
  sections.push(...projectSections(rest.filter((item) => item.kind !== "chat"), chatRows, labels, input));
  const chatsOpen = !!input.chatsOpen;
  const shownChats = chatsOpen ? folded("chats", SECTION_LIMIT.chats, chatRows, input) : { rows: [], hidden: 0, foldable: false };
  const chats: SidebarChats = {
    id: "chats",
    ...shownChats,
    count: chatRows.length,
    working: chatRows.filter((row) => row.working).length,
    collapsed: !chatsOpen,
  };
  return { live, sections, chats, archived };
}

// ── A row's status line ─────────────────────────────────────────────────────

/** The colour a status wears: the top bar's mode inks (plan blue, redlining
 *  amber, building green) plus a quiet grey. */
export type StatusTone = "plan" | "redline" | "build" | "quiet";

export type StatusIcon = "spin" | "dot" | "pen" | "hammer" | "check" | "built" | "chat" | "file";

export interface RowStatus {
  /** The status line's first word(s): "In review", "Approved · not built". */
  word: string;
  tone: StatusTone;
  icon: StatusIcon;
  /** The longer story, for the tooltip. */
  detail?: string;
}

// The one status vocabulary: whatever the agent waits on, the row says
// "Needs you"; what it waits on is the tooltip's.
const NEED_STATUS: Record<NeedReason, RowStatus> = {
  Question: { word: "Needs you", tone: "redline", icon: "dot", detail: "Claude asked you something and is waiting" },
  Permission: { word: "Needs you", tone: "redline", icon: "dot", detail: "Claude is waiting for you to allow a tool" },
};

/** Where a row is in its life, in one line. A spinner means something is
 *  running right now: a terminal mid-turn. A build handed to an agent in its terminal is
 *  "Approved" with a hammer, never a spinner: nothing tells Redline when that
 *  agent finishes, so a spinner there would spin forever. */
export function rowStatus(item: Pick<SidebarItem, "kind" | "need" | "working" | "session" | "stopped">): RowStatus {
  if (item.kind === "launch" && item.stopped) return { word: "Stopped", tone: "quiet", icon: "dot", detail: "Claude stopped before its plan arrived: Retry or Remove from the row's menu or its Agent tab" };
  if (item.need) return NEED_STATUS[item.need];
  if (item.kind === "chat") return item.working ? { word: "Replying", tone: "plan", icon: "spin" } : { word: "Chat", tone: "quiet", icon: "chat" };
  if (item.kind === "launch") return item.working ? { word: "Planning", tone: "plan", icon: "spin" } : { word: "Waiting", tone: "quiet", icon: "file", detail: "Claude is idle in its terminal, with no plan yet" };
  const s = item.session;
  if (!s) return { word: "Plan", tone: "quiet", icon: "file" };
  if (item.working) {
    return s.status === "approved"
      ? { word: "Building", tone: "build", icon: "spin", detail: "An agent is building this plan in its terminal" }
      : { word: s.held ? "Planning" : "Revising", tone: "plan", icon: "spin", detail: "Claude is working in this plan's terminal" };
  }
  if (s.status === "in_review") return { word: "In review", tone: "redline", icon: "pen", detail: s.held ? "Claude is waiting on your review" : undefined };
  if (s.status === "aborted") return { word: "Aborted", tone: "quiet", icon: "file" };
  switch (planBuildState(s.runState)) {
    case "landed": return { word: "Built", tone: "build", icon: "built" };
    case "building": return { word: "Approved", tone: "build", icon: "hammer", detail: "Handed to an agent to build in its terminal" };
    default: return { word: "Approved · not built", tone: "build", icon: "check" };
  }
}

/** "now", "5m", "3h", "2d", then the date. */
export function rowAge(at: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

export interface VersionRow {
  versionNumber: number;
  /** "v3", "v2 · restored", "v4 · latest". */
  label: string;
  /** "Oct 14"; a revision from today reads as its time instead. */
  date: string;
  latest: boolean;
  /** The revision on screen. */
  viewed: boolean;
  /** A new plan began here in the same terminal: a thread boundary. */
  threadStart: boolean;
}

/** The open session's versions, oldest first (board 5a). `viewedVersionNumber`
 *  null means the latest is on screen. */
export function versionRows(
  session: Pick<SessionSummary, "revisions">,
  viewedVersionNumber: number | null,
  now: number = Date.now(),
): VersionRow[] {
  const display = computeRevisionDisplay(session.revisions);
  const today = new Date(now).toDateString();
  return session.revisions.map((r, index) => {
    const info = display.get(r.versionNumber);
    const latest = info?.isLatest ?? false;
    const when = new Date(r.receivedAt);
    const suffix = latest ? " · latest" : r.restored ? " · restored" : "";
    return {
      versionNumber: r.versionNumber,
      label: `v${info?.displayVersion ?? r.versionNumber}${suffix}`,
      date:
        when.toDateString() === today
          ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : when.toLocaleDateString([], { month: "short", day: "numeric" }),
      latest,
      viewed: viewedVersionNumber === null ? latest : r.versionNumber === viewedVersionNumber,
      threadStart: index > 0 && !!r.threadStart && !r.restored,
    };
  });
}
