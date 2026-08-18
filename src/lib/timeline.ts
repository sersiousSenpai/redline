// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Pure reducers behind the Memory surface's Timeline: the wire shapes of the
// `ledger_query` / `context_stats` commands, the grouping modes (day / session
// / trail / class), and the trail derivation from §1.5 of the second-brain
// plan — return counts and depth are computed here from rows already on disk,
// never inferred and never stored. Kept dependency-free and side-effect-free
// so the windowed list's math is unit-testable without a DOM (the
// `virtual.ts` discipline).

import type { LedgerEvent } from "./ledgerKinds";

/** Mirror of `context::TimelineItem` (the event row flattened + provenance). */
export interface TimelineItem extends LedgerEvent {
  surface: string | null;
  projectPath: string | null;
  threadKind: string | null;
  model: string | null;
  preview: string | null;
  /** Full character count the preview was clipped from, so the row's "…" is
   *  honest without shipping the bytes it stands for. */
  bodyChars: number | null;
  /** What kind of text this is — `user` (a human typed it), `agent` (Redline
   *  constructed it), `system` (the CLI injected it). `null` for a non-prompt
   *  event. */
  role: string | null;
  compacted: boolean;
  browseId: string | null;
  url: string | null;
  title: string | null;
  action: string | null;
  fromEventId: number | null;
  /** The picture of this page, when there is one. `null` covers three real
   *  states — never captured, policy-denied, forgotten — so it is stored on
   *  the row rather than derived from the content hash. */
  shotKey: string | null;
  /** A vision-tier description, for a page whose text didn't capture. */
  caption: string | null;
  classNodeId: string | null;
  classTitle: string | null;
  /** P3: this event is starred (directly, or a `note` event whose row is). */
  starred: boolean;
  /** Current text of the note ON this event — the detail rail's editor seed. */
  note: string | null;
}

/** Mirror of `context::LedgerFilters` (every axis optional, ANDed). */
export interface LedgerFilters {
  kind?: string;
  author?: string;
  sessionId?: string;
  surface?: string;
  project?: string;
  q?: string;
  sinceTs?: number;
  untilTs?: number;
  beforeSeq?: number;
  limit?: number;
  /** P3 star/note facets — only `true` filters (the chips toggle on/off). */
  starred?: boolean;
  noted?: boolean;
  /** P4 citation focus — exact seqs (the Ask tab's `#seq` chips). */
  seqs?: number[];
  /** P4 citation focus — events filed under one accepted class node. */
  classNode?: string;
  /** P5 Map focus — prompts recorded on one agent thread. */
  threadId?: string;
  /** P5 Map focus — one browse tab's trail. */
  browseId?: string;
  /** Corpus role. The Timeline defaults this to `user`, which is what makes
   *  the reclassification visible rather than merely done: 92.6% of the lake's
   *  bytes were Redline's own agent text and the CLI's injections, sharing a
   *  list with the user's prompts. Flipping the chip shows them. */
  role?: string;
}

/** The corpus-role facet's three values, in the order the chips render. `user`
 *  is the default view — the lake exists to hold what the user said. */
export const CORPUS_ROLES = ["user", "agent", "system"] as const;
export type CorpusRole = (typeof CORPUS_ROLES)[number];

/** What each role chip means, in the user's terms rather than the schema's. */
export const CORPUS_ROLE_LABEL: Record<CorpusRole, string> = {
  user: "Yours",
  agent: "Redline's",
  system: "System",
};

export const CORPUS_ROLE_HINT: Record<CorpusRole, string> = {
  user: "Prompts you typed — the record's signal",
  agent: "Prompts Redline constructed for its own agents",
  system: "Task notifications and reminders the CLI injected",
};

/** How many bytes of the corpus are NOT the user's own words. Pure. */
export function machineBytes(
  roles: { role: string; bytes: number; rows?: number }[] | undefined,
): number {
  if (!roles) return 0;
  return roles
    .filter((r) => r.role !== "user")
    .reduce((sum, r) => sum + r.bytes, 0);
}

