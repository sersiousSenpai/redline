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
  /** Per-project overrides keyed by absolute project path. `kind` is the
   *  project type — `"extension"` marks a pack project scaffolded to build a
   *  Redline extension; absent or unknown reads as a plain build. This record
   *  doubles as project_create's registry: a created folder is written here
   *  so it is visible before any plan ever lands in it. */
  projects?: Record<
    string,
    { landing?: string; kind?: string; [key: string]: unknown }
  >;
  /** Optional snap-back target overrides in px, plus the immersive opt-out,
   *  e.g. `{"layout": {"sidebar": 280, "discussion": 360, "terminal": 300,
   *  "immersive": false}}`. Read leniently field-by-field — see
   *  workspaceLayout and workspaceImmersive. */
  layout?: {
    sidebar?: number;
    discussion?: number;
    terminal?: number;
    immersive?: boolean;
  };
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

// ---- The paint cache --------------------------------------------------------
// workspace.json is read over IPC, which lands AFTER the first React render —
// so a manifest that hides surfaces briefly showed the stock header on every
// launch. The fix is the theme cache's, one layer up: the last-loaded manifest
// text is mirrored into localStorage (synchronous), the workspace state's
// INITIALIZER reads it, and the file read then confirms or corrects it. The
// file stays the store; the cache is a paint hint that is never authored into.

export const WORKSPACE_CACHE_KEY = "redline.workspace.cache";

/** The manifest to compose the first render from: the mirrored text if one
 *  was cached, else null (defaults — a genuinely untouched install). */
export function readWorkspaceCache(storage: Storage): Workspace | null {
  try {
    const raw = storage.getItem(WORKSPACE_CACHE_KEY);
    if (!raw) return null;
    return parseWorkspace(raw);
  } catch {
    return null;
  }
}

/** Mirror the manifest text after every authoritative read or write. `null`
 *  (no file on disk) clears the mirror so a deleted manifest stops echoing. */
export function storeWorkspaceCache(
  storage: Storage,
  text: string | null,
): void {
  try {
    if (text) storage.setItem(WORKSPACE_CACHE_KEY, text);
    else storage.removeItem(WORKSPACE_CACHE_KEY);
  } catch {
    /* storage unavailable — the async read still lands */
  }
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

/** Is the immersive rule on? Non-document surfaces hide the periphery on
 *  entry unless the manifest's `layout` block says otherwise. Same file-first
 *  duality as the size overrides above (no GUI writer — the hand-edit IS the
 *  interface), and the same leniency: only a literal `false` turns it off, so
 *  a manifest that predates the feature, or one carrying a typo, keeps the
 *  behavior on. This is the escape valve for a Code Review workflow that
 *  depends on the discussion pane always being there. */
export function workspaceImmersive(ws: Workspace): boolean {
  const raw: unknown = ws.layout;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return true;
  return (raw as Record<string, unknown>).immersive !== false;
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

// ---- The project registry (extension projects as a first-class type) -------

/** The project kinds this build understands beyond a plain folder: a
 *  buildable extension crate, or a data-only harness pack (A5a). */
export type ProjectKind = "extension" | "harness";

/** A registered project's typed kind. Lenient like every other read here:
 *  only a kind this build knows returns; anything else — including a
 *  hand-typed future kind — reads as a plain project, never as an error. */
export function projectKind(
  ws: Workspace,
  path: string | null | undefined,
): ProjectKind | null {
  if (!path) return null;
  const kind = ws.projects?.[path]?.kind;
  return kind === "extension" || kind === "harness" ? kind : null;
}

/** Register a created project folder in the manifest — the missing half of
 *  `project_create`, which used to leave the folder invisible until a plan
 *  landed in it. Spread-copies the existing entry so a hand-annotated one (a
 *  landing override, an unknown key) survives, and never downgrades: a
 *  registration without a kind keeps whatever kind the entry already has. */
export function registerProject(
  ws: Workspace,
  path: string,
  kind?: ProjectKind,
): Workspace {
  const next = materialized(ws);
  const entry = { ...ws.projects?.[path], ...(kind ? { kind } : {}) };
  next.projects = { ...ws.projects, [path]: entry };
  return next;
}
