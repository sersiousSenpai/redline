// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Harness mode (program A5) — enter another product built ON Redline without
// leaving the binary. A harness is DATA: a manifest whose `workspace` block
// is the same shape as ~/.redline/workspace.json, so the existing composition
// functions (headerSurfaces, surfaceEnabled, initialSurface) run on it
// unchanged. One mechanism, two entry points: the user enters from the Front
// Door and can exit; a flavored build (REDLINE_HARNESS baked at compile time)
// enters at boot with the exit hidden — the standalone flavor is a degenerate
// case of this module, never a second code path.
//
// This module is PURE composition + localStorage. It deliberately never
// imports `invoke`: entering or exiting a harness recomposes the UI and can
// never reach the daemon — which is what makes a held ExitPlanMode plan
// structurally unstrandable by harness mode (harness.test.ts pins both the
// import ban and the composition invariants).
//
// Why localStorage and not workspace.json: ~/.redline is resolved from HOME
// and therefore SHARED across build flavors, while the WebKit data store is
// identifier-scoped and therefore splits per flavor — exactly the split the
// store-collision rule demands ("the build says which harness; user state
// must never redirect a different flavor's boot"). It is also synchronously
// readable, which is what lets the first React render compose the harness
// header with no stock-header flash (the same pre-paint trick as the theme
// cache in index.html).

import type { MainSurface } from "./mainSurface";
import {
  MAIN_SURFACE_DESCRIPTORS,
  headerSurfaces,
  type SurfaceDescriptor,
  type Workspace,
} from "../config/workspace";

/** A parsed harness manifest. `workspace` is workspace.json's shape — the
 *  harness's DEFAULT arrangement; the user's own arrangement layers over it
 *  (see harnessWorkspace). `labels` rebrands header entries for surfaces this
 *  build already ships; unknown surface ids are carried but never rendered
 *  (a manifest naming a surface Redline can't render must degrade, not
 *  crash — invariant #9: the moment a harness needs code Redline doesn't
 *  have, it's a fork). `theme` is RESERVED: carried through untouched, not
 *  read — theme stays a user preference on its own persistence track (open
 *  decision 8, deferred). Unknown keys survive round-trips, like the
 *  workspace manifest itself. */
export interface HarnessManifest {
  id: string;
  name: string;
  version?: number;
  workspace: Workspace;
  labels?: Record<string, { label?: string; title?: string }>;
  hero?: { eyebrow?: string; title?: string; sub?: string };
  [key: string]: unknown;
}

/** How the harness was entered. `"user"` shows the exit affordance;
 *  `"boot"` hides it — a flavored build IS its harness, there is no
 *  Redline underneath to exit to. */
export type HarnessEntry = "user" | "boot";

export interface ActiveHarness {
  manifest: HarnessManifest;
  entry: HarnessEntry;
  /** Where exit lands — the surface the user stood on when they entered.
   *  Validated against the stock manifest at exit time, not stored blindly
   *  trusted. */
  returnSurface?: string;
}

/** The exit affordance is derived, never stored as its own bit. */
export function exitHidden(active: ActiveHarness): boolean {
  return active.entry === "boot";
}

// ---- Parsing ----------------------------------------------------------------

/** Lenient parse in the workspace tradition: bad JSON, a non-object, or a
 *  missing id/name yield null (the harness is simply not offered), never an
 *  error dialog. A malformed `workspace` block degrades to {} — the harness
 *  still enters, showing the stock surface set under its own name. */
export function parseHarnessManifest(
  text: string | null | undefined,
): HarnessManifest | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const id = obj.id;
  const name = obj.name;
  if (typeof id !== "string" || !id.trim()) return null;
  if (typeof name !== "string" || !name.trim()) return null;
  const ws = obj.workspace;
  const workspace: Workspace =
    typeof ws === "object" && ws !== null && !Array.isArray(ws)
      ? (ws as Workspace)
      : {};
  const rawLabels = obj.labels;
  const labels: HarnessManifest["labels"] =
    typeof rawLabels === "object" && rawLabels !== null && !Array.isArray(rawLabels)
      ? (rawLabels as HarnessManifest["labels"])
      : undefined;
  const rawHero = obj.hero;
  const hero: HarnessManifest["hero"] =
    typeof rawHero === "object" && rawHero !== null && !Array.isArray(rawHero)
      ? (rawHero as HarnessManifest["hero"])
      : undefined;
  return {
    ...obj,
    id: id.trim(),
    name: name.trim(),
    workspace,
    labels,
    hero,
  } as HarnessManifest;
}

// ---- First-party harnesses --------------------------------------------------

/** Harnesses compiled into this build as data — plan decision 4's shape
 *  ("ships first as a build of the Redline codebase with its content
 *  compiled in as a first-party default"; the installable-pack retrofit is
 *  A5a's). The Writing Desk is the mechanism's living fixture: it removes
 *  surfaces, reorders and relabels the header, moves the landing, and swaps
 *  the hero — every axis a real vertical will pull on. */