/** The one-time banner's sentence, or `null` when there is nothing to say.
 *
 *  Shown once, because the reclassification happened once and a permanent
 *  banner is just chrome. It states the amount, states plainly that nothing
 *  was deleted, and points at the control that reveals it — a change this
 *  large to what a search returns should not be discovered by noticing that
 *  results look different. */
export function corpusBannerText(
  roles: { role: string; bytes: number; rows?: number }[] | undefined,
  fmt: (bytes: number) => string,
): string | null {
  const machine = machineBytes(roles);
  // Below a megabyte there is nothing worth interrupting anyone about.
  if (machine < 1_000_000) return null;
  return `${fmt(machine)} of Redline's own agent text and system notifications was reclassified out of your searchable history. Nothing was deleted — use “Whose words” to see it.`;
}

/** A jump into the Timeline from the Ask tab (citation chips) or the Map (a
 *  node click — §3 rule 4): exact ledger seqs, one accepted class node, a plan
 *  session, an agent thread, or a browse tab — exactly one axis set. `label`
 *  is what the Timeline's dismissible focus strip shows. */
export interface TimelineFocus {
  seqs?: number[];
  classNodeId?: string;
  sessionId?: string;
  threadId?: string;
  browseId?: string;
  label: string;
}

/** Mirror of `context::ContextStats` (tuple axes serialize as arrays). */
export interface ContextStats {
  generatedTs: number;
  totalPrompts: number;
  totalEvents: number;
  byDay: [string, number][];
  bySurface: [string, number][];
  byKind: [string, number][];
  byClass: [string, number][];
  byAuthor: [string, number][];
}

export type Grouping = "day" | "session" | "trail" | "class";

export const GROUPINGS: readonly Grouping[] = ["day", "session", "trail", "class"];

export const GROUPING_LABEL: Record<Grouping, string> = {
  day: "Day",
  session: "Session",
  trail: "Trail",
  class: "Class",
};

/** One windowed list row — group headers and events share the row stream so
 *  a single `visibleRange` covers both. */
export type TimelineRow =
  | { type: "header"; key: string; label: string; count: number; meta: string | null }
  | { type: "event"; key: string; item: TimelineItem };

/** Local-time day key, "2026-08-03". */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** "Aug 3" for a `dayKey`. Parsed piecewise so the label stays in local time. */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Inclusive local-midnight ms bounds for a `dayKey` — the ribbon's filter. */
export function dayBounds(key: string): { sinceTs: number; untilTs: number } {
  const [y, m, d] = key.split("-").map(Number);
  const sinceTs = new Date(y, (m || 1) - 1, d || 1).getTime();
  return { sinceTs, untilTs: sinceTs + 86_400_000 - 1 };
}

/** One browsing trail: a tab's content-distinct page sequence. `returnCount`
 *  counts re-entries to a URL already visited in this trail (the row exists
 *  only when the content changed, so this is content-distinct re-entries per
 *  tab, NOT raw visits); `depth` is the longest `fromEventId` edge chain. Both
 *  are views over recorded acts — nothing here is inferred (§1.4). */
export interface Trail {
  browseId: string;
  /** Oldest-first — the page sequence as it was walked. */
  events: TimelineItem[];
  pageCount: number;
  returnCount: number;
  depth: number;
}

/** Derive trails from a page of items (browse events only), ranked by return
 *  count then depth then recency — the screen that shows what to capture next. */
