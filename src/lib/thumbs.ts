// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Localhost dashboard's thumbnail policy, kept pure and away from the
// orchestrator that acts on it. Capturing a page is expensive and visible — one
// webview parks over one card at a time for a second or two — so WHICH card
// goes next, and whether one goes at all, is the part worth being able to test
// exhaustively without a browser.

/** A thumbnail is re-captured once it is this old. Long enough that idly
 *  sitting on the surface doesn't churn the queue, short enough that a card
 *  doesn't show yesterday's page after you've rebuilt the app. */
export const THUMB_STALE_MS = 10 * 60 * 1000;

/** After a failed capture, leave that card alone for this long. Without it a
 *  page that can't be snapshotted (a server that 500s, an app that never
 *  finishes hydrating) would be retried forever, and every retry parks a
 *  webview over the grid for seconds. */
export const THUMB_FAIL_COOLDOWN_MS = 5 * 60 * 1000;

/** What the FIRST capture multiplies the card's CSS width by when asking WebKit
 *  for a snapshot. Deliberately 1, the conservative end: `snapshotWidth` is
 *  documented as points and the image is backed at the display's scale, so on a
 *  retina screen a request for 280 already yields 560 real pixels. Guessing 2
 *  here would quietly write 4×-oversized files on the most common setup. After
 *  the first capture reports its true dimensions, `calibrateScale` takes over. */
export const INITIAL_THUMB_SCALE = 1;

/** Learn the right multiplier from a capture that actually happened.
 *
 *  We asked for `requestedWidth` points and got `pixelWidth` real pixels, so
 *  their ratio IS the system's backing scale — no need to know whether WebKit
 *  applies it. From there the target is simple: a thumbnail should be exactly as
 *  sharp as the display it's shown on, i.e. `cssWidth × devicePixelRatio`
 *  pixels. Clamped, and falling back to 1 on any nonsense input, so a strange
 *  reading can never inflate every subsequent capture. */
export function calibrateScale(
  requestedWidth: number,
  pixelWidth: number,
  devicePixelRatio: number,
): number {
  if (!(requestedWidth > 0) || !(pixelWidth > 0) || !(devicePixelRatio > 0)) {
    return 1;
  }
  const backing = pixelWidth / requestedWidth;
  if (!Number.isFinite(backing) || backing <= 0) return 1;
  return Math.min(3, Math.max(1, devicePixelRatio / backing));
}

/** A card that wants a thumbnail. */
export interface ThumbTarget {
  key: string;
  /** Only running servers are captured — a dead one has no page to load, and
   *  its last thumbnail is exactly what we want to keep showing. */
  live: boolean;
}

/** A thumbnail file on disk, as `thumbs_list` reports it. */
export interface ThumbEntry {
  key: string;
  path: string;
  modifiedMs: number;
}

/** FNV-1a (32-bit), rendered as 8 lowercase hex digits. A path needs to become
 *  a short filename-safe token; this is deterministic, dependency-free, and
 *  collision-resistant enough for a per-user thumbnail cache. */
export function fnv1a32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // Multiply by the 16777619 prime with 32-bit wraparound.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The filename a card's thumbnail lives under. The port stays readable so the
 *  directory can be eyeballed; the path is hashed because it isn't
 *  filename-safe. Charset is a strict subset of what Rust's `valid_key`
 *  accepts — the two are a pair, and this is the side that must stay inside. */
export function thumbKey(projectPath: string, port: number): string {
  return `p${port}-${fnv1a32Hex(projectPath)}`;
}

/** The capture queue, in the order it should run.
 *
 *  Missing thumbnails come first, in grid order, because an empty card is the
 *  only state that looks broken. Refreshes follow, oldest first, so the most
 *  out-of-date picture is the one that gets fixed if the user leaves before the
 *  queue drains. Cards inside their failure cooldown are excluded outright. */
export function planCaptures(
  targets: ThumbTarget[],
  entries: Map<string, ThumbEntry>,
  failures: Map<string, number>,
  now: number,
): string[] {
  const missing: string[] = [];
  const stale: { key: string; modifiedMs: number }[] = [];
  for (const t of targets) {
    if (!t.live) continue;
    const failedAt = failures.get(t.key);
    if (failedAt !== undefined && now - failedAt < THUMB_FAIL_COOLDOWN_MS) {
      continue;
    }
    const entry = entries.get(t.key);
    if (!entry) {
      missing.push(t.key);
    } else if (now - entry.modifiedMs >= THUMB_STALE_MS) {
      stale.push({ key: t.key, modifiedMs: entry.modifiedMs });
    }
  }
  stale.sort((a, b) => a.modifiedMs - b.modifiedMs);
  return [...missing, ...stale.map((s) => s.key)];
}

/** What a card shows before (or instead of) a real screenshot. */
export interface Placeholder {
  /** A lucide icon name the card maps to a component. */
  glyph: "zap" | "hexagon" | "file-code" | "cog" | "server";
  /** A theme variable, so placeholders re-tint with everything else. */
  tint: string;
  /** Big letter behind the glyph — the fastest way to tell two cards apart. */
  initial: string;
}

/** A deterministic, stack-tinted placeholder. Used for a card never captured
 *  yet, a dead server with no stored picture, a failed capture, and every card
 *  on a platform without the native snapshot path. Deterministic matters: the
 *  same project must not change color between renders. */
export function placeholderFor(stack: string, projectName: string): Placeholder {
  const s = stack.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => s.includes(n));
  let glyph: Placeholder["glyph"] = "server";
  let tint = "var(--color-ink-muted)";
  if (has("next", "vite", "astro", "remix", "cra", "react")) {
    glyph = "zap";
    tint = "var(--color-info)";
  } else if (has("node", "express")) {
    glyph = "hexagon";
    tint = "var(--color-success)";
  } else if (has("python", "django", "flask")) {
    glyph = "file-code";
    tint = "var(--color-warning)";
  } else if (has("rust", "cargo", "go ", "golang")) {
    glyph = "cog";
    tint = "var(--color-ink)";
  }
  // First letter that actually reads as one — a scoped package like
  // "@acme/web" should show W, not @.
  const initial =
    (projectName.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  return { glyph, tint, initial };
}
