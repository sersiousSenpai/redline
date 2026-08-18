// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Launching a plan, as a pure module.
//
// Three surfaces run the identical `claude --permission-mode plan`: the Front
// Door's one sentence, the Prompt Drafter's document, and the browser's Send to
// Claude Code. Only the first ever gated on readiness, handled a missing
// terminal, or showed anything afterward — so this file owns every decision
// about *launching* that no single surface owns.
//
// It is deliberately not a renamed `frontDoor.ts`: half that file's exports are
// composer keybindings and chip templaters that must not become shared
// property. And deliberately not a hook: it would close over ten App handles
// and become untestable without a DOM, which is the house rule stated at
// frontDoor.ts:6-8.

import type { ProjectOption } from "../components/ProjectPicker";
import { guessProjectForPlan } from "./guessProject";
import type { ExtensionToolchain, ReadinessItem } from "./readiness";
import { blockingItems } from "./readiness";

// ── Project resolution ──────────────────────────────────────────────────────

/** The project chip's state. `null` means untouched — resolve it from the
 *  prompt text and the workspace. `{ path }` is an explicit pick, and
 *  `{ path: null }` is an explicit "Home (~)", which must NOT be re-guessed
 *  away on the next keystroke. */
export type ProjectChoice = { path: string | null } | null;

export interface LaunchProjectInputs {
  /** Known repos: every review session's project plus each open folder. */
  projectOptions: ProjectOption[];
  /** The folder workspace currently open in the sidebar, if any. */
  openFolder: string | null;
  /** The repo the last successful launch shipped into. */
  lastLaunchProject: string | null;
}

/** Where ⏎ launches. Precedence: an explicit chip beats everything; then the
 *  repo named in the prompt itself; then the folder the user is browsing;
 *  then the last repo they launched into; then Home. */
export function resolveLaunchProject(
  text: string,
  chip: ProjectChoice,
  opts: LaunchProjectInputs,
): string | null {
  if (chip) return chip.path;
  const guess = guessProjectForPlan(text, opts.projectOptions);
  if (guess) return guess;
  if (opts.openFolder) return opts.openFolder;
  return opts.lastLaunchProject ?? null;
}

/** A document's project pick, TAGGED with the document it belongs to.
 *
 *  The untagged `string | null` this replaces was the bug, not the symptom:
 *  `null` meant both "the user explicitly chose Home" and "I haven't loaded
 *  this document yet", which is exactly why the load effect guarded with
 *  `if (path)` and never reset. Switching from a document in `/repo/x` to one
 *  with no project left the first one's path in place — permanently
 *  reassigning the second document AND launching its prompt into the wrong
 *  cwd. Tagging with the document id makes that bleed unrepresentable. */
export type DocProjectChoice = { forId: string; path: string | null } | null;

/** The pick, but only if it belongs to this document. `null` means "no answer
 *  for this document" — which callers must treat as *don't write*, never as
 *  "Home", because `upsert_draft` writes `project_path` unconditionally. */
export function projectForDoc(
  pick: DocProjectChoice,
  draftId: string | null,
): { path: string | null } | null {
  if (!pick || !draftId) return null;
  return pick.forId === draftId ? { path: pick.path } : null;
}

// ── The prompt as launched ──────────────────────────────────────────────────

/** Attached files ride as a plain `Context:` path list — the plan session
 *  already has `Read Grep Glob` pre-approved, so a path is all it needs;
 *  inlining the bytes would only burn its context. Shared, because the Drafter
 *  gains attachments too. */
