// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// What the Redline card can attach from the surface you are standing on.
//
// Every surface offers its own "this thing" chip — the page, the plan, the
// open file, the draft, the diff — and a pressed chip rides along with
// whatever the card sends. Explicit by design: nothing is attached that the
// user was not shown and left pressed, and a surface with nothing selectable
// on screen offers no chip at all rather than one that attaches nothing.
//
// Pure. App reads the sources when something is sent (`gatherContext`); this
// module decides which chips exist, which are pressed, and how the blocks are
// laid into a prompt. The block builders themselves are only needed at send
// time, so they live in `contextBlocks.ts`, off the boot path.

import type { SurfaceInfo } from "./activeSurface";
import type { LaunchDestination } from "./frontDoor";

/** The browser tab the card would quote, as BrowserPane reports it. */
export interface BrowserIslandPage {
  label: string;
  title: string;
  url: string;
  selection?: string;
}

export type ContextChipId = "page" | "tasks" | "plan" | "file" | "draft" | "diff";

export interface ContextChip {
  id: ContextChipId;
  label: string;
  /** The tooltip: what exactly would be attached. */
  title: string;
  defaultOn: boolean;
}

/** What App can actually supply right now. A chip is offered only when there
 *  is something behind it. */
export interface ChipSources {
  page?: { title: string; url: string } | null;
  /** The browser tab's working list exists. */
  tasks?: boolean;
  plan?: { version: number; title: string | null } | null;
  file?: string | null;
  draft?: boolean;
  diff?: { repo: string } | null;
}

export function surfaceChips(surface: SurfaceInfo, sources: ChipSources): ContextChip[] {
  switch (surface.kind) {
    case "browser": {
      const chips: ContextChip[] = [];
      if (sources.page?.url)
        chips.push({ id: "page", label: "This page", title: sources.page.url, defaultOn: true });
      // Off by default, as it always was: a working list is the user's own
      // notes about the tab, not the thing on screen.
      if (sources.tasks)
        chips.push({ id: "tasks", label: "Task list", title: "This tab's working list", defaultOn: false });
      return chips;
    }
    case "plan":
      return sources.plan
        ? [{ id: "plan", label: `This plan · v${sources.plan.version}`, title: sources.plan.title ?? "The plan on screen", defaultOn: true }]
        : [];
    // The file viewer reports itself as the terminal-ish surface.
    case "terminal":
      return sources.file
        ? [{ id: "file", label: "This file", title: sources.file, defaultOn: true }]
        : [];
    case "drafter":
      return sources.draft
        ? [{ id: "draft", label: "This draft", title: "The document open in the Drafter", defaultOn: true }]
        : [];
    case "review":
      return sources.diff
        ? [{ id: "diff", label: "This diff", title: sources.diff.repo, defaultOn: true }]
        : [];
    // Localhost, Memory, Runs, a chat and the empty plate have no on-screen
    // selection App can read.
    default:
      return [];
  }
}

/** The chips a destination can use. Opening the Drafter FROM the Drafter
 *  would attach the document to a copy of itself. */
export function visibleChips(chips: ContextChip[], destination: LaunchDestination): ContextChip[] {
  return destination === "drafter" ? chips.filter((c) => c.id !== "draft") : chips;
}

/** Chip presses, remembered for one surface only: arriving somewhere else
 *  starts from that surface's defaults again. */
export interface ChipPresses {
  surfaceKey: string;
  on: Partial<Record<ContextChipId, boolean>>;
}

export function isChipPressed(chip: ContextChip, presses: ChipPresses, surfaceKey: string): boolean {
  return (presses.surfaceKey === surfaceKey ? presses.on[chip.id] : undefined) ?? chip.defaultOn;
}

export function toggleChip(presses: ChipPresses, surfaceKey: string, chip: ContextChip): ChipPresses {
  const on = presses.surfaceKey === surfaceKey ? presses.on : {};
  return { surfaceKey, on: { ...on, [chip.id]: !isChipPressed(chip, presses, surfaceKey) } };
}

/** The heading's "Redline · …" — where the card is, in words. Null on the
 *  empty plate, which has nothing to name. */
export function surfaceContextLabel(surface: SurfaceInfo, pageTitle?: string | null): string | null {
  switch (surface.kind) {
    case "plan":
      return surface.label || "Plan";
    case "drafter":
      return "Drafter";
    case "browser":
      return pageTitle || surface.label || "Browser";
    case "review":
      return surface.label ? `Review · ${basename(surface.label)}` : "Code review";
    case "servers":
      return "Localhost";
    case "memory":
      return "Memory";
    case "runs":
      return "Runs";
    case "chat":
      return surface.label || "Chat";
    case "terminal":
      return surface.detail ? basename(surface.detail) : "Terminal";
    default:
      return null;
  }
}

// ---- Blocks -----------------------------------------------------------------

/** One attached thing, rendered as its own markdown section. `id` is the chip
 *  it came from, so a caller can tell an unchanged block from a new one. */
export interface ContextBlock {
  id: ContextChipId;
  heading: string;
  body: string;
}

/** Per block. A whole plan or draft fits comfortably; a pathological one is
 *  cut with a note rather than silently swamping the prompt. */
export const CONTEXT_BLOCK_MAX = 40_000;

export function capBlock(body: string, max = CONTEXT_BLOCK_MAX): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max).trimEnd()}\n\n[Truncated: ${body.length - max} more characters were not attached.]`;
}

export function renderContextBlocks(blocks: ContextBlock[]): string {
  return blocks
    .filter((b) => b.body.trim())
    .map((b) => `## Context — ${b.heading}\n\n${capBlock(b.body.trim())}`)
    .join("\n\n");
}

/** The prompt, then each attached block. `rule` sets the context apart with a
 *  horizontal rule — the Drafter's document reads it as a separate part. */
export function withContext(prompt: string, blocks: ContextBlock[], opts: { rule?: boolean } = {}): string {
  const text = prompt.trim();
  const context = renderContextBlocks(blocks);
  if (!context) return text;
  return [text, opts.rule ? "---" : "", context].filter(Boolean).join("\n\n");
}

// ---- A chat's record --------------------------------------------------------

/** What one chat has been handed (`unsentAttachment` in contextBlocks.ts), and
 *  on which provider: a provider switch is a fresh CLI session that saw none
 *  of it (companion.rs's handoff), so the record starts over, switching back
 *  included. `pressed` is every block the latest send had pressed. */
export interface SentContext {
  provider: string;
  keys: Set<string>;
  pressed: string[];
}

/** One send's attachment: the blocks this chat hasn't been handed yet, and
 *  every pressed block, which the backend uses instead when the send starts
 *  a fresh CLI session (companion.rs `turn_attachment`). */
export interface ChatAttachment {
  context: string | null;
  contextAll?: string | null;
}

/** Why a chat's attachments may not have reached its agent: the send never
 *  arrived, or the backend started a fresh CLI session (rotation, handoff). */
export type ContextLoss = "unsent" | "fresh-session";

/** A send that never arrived: its next send carries everything again. A
 *  fresh session: it was handed every block pressed at the send that started
 *  it, and only those. */
export function forgetSent(sent: Map<string, SentContext>, chatId: string, why: ContextLoss): void {
  const record = sent.get(chatId);
  if (why === "fresh-session" && record) record.keys = new Set(record.pressed);
  else sent.delete(chatId);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}
