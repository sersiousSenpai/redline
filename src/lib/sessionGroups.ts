// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow sidebar's list, as data: which rows exist, which section each
//! sorts into, and in what order. Pure, so the truth table is a test rather
//! than something read off a screenshot.
//!
//! Plans, chats and launched terminal sessions are one list. A launch is a
//! session from the moment it starts (board 4b): it has a row, a title and a
//! spinner before any plan row exists in the database, and the plan's row
//! replaces it once the plan arrives from the same terminal.
//!
//! Sections: **Needs you** first (Claude is blocked on you: a question, a
//! permission, a run waiting on its code review, a stalled run), only while
//! something does; then one group per project, the most recent first.
//!
//! Where a row is in its life (planning, in review, approved, building,
//! built) is the row's own status line (`rowStatus`), in its colour, on every
//! row; not a section. A section per stage put a stale "building" (nothing
//! ever moves a plan out of it when the agent finishes) at the top of the
//! list for good, spinning.

import type { SessionSummary } from "../types";
import { computeRevisionDisplay } from "./revisionVersions";
import { sessionMode, type ModeKind } from "./sessionMode";

/** Why a row is in Needs you; the tag at the row's right end. */
export type NeedReason = "Question" | "Permission" | "Review" | "Stalled";

/** A terminal session launched from the start screen whose plan has not
 *  arrived. `title` is the prompt until a plan title (or the CLI's own
 *  terminal title) replaces it. */
export interface FlowLaunch {
  terminalId: string;
  title: string;
  startedAt: number;
  projectPath: string | null;
  working: boolean;
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
  mode: ModeKind;
  need: NeedReason | null;
  working: boolean;
  archivedAt: number | null;
  /** Plan rows only. */
  session?: SessionSummary;
}

export type SectionKind = "needs" | "project";

export interface SidebarSection {
  /** `needs` · `project:<path>` (`project:` alone for rows with no folder).
   *  Stable across renders: it keys "Show N more". */
  id: string;
  kind: SectionKind;
  /** As written; the sidebar sets it in small caps. */
  label: string;
  /** The folder a project group's "+" starts a session in; null otherwise. */
  projectPath: string | null;
  /** The rows to render, in order. */
  rows: SidebarItem[];
  /** Rows folded behind "Show N more". */
  hidden: number;
  /** More rows than the section shows at rest, so it can fold back once
   *  opened ("Show less"). */
  foldable: boolean;
}

export interface SidebarModel {
  /** Something needs you, so that section leads. */
  live: boolean;
  sections: SidebarSection[];
  /** Archived plans and chats, newest archive first, for the closing fold. */
  archived: SidebarItem[];
}

export interface SidebarInput {
  sessions: readonly SessionSummary[];
  chats?: readonly FlowChat[];
  launches?: readonly FlowLaunch[];
  /** Live needs by item key, from the conversation engine's open asks
   *  (Question, Permission). A run's Review or Stalled is read off the
   *  session here; an entry in this map wins. */
  needs?: Readonly<Record<string, NeedReason>>;
  /** Item keys whose Claude is mid-turn. A launch's own `working` counts too. */
  working?: ReadonlySet<string>;
  activeKey?: string | null;
  /** Section ids the user opened past their "Show N more". */
  expanded?: ReadonlySet<string>;
}

/** Rows a section shows before "Show N more". Needs you never folds: each
 *  row there is something to act on. A project folds at six. */
