// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The browser's new-tab page, as data: what the kicker says, which pages
// "Pick back up" lists, how "Reading, by subject" groups the rest, and what
// the live strip shows. Pure, so the page renders what these return and the
// tests read the same rules.

import { SEARCH_URL } from "./omnibox";
import type { HomePage } from "./browserHome";
import type { CandidateTab } from "./doorRecents";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function clock(now: Date): string {
  const h = now.getHours(), m = now.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Tuesday · 1:52 AM · 5 pages open", plus "· 2 need you" only when a page
 *  needs you. A page count of one reads "1 page open". */
export function newTabKicker(now: Date, openPages: number, needYou = 0): string {
  const parts = [WEEKDAYS[now.getDay()], clock(now)];
  if (openPages > 0) parts.push(`${openPages} ${openPages === 1 ? "page" : "pages"} open`);
  if (needYou > 0) parts.push(`${needYou} need you`);
  return parts.join(" · ");
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A short age for a row's right edge: "now", "20m", "3h", "yesterday",
 *  then a date ("Oct 22"). */
export function shortAge(at: number | undefined, now: number): string {
  if (!at || !Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 12 * 60) return `${Math.round(minutes / 60)}h`;
  const day = new Date(at), today = new Date(now);
  if (sameDay(day, today)) return clock(day);
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(day, yesterday)) return "yesterday";
  return `${MONTHS[day.getMonth()]} ${day.getDate()}`;
}

/** The span a subject's pages cover: "Oct 9–22", "Oct 30 – Nov 2", one day
 *  ("Oct 22"), or "today". */
export function dateSpan(times: readonly number[], now: number): string {
  const known = times.filter((t) => Number.isFinite(t) && t > 0);
  if (!known.length) return "";
  const first = new Date(Math.min(...known)), last = new Date(Math.max(...known)), today = new Date(now);
  if (sameDay(first, today) && sameDay(last, today)) return "today";
  if (now - first.getTime() < 7 * 86_400_000) return "this week";
  const a = `${MONTHS[first.getMonth()]} ${first.getDate()}`;
  if (sameDay(first, last)) return a;
  if (first.getMonth() === last.getMonth()) return `${a}–${last.getDate()}`;
  return `${a} – ${MONTHS[last.getMonth()]} ${last.getDate()}`;
}

export interface OpenPage { id: string; browseId: string; title: string; url: string; favicon?: string }
export interface ClosedPage { url: string; title: string; at: number }

export type PickRow =
  | { kind: "tab"; key: string; tabId: string; title: string; detail: string; url: string; favicon?: string; at?: number }
  | { kind: "tasks"; key: string; url: string; title: string; detail: string };

/** "Pick back up": the pages open in this workspace (not the new tab itself),
 *  most recently read first, then pages with unfinished tasks. */
export function pickBackUp(input: {
  tabs: readonly OpenPage[];
  currentId: string;
  recent: readonly HomePage[];
  tasks: readonly HomePage[];
  limit?: number;
}): PickRow[] {
  const limit = input.limit ?? 6;
  const seenAt = new Map<string, number>();
  for (const page of input.recent) if (page.at && !seenAt.has(page.url)) seenAt.set(page.url, page.at);
  const open: PickRow[] = input.tabs
    .filter((tab) => tab.id !== input.currentId && isWeb(tab.url))
    .map((tab, i) => ({ tab, i, at: seenAt.get(tab.url) }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.i - b.i)
    .map(({ tab, at }) => ({
      kind: "tab" as const, key: `tab:${tab.id}`, tabId: tab.id, title: tab.title || hostOf(tab.url),
      detail: hostOf(tab.url), url: tab.url, favicon: tab.favicon, at,
    }));
  const openUrls = new Set(open.map((row) => row.url));
  const tasks: PickRow[] = input.tasks
    .filter((page) => isWeb(page.url) && !openUrls.has(page.url))
    .map((page) => ({
      kind: "tasks" as const, key: `tasks:${page.url}`, url: page.url, title: page.title || hostOf(page.url),
      detail: `${page.count ?? 0} unfinished ${page.count === 1 ? "task" : "tasks"}`,
    }));
  return [...open, ...tasks].slice(0, limit);
}

export interface SubjectGroup { name: string; kind: "mission" | "site"; pages: HomePage[]; span: string }

/** "Reading, by subject": the pages read lately that are not open now,
 *  grouped by what they were for. The mission a page was gathered under is
 *  its subject; otherwise its site is. Largest, then freshest, subjects first. */
export function readingBySubject(input: {
  recent: readonly HomePage[];
  candidates: readonly CandidateTab[];
  openUrls: ReadonlySet<string>;
  now: number;
  groups?: number;
  perGroup?: number;
}): SubjectGroup[] {
  const missionOf = new Map<string, string>();
  for (const tab of input.candidates) if (tab.mission && !missionOf.has(tab.url)) missionOf.set(tab.url, tab.mission);
  const byName = new Map<string, SubjectGroup>();
  const seen = new Set<string>();
  for (const page of input.recent) {
    if (!isWeb(page.url) || input.openUrls.has(page.url) || seen.has(page.url)) continue;
    seen.add(page.url);
    const mission = missionOf.get(page.url);
    const name = mission ?? hostOf(page.url);
    const key = `${mission ? "m" : "s"}:${name}`;
    const group = byName.get(key) ?? { name, kind: mission ? "mission" as const : "site" as const, pages: [], span: "" };
    group.pages.push(page);
    byName.set(key, group);
  }
  const latest = (g: SubjectGroup) => Math.max(0, ...g.pages.map((p) => p.at ?? 0));
  return [...byName.values()]
    .sort((a, b) => b.pages.length - a.pages.length || latest(b) - latest(a) || a.name.localeCompare(b.name))
    .slice(0, input.groups ?? 3)
    .map((g) => ({
      ...g,
      span: dateSpan(g.pages.map((p) => p.at ?? 0), input.now),
      pages: [...g.pages].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, input.perGroup ?? 3),
    }));
}

/** The query as a search address, for Agent search's first page. */
export function searchAddress(query: string): string {
  return `${SEARCH_URL}${encodeURIComponent(query.trim())}`;
}

/** Agent search's page-chat turn: the agent finds the right page, opens it
 *  as a tab, answers here, and offers a couple of other routes. */
export function agentSearchTurn(query: string): string {
  return `Find the best page for: ${query.trim()}\n\nOpen the most useful result as a tab, answer here from what it says, and offer a couple of other routes worth reading.`;
}

/** How many domains the never-capture list holds (comments and blanks skipped). */
export function denylistCount(text: string | null | undefined): number {
  return (text ?? "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).length;
}

/** The cap on remembered closed pages, newest first. */
export const CLOSED_PAGES_CAP = 10;

/** Remembers a closed page: newest first, one entry per address, web pages only. */
export function rememberClosed(list: readonly ClosedPage[], page: ClosedPage): ClosedPage[] {
  if (!isWeb(page.url)) return list as ClosedPage[];
  return [page, ...list.filter((p) => p.url !== page.url)].slice(0, CLOSED_PAGES_CAP);
}