export function composePrompt(text: string, attachments: string[]): string {
  const body = text.trim();
  if (!body) return "";
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of attachments) {
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  if (paths.length === 0) return body;
  return `${body}\n\nContext:\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/** The extra directory grants an extension-pack launch carries. A pack
 *  author's session builds against the staged ABI/SDK crates and the worked
 *  template — all outside the project cwd — so the launch grants them via
 *  `--add-dir`. Empty for a plain project, and empty for any dir the probe
 *  couldn't resolve (a moved checkout): a launch with fewer grants beats a
 *  launch that fails. */
export function extensionAddDirs(
  kind: "extension" | "harness" | null,
  probe: ExtensionToolchain | null | undefined,
): string[] {
  // A harness pack is data — no toolchain, no staged crates, no grants.
  if (kind !== "extension" || !probe) return [];
  return [probe.abiDir, probe.sdkDir, probe.templateDir].filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
}

// ── The readiness gate ──────────────────────────────────────────────────────

/** May this launch proceed? `blocked` carries the item to render where the
 *  user is already looking, rather than only in a strip they may have stopped
 *  seeing. Extracted from FrontDoor's inline gate so the second and third
 *  doors cannot quietly skip it. */
export type LaunchAttempt =
  | { kind: "go" }
  | { kind: "blocked"; item: ReadinessItem };

export function attemptLaunch(readiness: ReadinessItem[]): LaunchAttempt {
  const blocking = blockingItems(readiness);
  if (blocking.length > 0) return { kind: "blocked", item: blocking[0] };
  return { kind: "go" };
}

/** After a fix resolves true: the next thing still blocking, or null when the
 *  path is clear and the held ⏎ should carry through. Taking `fixedId` rather
 *  than reading a stale list is what makes "fix it and it just goes" work. */
export function nextBlocker(
  readiness: ReadinessItem[],
  fixedId: string,
): ReadinessItem | null {
  return blockingItems(readiness).find((b) => b.id !== fixedId) ?? null;
}

/** Is a blocker being shown one that no longer exists? A fault fixed elsewhere
 *  must not keep sitting in the island describing something that isn't true. */
export function staleBlocker(
  readiness: ReadinessItem[],
  shown: ReadinessItem | null,
): boolean {
  if (!shown) return false;
  return !blockingItems(readiness).some((b) => b.id === shown.id);
}

// ── Pending launches ────────────────────────────────────────────────────────

/** Which door a launch came through. Ground truth for the lake's `surface`
 *  column — it used to be hardcoded `"drafter"` on the Rust side, which filed
 *  every front-door and browser launch as a drafter launch. */
export type LaunchOrigin = "front-door" | "drafter" | "browser";

/** What a surface gets back if its launch dies before a plan arrives.
 *
 *  The Front Door took the sentence away (it moved into the card), so it is
 *  owed one. The Drafter owes nothing back — it never took the document away,
 *  which is the whole point of morphing in place. */
export type LaunchRestore =
  | { kind: "composer"; text: string; attachments: string[] }
  | { kind: "none" };

export interface PendingLaunch {
  origin: LaunchOrigin;
  /** The prompt as launched — what the card displays. */
  prompt: string;
  startedAt: number;
  /** NON-NULLABLE by design: a pending launch with no terminal is "spinning on
   *  a launch that never happened", and this type makes that unrepresentable.
   *  A surface that couldn't open a terminal must report that, not set this. */
  terminalId: string;
  /** The document this launch came from, when it came from one. The Drafter
   *  shows its card only when this matches the document on screen. */
  draftId: string | null;
  restore: LaunchRestore;
  /** The lineage write failed — the plan is coming but nothing recorded what
   *  was asked. Surfaced, never swallowed. */
  lineageError?: string;
}

/** Fold a dead launch's restore back into a composer's state. Only when the
 *  composer is empty: giving someone their sentence back is a kindness,
 *  clobbering newer typing with it is not. */
export function restoreInto(
  prev: { text: string; attachments: string[] },
  restore: LaunchRestore,
): { text: string; attachments: string[] } {
  if (restore.kind !== "composer") return prev;
  return {
    text: prev.text.trim() ? prev.text : restore.text,
    attachments: prev.attachments.length ? prev.attachments : restore.attachments,
  };
}

/** Is a launched plan session still alive?
 *
 *  A launch lives in one terminal tile. Close the tile and the PTY dies with
 *  it, so no plan is ever coming and the "Planning…" card has to go — a
 *  spinner outliving its process is exactly the confident lie this surface
 *  exists to remove.
 *
 *  The rule that matters is the negative one: only a REPORTED set of live ids
 *  that omits ours proves the terminal is gone. `null` means the dock hasn't
 *  told us yet, which is ignorance, not death — treating it as death would
 *  cancel every launch during the frames before the first report. */
export function launchStillLive(
  terminalId: string | null,
  liveTerminalIds: string[] | null,
): boolean {
  if (!terminalId) return true;
  if (liveTerminalIds === null) return true;
  return liveTerminalIds.includes(terminalId);
}

/** Liveness for a launch whose terminal id was minted THIS tick.
 *
 *  `launchStillLive` cannot tell "the dock hasn't reported this id yet" from
 *  "the dock says it's gone", and that gap is not an edge case — a freshly
 *  minted id is ALWAYS absent from the report the previous commit closed over.
 *  The dock's id reporter is a child effect: it *queues* the new report, it
 *  does not apply it, so the parent's launch-death effect runs in the same
 *  flush still holding the id list from before the terminal existed. Every
 *  single launch therefore read as dead on its first frame, which cancelled
 *  the launch and — for the Front Door, whose restore pays the sentence back —
 *  wrote the just-cleared sentence straight back into the composer.
 *
 *  Confirming the id once first is what makes the distinction: before
 *  confirmation an absent id is IGNORANCE, after it, DEATH. `confirmed` is the
 *  caller's memory across reports, and it must be scoped to one launch — see
 *  the `startedAt` key at the call site — so one launch's confirmation can
 *  never vouch for the next. */
export function launchLiveness(
  terminalId: string | null,
  liveTerminalIds: string[] | null,
  confirmed: boolean,
): { alive: boolean; confirmed: boolean } {
  // Nothing to track, and an unreported dock is still ignorance: both are the
  // existing rule, kept in one place rather than restated.
  if (!launchStillLive(terminalId, liveTerminalIds)) {
    // Reported, and we are not in it. Only fatal once the dock has vouched for
    // this terminal at least once.
    return { alive: !confirmed, confirmed };
  }
  // Present in a REPORTED set is the confirmation. A `null` report vouches for
  // nothing — it is the absence of news, not news.
  const nowConfirmed =
    confirmed || (liveTerminalIds !== null && !!terminalId);
  return { alive: true, confirmed: nowConfirmed };
}

// ── The launch receipt ──────────────────────────────────────────────────────

/** Which non-serializing authoring aids a document is ACTUALLY carrying.
 *
 *  The Drafter ships structured text: headings, lists, tables and emphasis all
 *  survive; font, colour, highlight and alignment do not. Saying so
 *  unconditionally (as the old always-on tooltip did) is noise — it claims a
 *  loss even for the document that lost nothing. Saying it only when it is
 *  true is what makes it credible. */
export interface LaunchReceipt {
  words: number;
  blocks: number;
  /** True when the document carries at least one aid that stayed behind. */
  aidsDropped: boolean;
}

/** The marks whose whole payload is presentation: `highlight` (the marker
 *  pen) and `textStyle` (the carrier Color/FontFamily/FontSize hang off).
 *  A bare `textStyle` with every attribute null is a leftover, not an aid —
 *  hence the attribute check rather than the mark's mere presence. */
const AID_MARKS = new Set(["highlight", "textStyle"]);

/** Node attributes that are presentation. `textAlign` is the only one the
 *  drafter's extension set puts on a block, and its default is `left`. */
const AID_NODE_ATTRS: Record<string, unknown> = { textAlign: "left" };

function hasMeaningfulAttr(
  attrs: Record<string, unknown> | undefined,
  defaults: Record<string, unknown> | null,
): boolean {
  if (!attrs) return false;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === "") continue;
    if (defaults) {
      if (!(key in defaults)) continue;
      if (defaults[key] === value) continue;
    }
    return true;
  }
  return false;
}

/** Walk a TipTap document for the receipt. Prompt-sized data, one pass — the
 *  perf budget's rule 1 governs exactly this shape and it complies. */
export function launchReceipt(doc: unknown, text: string): LaunchReceipt {
  let aidsDropped = false;

  const visit = (node: unknown): void => {
    if (aidsDropped || !node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      attrs?: Record<string, unknown>;
      marks?: { type?: string; attrs?: Record<string, unknown> }[];
      content?: unknown[];
    };
    if (n.marks) {
      for (const m of n.marks) {
        if (!m?.type || !AID_MARKS.has(m.type)) continue;
        // `highlight` is an aid by existing; `textStyle` only when it actually
        // carries a colour, family or size.
        if (m.type === "highlight" || hasMeaningfulAttr(m.attrs, null)) {
          aidsDropped = true;
          return;
        }
      }
    }
    if (hasMeaningfulAttr(n.attrs, AID_NODE_ATTRS)) {
      aidsDropped = true;
      return;
    }
    if (Array.isArray(n.content)) for (const child of n.content) visit(child);
  };
  visit(doc);

  // Blocks are the document's top-level nodes — the same unit the gutter
  // numbers and `data-block-id` label, so the count means what the user sees.
  const top = (doc as { content?: unknown[] } | null)?.content;
  const blocks = Array.isArray(top) ? top.length : 0;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { words, blocks, aidsDropped };
}
