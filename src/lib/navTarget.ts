// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Where a navigation lands: a surface, and optionally a tab INSIDE it.
//
// `selectSurface` has always been the app's one surface mutator, and it takes
// exactly one thing — the surface. That is right, and this module does not
// widen it: the inner tabs of the memory and runs surfaces belong to those
// components, which persist and repair their own choice. What was missing is a
// way to ASK for one from outside, so the command palette can reach the
// Catalog or the work graph in one step instead of "go to Memory, then find
// the chip".
//
// The ask is a nonce'd request, not a controlled prop. A prop that stayed set
// would drag the surface back to that tab on every render — the user could
// never leave it — and a bare value would make "the same tab, asked for twice"
// a no-op. The nonce is the identity of the ASKING, which is the thing that
// actually happened.

export interface NavTarget {
  surface: string;
  /** A tab inside that surface. Unknown ids are ignored by the surface, which
   *  is what keeps a stale palette entry from stranding anyone. */
  tab?: string;
}

export interface TabRequest {
  tab: string;
  /** Changes on every ask, including a repeat of the same tab. */
  nonce: number;
}

export interface SurfaceTabRef {
  id: string;
  label: string;
}

/** The inner tabs a surface owns, in the order it shows them. Only the
 *  surfaces that HAVE tabs appear — the rest reach their whole content the
 *  moment they are selected, and inventing entries for them would be a longer
 *  palette saying nothing new.
 *
 *  Kept here rather than in each component because the palette needs the list
 *  without mounting the surface; each component still owns which of them is
 *  showing (and repairs an unknown persisted value on read). */
export const SURFACE_INNER_TABS: Readonly<
  Record<string, readonly SurfaceTabRef[]>
> = {
  memory: [
    { id: "ask", label: "Ask" },
    { id: "timeline", label: "Timeline" },
    { id: "catalog", label: "Catalog" },
    { id: "map", label: "Map" },
    { id: "health", label: "Health" },
  ],
  runs: [
    { id: "live", label: "Live" },
    { id: "history", label: "History" },
    { id: "work", label: "Work" },
  ],
};

export function innerTabs(surface: string): readonly SurfaceTabRef[] {
  return SURFACE_INNER_TABS[surface] ?? [];
}

/** Is this a tab the surface actually has? The surfaces use it to ignore a
 *  request from a stale palette entry rather than blank themselves. */
export function isKnownTab(surface: string, tab: string | undefined): boolean {
  if (!tab) return false;
  return innerTabs(surface).some((t) => t.id === tab);
}

/** Every place the palette can land, surface-first then its tabs. */
export function navTargets(surfaces: readonly string[]): NavTarget[] {
  const out: NavTarget[] = [];
  for (const surface of surfaces) {
    out.push({ surface });
    for (const t of innerTabs(surface)) out.push({ surface, tab: t.id });
  }
  return out;
}

export function sameTarget(a: NavTarget, b: NavTarget): boolean {
  return a.surface === b.surface && (a.tab ?? null) === (b.tab ?? null);
}
