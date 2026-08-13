// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The workspace manifest — `~/.redline/workspace.json` — is what makes one
// person's build a different artifact from a stranger's built from the same
// source: which surfaces exist, how the header composes, where the app lands
// on launch. GUI–file duality governs this module: the file is the store and
// the GUI is a lens on it. Every customization gesture (right-click-hide a
// header button, reorder, pick a landing surface) rewrites the file; a power
// user editing the file by hand gets exactly the same result on next launch.
// The file is created lazily on the first gesture — an untouched install has
// no manifest and MUST behave byte-identically to today's hardcoded UI (the
// snapshot tests below the fold pin that).
//
// Parsing is lenient in the user-theme tradition: malformed JSON or unknown
// values degrade to defaults, never to an error dialog. Unknown keys are
// PRESERVED on rewrite (updaters spread-copy), so a hand-annotated or
// future-versioned file survives a GUI gesture.

import type { MainSurface } from "../lib/mainSurface";
import type { CanonicalOverrides } from "../lib/paneLayout";

/** Surfaces a manifest can disable. Main surfaces (minus the document — the
 *  core pane is not removable) plus the auxiliary ones the header composes. */
export type ToggleableSurface =
  | "browser"
  | "drafter"
  | "review"
  | "servers"
  | "runs"
  | "voice"
  | "collab"
  | "memory";

// "companion" is gone from this list on purpose: the Companion's scope merged
// into the voice agent (the Voice toggle covers the whole discussion surface
// now). A stored manifest that still carries a `companion` key is simply
// ignored by lookups.
export const TOGGLEABLE_SURFACES: readonly ToggleableSurface[] = [
  "browser",
  "drafter",
  "review",
  "servers",
  "runs",
  "voice",
  "collab",
  "memory",
];

/** One header/main surface the registry can compose. `label`/`title` carry the
 *  exact strings the header rendered before the registry existed. */
export interface SurfaceDescriptor {
  id: MainSurface;
  label: string;
  title: string;
}

/** The main-pane radio group, in default order. This IS today's hardcoded
 *  header tuple, relocated — the snapshot test pins it. Deliberately NOT
 *  every `MainSurface`: memory's entry is the ambient header pill — surfaces
 *  earn a permanent header button only when they're a daily destination, not
 *  per feature shipped. Runs earned its entry when the cross-project Work tab
 *  moved in (a destination you visit without a live run); the run chip stays
 *  as the contextual entry. */
export const MAIN_SURFACE_DESCRIPTORS: readonly SurfaceDescriptor[] = [
  { id: "document", label: "Document", title: "Show the document" },
  { id: "browser", label: "Browser", title: "Switch to the browser" },
  { id: "drafter", label: "Prompt Drafter", title: "Draft a new prompt" },
  { id: "review", label: "Code Review", title: "Review code changes" },
  { id: "servers", label: "Localhost", title: "See your local dev servers" },
  { id: "runs", label: "Runs", title: "Monitor runs and the work graph" },
];

/** Human-readable names for the surface checkboxes and context menus. */
export const SURFACE_LABELS: Record<ToggleableSurface, string> = {
  browser: "Browser",
  drafter: "Prompt Drafter",
  review: "Code Review",
  servers: "Localhost",
  runs: "Runs",
  voice: "Voice",
  collab: "Live Session",
  memory: "Memory",
};

/** `"last"` = land wherever the previous run ended (today's behavior). */
export type Landing = "last" | MainSurface;

/** The parsed manifest. All fields optional — an empty object is a valid
 *  manifest meaning "all defaults". The index signature carries unknown keys
 *  through a read-modify-write untouched. */
export interface Workspace {
  version?: number;
  /** Missing key = enabled. Only an explicit `false` disables. */
  surfaces?: Record<string, boolean>;
  header?: { order?: string[] };
  landing?: string;
  /** Per-project overrides keyed by absolute project path. */
  projects?: Record<string, { landing?: string }>;
  /** Optional snap-back target overrides in px, e.g.
   *  `{"layout": {"sidebar": 280, "discussion": 360, "terminal": 300}}`.
   *  Read leniently field-by-field — see workspaceLayout. */
  layout?: { sidebar?: number; discussion?: number; terminal?: number };
  [key: string]: unknown;
}

const MAIN_SURFACE_IDS = MAIN_SURFACE_DESCRIPTORS.map((d) => d.id);

function isMainSurface(v: unknown): v is MainSurface {
  return (
    typeof v === "string" && (MAIN_SURFACE_IDS as string[]).includes(v)
  );
}

function isLanding(v: unknown): v is Landing {
  return v === "last" || isMainSurface(v);
}

/** The manifest an untouched install behaves as (and the explicit file the
 *  first customization gesture writes — fully spelled out so the file itself
 *  teaches the format). */
export function defaultWorkspace(): Workspace {
  return {
    version: 1,
    landing: "last",
    surfaces: Object.fromEntries(
      TOGGLEABLE_SURFACES.map((s) => [s, true]),
    ),
    header: { order: [...MAIN_SURFACE_IDS] },
  };
}

/** Lenient parse: null/missing/bad JSON/non-object → defaults. A valid object
 *  is taken as-is (absent fields mean their defaults at read time). */
export function parseWorkspace(text: string | null | undefined): Workspace {
  if (!text) return defaultWorkspace();
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return defaultWorkspace();
    }
    return parsed as Workspace;
  } catch {
    return defaultWorkspace();
  }
}