export function deriveTrails(items: TimelineItem[]): Trail[] {
  const byTab = new Map<string, TimelineItem[]>();
  for (const it of items) {
    if (it.kind !== "browse_event" || !it.browseId) continue;
    const list = byTab.get(it.browseId);
    if (list) list.push(it);
    else byTab.set(it.browseId, [it]);
  }
  const trails: Trail[] = [];
  for (const [browseId, events] of byTab) {
    const asc = events.slice().sort((a, b) => a.seq - b.seq);
    // Return count: a URL seen again later in the same trail.
    const seen = new Set<string>();
    let returnCount = 0;
    for (const e of asc) {
      const u = e.url ?? "";
      if (seen.has(u)) returnCount += 1;
      else seen.add(u);
    }
    // Depth: longest chain of trail edges (browse row id ← fromEventId).
    const byRowId = new Map<string, TimelineItem>();
    for (const e of asc) if (e.refId != null) byRowId.set(e.refId, e);
    const depthOf = new Map<string, number>();
    const chainDepth = (e: TimelineItem, visiting: Set<string>): number => {
      const id = e.refId ?? "";
      const cached = depthOf.get(id);
      if (cached != null) return cached;
      let d = 1;
      const from = e.fromEventId != null ? String(e.fromEventId) : null;
      if (from && byRowId.has(from) && !visiting.has(id)) {
        visiting.add(id);
        d = 1 + chainDepth(byRowId.get(from)!, visiting);
        visiting.delete(id);
      }
      depthOf.set(id, d);
      return d;
    };
    let depth = 0;
    for (const e of asc) depth = Math.max(depth, chainDepth(e, new Set()));
    trails.push({ browseId, events: asc, pageCount: asc.length, returnCount, depth });
  }
  trails.sort(
    (a, b) =>
      b.returnCount - a.returnCount ||
      b.depth - a.depth ||
      (b.events[b.events.length - 1]?.ts ?? 0) - (a.events[a.events.length - 1]?.ts ?? 0),
  );
  return trails;
}

function pushBucketRows(
  rows: TimelineRow[],
  key: string,
  label: string,
  meta: string | null,
  events: TimelineItem[],
): void {
  rows.push({ type: "header", key: `h:${key}`, label, count: events.length, meta });
  for (const it of events) rows.push({ type: "event", key: `e:${it.seq}`, item: it });
}

/**
 * Flatten a (newest-first) page of items into windowed list rows for a
 * grouping mode. Buckets preserve newest-first order except trails, which
 * rank by returns/depth and read oldest-first inside (the walked sequence).
 * "Session" degrades unthreaded events (86% of the historical lake) into one
 * labeled bucket rather than looking broken; "class" does the same for
 * unfiled events. Pure; never mutates `items`.
 */
export function groupItems(items: TimelineItem[], grouping: Grouping): TimelineRow[] {
  const rows: TimelineRow[] = [];
  if (grouping === "day") {
    let run: TimelineItem[] = [];
    let runKey: string | null = null;
    const flush = () => {
      if (runKey != null && run.length) {
        pushBucketRows(rows, runKey, dayLabel(runKey), null, run);
      }
      run = [];
    };
    for (const it of items) {
      const k = dayKey(it.ts);
      if (k !== runKey) {
        flush();
        runKey = k;
      }
      run.push(it);
    }
    flush();
    return rows;
  }
  if (grouping === "trail") {
    for (const t of deriveTrails(items)) {
      const first = t.events[0];
      const label = first?.title || first?.url || t.browseId;
      const meta = `${t.pageCount} page${t.pageCount === 1 ? "" : "s"} · ${t.returnCount} return${
        t.returnCount === 1 ? "" : "s"
      } · depth ${t.depth}`;
      pushBucketRows(rows, t.browseId, label, meta, t.events);
    }
    return rows;
  }
  // session / class: bucket in first-seen (newest-first) order.
  const buckets = new Map<string, { label: string; meta: string | null; events: TimelineItem[] }>();
  for (const it of items) {
    const [key, label, meta] =
      grouping === "session"
        ? it.sessionId
          ? [it.sessionId, it.sessionId.slice(0, 8), it.threadKind]
          : ["~unthreaded", "Unthreaded", "no session recorded"]
        : it.classTitle
          ? [`c:${it.classNodeId}`, it.classTitle, null]
          : ["~unfiled", "Unfiled", "not in the catalog yet"];
    const b = buckets.get(key);
    if (b) b.events.push(it);
    else buckets.set(key, { label, meta: meta ?? null, events: [it] });
  }
  for (const [key, b] of buckets) pushBucketRows(rows, key, b.label, b.meta, b.events);
  return rows;
}

/** "12.3 KB" / "4.1 MB" for Health's reclaimed-bytes line. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