export const FIRST_PARTY_HARNESSES: readonly HarnessManifest[] = [
  {
    id: "writing-desk",
    name: "Writing Desk",
    version: 1,
    workspace: {
      surfaces: {
        browser: false,
        review: false,
        servers: false,
        runs: false,
        collab: false,
        memory: false,
      },
      header: { order: ["document", "drafter"] },
      landing: "drafter",
    },
    labels: {
      drafter: { label: "Desk", title: "Your writing desk" },
    },
    hero: {
      eyebrow: "Writing Desk",
      title: "Every document starts as a draft.",
      sub: "Draft it. Redline it. Then send it.",
    },
  },
];

/** One row Redline offers on the Front Door / palette. */
export interface HarnessSummary {
  id: string;
  name: string;
}

/** The offerable set: first-party fixtures plus the installed manifests
 *  (`~/.redline/harnesses/<id>/harness.json`, via list_harnesses). An
 *  installed harness shadows a first-party one with the same id — a firm
 *  iterating on a copy of a shipped harness sees THEIR copy. */
export function resolveHarnesses(
  installedJson: readonly { id: string; json: string }[],
): HarnessManifest[] {
  const byId = new Map<string, HarnessManifest>();
  for (const m of FIRST_PARTY_HARNESSES) byId.set(m.id, m);
  for (const entry of installedJson) {
    const parsed = parseHarnessManifest(entry.json);
    // The directory name is identity; a manifest claiming a different id
    // than its folder is confused, and leniency says skip it, not trust it.
    if (parsed && parsed.id === entry.id) byId.set(parsed.id, parsed);
  }
  return [...byId.values()];
}

// ---- Composition ------------------------------------------------------------

/** The workspace harness mode runs on: the harness's default arrangement
 *  with the user's own per-harness delta over it ("the manifest says how the
 *  user arranged it"). Nested keys merge shallowly per block, the same
 *  precedence workspace.json's own updaters use. */
export function harnessWorkspace(
  manifest: HarnessManifest,
  delta?: Workspace | null,
): Workspace {
  const base = manifest.workspace;
  if (!delta) return base;
  return {
    ...base,
    ...delta,
    surfaces: { ...base.surfaces, ...delta.surfaces },
    header: {
      ...base.header,
      ...delta.header,
    },
  };
}

/** headerSurfaces with the harness's labels over the built-in descriptors.
 *  Ids never come from the manifest here — headerSurfaces already filters to
 *  the surfaces this build can render; labels only rebrand what survived. */
export function harnessHeaderSurfaces(
  ws: Workspace,
  manifest: HarnessManifest,
): SurfaceDescriptor[] {
  const labels = manifest.labels ?? {};
  return headerSurfaces(ws).map((d) => {
    const over = labels[d.id];
    if (!over) return d;
    return {
      ...d,
      label: typeof over.label === "string" && over.label ? over.label : d.label,
      title: typeof over.title === "string" && over.title ? over.title : d.title,
    };
  });
}

/** The descriptor a relabeled surface would show even when absent from the
 *  header (tooltips, panels). Falls back to the stock descriptor set. */
export function harnessDescriptor(
  manifest: HarnessManifest | null,
  id: MainSurface,
): SurfaceDescriptor | undefined {
  const base = MAIN_SURFACE_DESCRIPTORS.find((d) => d.id === id);
  if (!base || !manifest) return base;
  const over = manifest.labels?.[id];
  if (!over) return base;
  return {
    ...base,
    label: typeof over.label === "string" && over.label ? over.label : base.label,
    title: typeof over.title === "string" && over.title ? over.title : base.title,
  };
}

// ---- Persistence (localStorage — flavor-split, synchronous) -----------------

/** The active harness, manifest included: the first render composes from
 *  this cache with no async read, which is the no-stock-header-flash fix.
 *  The boot effect then re-resolves the manifest from its source and
 *  refreshes (or clears) the cache — the file/fixture stays the truth, the
 *  cache is a paint hint, exactly the theme-cache contract. */
export const ACTIVE_HARNESS_KEY = "redline.harness.active";
/** Per-harness user arrangement, keyed by harness id. */
const ARRANGEMENT_PREFIX = "redline.harness.ws.";

export function readActiveHarness(storage: Storage): ActiveHarness | null {
  try {
    const raw = storage.getItem(ACTIVE_HARNESS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const manifest = parseHarnessManifest(JSON.stringify(obj.manifest));
    if (!manifest) return null;
    return {
      manifest,
      entry: obj.entry === "boot" ? "boot" : "user",
      returnSurface:
        typeof obj.returnSurface === "string" ? obj.returnSurface : undefined,
    };
  } catch {
    return null;
  }
}

export function storeActiveHarness(
  storage: Storage,
  active: ActiveHarness | null,
): void {
  try {
    if (active) {
      storage.setItem(ACTIVE_HARNESS_KEY, JSON.stringify(active));
    } else {
      storage.removeItem(ACTIVE_HARNESS_KEY);
    }
  } catch {
    /* storage unavailable — mode still works for this run */
  }
}

export function readHarnessArrangement(
  storage: Storage,
  harnessId: string,
): Workspace {
  try {
    const raw = storage.getItem(ARRANGEMENT_PREFIX + harnessId);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Workspace;
  } catch {
    return {};
  }
}

export function storeHarnessArrangement(
  storage: Storage,
  harnessId: string,
  delta: Workspace,
): void {
  try {
    storage.setItem(ARRANGEMENT_PREFIX + harnessId, JSON.stringify(delta));
  } catch {
    /* storage unavailable — the arrangement lives for this run only */
  }
}