export const SECTION_LIMIT: Record<SectionKind, number> = {
  needs: Infinity,
  project: 6,
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
export function planRowTitle(s: SessionSummary): string {
  return s.titleOverride || s.planTitle || s.projectName || s.projectPath || s.sessionId;
}

/** A plan's own need, before any engine ask: a run waiting on your code
 *  review, or one that stalled.
 *
 *  A plan held for its review is not one. That is what redlining IS (4d: the
 *  plan being marked is held, and sits in its project), and it is the row
 *  you are on: if opening it moved it out of Needs you, the row would jump
 *  out from under the click that opened it. */
function planNeed(s: SessionSummary): NeedReason | null {
  if (s.runState === "in_code_review" || s.runState === "awaiting_review") return "Review";
  if (s.runState === "stalled") return "Stalled";
  return null;
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

/** Every row the sidebar could show, unsorted. */
export function sidebarItems(input: SidebarInput): SidebarItem[] {
  const needs = input.needs ?? {};
  const working = input.working ?? new Set<string>();
  const items: SidebarItem[] = [];
  // A launch whose plan has arrived is that plan's row now: the plan was
  // intercepted from the launch's own terminal.
  const planned = new Set(input.sessions.map((s) => s.heldTerminalId).filter(Boolean));
  for (const s of input.sessions) {
    const key = itemKey("plan", s.sessionId);
    const busy = working.has(key);
    items.push({
      key,
      kind: "plan",
      id: s.sessionId,
      title: planRowTitle(s),
      at: s.updatedAt,
      projectPath: folderKey(s.projectPath),
      mode: planRowMode(s, busy),
      need: needs[key] ?? planNeed(s),
      working: busy,
      archivedAt: s.archivedAt ?? null,
      session: s,
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
      working: l.working || working.has(key),
      archivedAt: null,
    });
  }
  return items;
}

/** Newest first, ties by key so the order never flickers between reads. */
const byRecency = (a: SidebarItem, b: SidebarItem) => b.at - a.at || a.key.localeCompare(b.key);

/** The visible slice of a section: the first `limit` rows, plus the open row
 *  wherever it sits, so what you are looking at is always in the list. */
function fold(
  id: string,
  kind: SectionKind,
  label: string,
  projectPath: string | null,
  rows: SidebarItem[],
  input: SidebarInput,
): SidebarSection {
  const limit = input.expanded?.has(id) ? Infinity : SECTION_LIMIT[kind];
  const visible = rows.filter((row, index) => index < limit || row.key === input.activeKey);
  return { id, kind, label, projectPath, rows: visible, hidden: rows.length - visible.length, foldable: rows.length > SECTION_LIMIT[kind] };
}

/** Project groups, the most recently active folder first. A group is named
 *  for its folder (a plan's recorded project name when one has it); rows
 *  with no folder close the list, as Chats when they are all chats. */
function projectSections(items: SidebarItem[], input: SidebarInput): SidebarSection[] {
  const groups = new Map<string, SidebarItem[]>();
  for (const item of items) {
    const key = item.projectPath ?? "";
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const ordered = [...groups.entries()].map(([path, rows]) => ({ path, rows: rows.sort(byRecency) }));
  ordered.sort((a, b) => {
    // The folderless group is last whatever its recency: it is not a place.
    if (!a.path !== !b.path) return a.path ? -1 : 1;
    return byRecency(a.rows[0], b.rows[0]);
  });
  return ordered.map(({ path, rows }) => {
    if (!path) {
      const label = rows.every((row) => row.kind === "chat") ? "Chats" : "Other";
      return fold("project:", "project", label, null, rows, input);
    }
    const named = rows.find((row) => row.session?.projectName)?.session?.projectName;
    return fold(`project:${path}`, "project", named || basename(path), path, rows, input);
  });
}

export function buildSidebar(input: SidebarInput): SidebarModel {
  const all = sidebarItems(input);
  const archived = all.filter((item) => item.archivedAt !== null).sort((a, b) => b.archivedAt! - a.archivedAt! || byRecency(a, b));
  const current = all.filter((item) => item.archivedAt === null);
  const needs = current.filter((item) => item.need !== null);
  const live = needs.length > 0;
  const sections: SidebarSection[] = [];
  if (live) sections.push(fold("needs", "needs", "Needs you", null, needs.sort(byRecency), input));
  sections.push(...projectSections(current.filter((item) => item.need === null), input));
  return { live, sections, archived };
}

// ── A row's status line ─────────────────────────────────────────────────────

/** The colour a status wears: the top bar's mode inks (plan blue, redlining
 *  amber, building green) plus a quiet grey. */
export type StatusTone = "plan" | "redline" | "build" | "quiet";

export type StatusIcon = "spin" | "dot" | "alert" | "pen" | "hammer" | "check" | "built" | "run" | "chat" | "file";

export interface RowStatus {
  /** The status line's first word(s): "In review", "Approved · not built". */
  word: string;
  tone: StatusTone;
  icon: StatusIcon;
  /** The longer story, for the tooltip. */
  detail?: string;
}

const NEED_STATUS: Record<NeedReason, RowStatus> = {
  Question: { word: "Question for you", tone: "redline", icon: "dot", detail: "Claude asked you something and is waiting" },
  Permission: { word: "Needs permission", tone: "redline", icon: "dot", detail: "Claude is waiting for you to allow a tool" },
  Review: { word: "Ready for review", tone: "redline", icon: "dot", detail: "The run finished and waits on your review" },
  Stalled: { word: "Stalled", tone: "redline", icon: "alert", detail: "The run stopped making progress" },
};

/** Where a row is in its life, in one line. A spinner means something is
 *  running right now: a terminal mid-turn, or an orchestrated run the run
 *  watcher keeps honest. A build handed to an agent in its terminal is
 *  "Approved" with a hammer, never a spinner: nothing tells Redline when that
 *  agent finishes, so a spinner there would spin forever. */
export function rowStatus(item: Pick<SidebarItem, "kind" | "need" | "working" | "session">): RowStatus {
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
  if (s.runState === "orchestrating") return { word: "Starting the run", tone: "build", icon: "spin" };
  if (s.runState === "running") return { word: "Running", tone: "build", icon: "spin", detail: "An orchestrated run is building this plan" };
  if (s.status === "in_review") return { word: "In review", tone: "redline", icon: "pen", detail: s.held ? "Claude is waiting on your review" : undefined };
  if (s.status === "aborted") return { word: "Aborted", tone: "quiet", icon: "file" };
  switch (s.runState) {
    case "landed": return { word: "Built", tone: "build", icon: "built" };
    case "building": return { word: "Approved", tone: "build", icon: "hammer", detail: "Handed to an agent to build in its terminal" };
    case "ready": return { word: "Run ready", tone: "build", icon: "run", detail: "A run is drafted and waits on you to start it" };
    case "abandoned": return { word: "Stood down", tone: "quiet", icon: "file" };
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