export function serializeWorkspace(ws: Workspace): string {
  return JSON.stringify(ws, null, 2) + "\n";
}

/** Only an explicit `false` disables — so a manifest that predates a surface
 *  leaves the new surface on. */
export function surfaceEnabled(ws: Workspace, id: ToggleableSurface): boolean {
  return ws.surfaces?.[id] !== false;
}

/** The main-pane radio group the header should render: manifest order,
 *  unknown names dropped, duplicates collapsed, the document guaranteed
 *  (prepended if a hand-edit removed it), surfaces missing from the order
 *  appended in default order (so a manifest written before a surface existed
 *  still shows it), disabled surfaces filtered out. */
export function headerSurfaces(ws: Workspace): SurfaceDescriptor[] {
  const order = (ws.header?.order ?? MAIN_SURFACE_IDS).filter(isMainSurface);
  const seen = new Set<MainSurface>();
  const ordered: MainSurface[] = [];
  for (const id of order) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of MAIN_SURFACE_IDS) {
    if (!seen.has(id)) ordered.push(id);
  }
  if (ordered[0] !== "document" && !ordered.includes("document")) {
    ordered.unshift("document");
  }
  return ordered
    .filter(
      (id) => id === "document" || surfaceEnabled(ws, id as ToggleableSurface),
    )
    .map((id) => MAIN_SURFACE_DESCRIPTORS.find((d) => d.id === id)!)
    .filter(Boolean);
}

/** Where the app lands on launch. `persisted` is the last-used surface from
 *  storage — the `"last"` landing (the default) resolves to it, so an
 *  untouched manifest reproduces today's restore-where-you-were behavior. A
 *  fixed landing wins over the persisted value; a per-project override wins
 *  over the global landing. A disabled or unknown result falls back to the
 *  document. */
export function initialSurface(
  ws: Workspace,
  persisted: MainSurface,
  projectPath?: string | null,
): MainSurface {
  const projectLanding = projectPath
    ? ws.projects?.[projectPath]?.landing
    : undefined;
  const landing = isLanding(projectLanding)
    ? projectLanding
    : isLanding(ws.landing)
      ? ws.landing
      : "last";
  const resolved = landing === "last" ? persisted : landing;
  if (
    resolved !== "document" &&
    !surfaceEnabled(ws, resolved as ToggleableSurface)
  ) {
    return "document";
  }
  return resolved;
}

/** The canonical-shape overrides a manifest carries (A3 snap-back — the one
 *  layout knob that is file-first: there is no GUI writer yet, only the
 *  hand-edit). Lenient field-by-field: anything that isn't a finite positive
 *  number is ignored; range sanity lives in canonicalLayout, which also
 *  knows the window. Absent or malformed block = no overrides = the built-in
 *  canonical shape. */
export function workspaceLayout(ws: Workspace): CanonicalOverrides {
  const raw: unknown = ws.layout;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const r = raw as Record<string, unknown>;
  const out: CanonicalOverrides = {};
  const sidebar = num(r.sidebar);
  const discussion = num(r.discussion);
  const terminal = num(r.terminal);
  if (sidebar !== undefined) out.sidebar = sidebar;
  if (discussion !== undefined) out.discussion = discussion;
  if (terminal !== undefined) out.terminal = terminal;
  return out;
}

// ---- Pure updaters (each backs one GUI gesture; all preserve unknown keys) --

/** Materialize defaults into a manifest about to be customized, so the first
 *  written file shows every knob instead of one lonely key. */
function materialized(ws: Workspace): Workspace {
  const base = defaultWorkspace();
  return {
    ...base,
    ...ws,
    surfaces: { ...base.surfaces, ...ws.surfaces },
    header: {
      ...base.header,
      ...ws.header,
      order: headerOrderFull(ws),
    },
  };
}

/** The full order (including disabled surfaces) — what gets persisted, so
 *  hiding then re-enabling a surface restores its position. */
function headerOrderFull(ws: Workspace): MainSurface[] {
  const order = (ws.header?.order ?? MAIN_SURFACE_IDS).filter(isMainSurface);
  const seen = new Set<MainSurface>();
  const ordered: MainSurface[] = [];
  for (const id of order) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of MAIN_SURFACE_IDS) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

export function setSurfaceEnabled(
  ws: Workspace,
  id: ToggleableSurface,
  enabled: boolean,
): Workspace {
  const next = materialized(ws);
  next.surfaces = { ...next.surfaces, [id]: enabled };
  return next;
}

/** Move a surface one slot left/right within the persisted order. No-op at
 *  the edges and for unknown ids. */
export function moveHeaderSurface(
  ws: Workspace,
  id: MainSurface,
  delta: -1 | 1,
): Workspace {
  const order = headerOrderFull(ws);
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return ws;
  const next = materialized(ws);
  const reordered = [...order];
  reordered.splice(from, 1);
  reordered.splice(to, 0, id);
  next.header = { ...next.header, order: reordered };
  return next;
}

export function setLanding(ws: Workspace, landing: Landing): Workspace {
  const next = materialized(ws);
  next.landing = landing;
  return next;
}

/** The manifest's effective landing for display (settings UI). */
export function currentLanding(ws: Workspace): Landing {
  return isLanding(ws.landing) ? ws.landing : "last";
}
