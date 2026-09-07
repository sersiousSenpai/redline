// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// "While you were away" — what the work graph did since the user last looked.
//
// The overnight queue runs at 3am, a moot reaches a verdict, an intake arrives
// from a share. All three land in the work graph with nobody watching, and the
// only way to find out was to go to the Runs surface and read the graph. The
// Companion is the conversation that spans the app, so it is where the news
// belongs — and because the Companion is now reachable from every surface, the
// news reaches the user wherever they happen to be.
//
// `work_since` (work.rs) does the reading; this module owns the two decisions
// around it: what the watermark is, and how a pile of rows becomes a sentence.

/** One `work::AwayCard`, over the wire. */
export interface AwayCard {
  /** `arrived` | `closed` | `moot`. Widened: an older frontend reading a newer
   *  backend must show an unfamiliar card, not drop it. */
  kind: string;
  itemId: string;
  title: string;
  detail: string | null;
  at: number;
}

export const AWAY_SEEN_KEY = "redline.companion.seenAt";

/**
 * The watermark: when the user last acknowledged the feed.
 *
 * Seeded on first read and never before — a fresh install (or a first-ever
 * open) must not be greeted with a feed of its entire history, which is not
 * news, it is an archive. Returns null in exactly that case, meaning "ask for
 * nothing this time".
 */
export function takeAwayWatermark(
  storage: Storage,
  now: number,
): number | null {
  // The parse is guarded SEPARATELY from the storage access. Folding the two
  // together let a corrupt value throw past the re-seed, which left the mark
  // corrupt forever and the feed silently switched off for good — the failure
  // mode a repair-on-read app is supposed to make impossible.
  let seen = NaN;
  try {
    const raw = storage.getItem(AWAY_SEEN_KEY);
    if (raw != null) seen = Number(JSON.parse(raw));
  } catch {
    /* unreadable or unparseable — treat it as no mark and re-seed below */
  }
  if (Number.isFinite(seen) && seen > 0) return seen;
  try {
    storage.setItem(AWAY_SEEN_KEY, JSON.stringify(now));
  } catch {
    /* storage unavailable — no watermark, so no feed */
  }
  return null;
}

/** Acknowledge everything up to `now`. */
export function markAwaySeen(storage: Storage, now: number): void {
  try {
    storage.setItem(AWAY_SEEN_KEY, JSON.stringify(now));
  } catch {
    /* storage unavailable — the feed simply reappears */
  }
}

export interface AwaySummary {
  total: number;
  arrived: number;
  closed: number;
  moot: number;
  /** One line, for the strip's header. Empty when there is nothing to say. */
  headline: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The pile as a sentence, in the order that matters: what FINISHED first (the
 * thing you'd want to know before you start), then what arrived, then what was
 * argued about. Kinds this build doesn't recognize still count toward `total`,
 * so the header can never claim less happened than the list shows.
 */
export function summarizeAway(cards: AwayCard[]): AwaySummary {
  const count = (k: string) => cards.filter((c) => c.kind === k).length;
  const closed = count("closed");
  const arrived = count("arrived");
  const moot = count("moot");
  const parts: string[] = [];
  if (closed) parts.push(`${plural(closed, "item")} closed`);
  if (arrived) parts.push(`${plural(arrived, "new item")} arrived`);
  if (moot) parts.push(`${plural(moot, "moot turn")}`);
  const known = closed + arrived + moot;
  const other = cards.length - known;
  if (other > 0) parts.push(`${plural(other, "update")}`);
  return {
    total: cards.length,
    arrived,
    closed,
    moot,
    headline: parts.join(" · "),
  };
}

/** How many rows the strip shows before it starts counting. A feed above a
 *  conversation is a glance, not a list — the Runs surface is the list. */
export const AWAY_VISIBLE = 5;

export function visibleAway(
  cards: AwayCard[],
  max = AWAY_VISIBLE,
): { shown: AwayCard[]; more: number } {
  if (cards.length <= max) return { shown: cards, more: 0 };
  return { shown: cards.slice(0, max), more: cards.length - max };
}

/** The muted second line on a card: what kind of event, and its one detail. */
export function awayCardLine(card: AwayCard): string {
  const label =
    card.kind === "closed"
      ? "Closed"
      : card.kind === "arrived"
        ? "Arrived"
        : card.kind === "moot"
          ? "Moot"
          : card.kind;
  const detail = card.detail?.trim();
  return detail ? `${label} — ${detail}` : label;
}
