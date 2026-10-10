// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The voice panel and the plan beside it, pointing at each other through the
// `data-anchor-id` every top-level block already carries (the contents
// sidebar scrolls by it too):
//
// - the agent points: a section it names gets a soft outline while its
//   sentence plays, and its chip outlines it on hover and scrolls to it on a
//   click — the click is the only thing here that ever moves the view;
// - the user points: the section in view and the text they selected ride the
//   next turn as hidden context, so "add that here" needs no lookup.

import { activeAnchorIn } from "../components/PlanToc";
import type { Section } from "../types";

/** The rendered plan (the document column). */
const PLAN_SCOPE = ".doc-article";

/** How long a section stays outlined when the agent points at it. */
export const POINT_MS = 1500;

const POINT_CLASS = "rl-voice-point";

function planScope(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PLAN_SCOPE);
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\\n]/g, "\\$&");
}

/** The section heading a block anchor belongs to: `A.2.p3` → `A.2`. */
function sectionOf(anchorId: string): string {
  return anchorId.replace(/\.p\d+$/, "");
}

/** The plan block an anchor names — itself, or failing that its section. */
export function planBlock(anchorId: string): HTMLElement | null {
  const scope = planScope();
  if (!scope) return null;
  const find = (id: string) =>
    scope.querySelector<HTMLElement>(`[data-anchor-id="${cssEscape(id)}"]`);
  return find(anchorId) ?? find(sectionOf(anchorId));
}

/** Every heading's title by anchor, for chips and context lines. */
export function sectionTitles(sections: readonly Section[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: readonly Section[]) => {
    for (const s of nodes) {
      if (s.title.trim()) out.set(s.anchorId, s.title.trim());
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

/** The title an anchor reads as — a block anchor reads as its section — or
 *  null for an anchor this plan does not have (the agent is told never to
 *  invent one; a chip that scrolls to nothing would be worse than none). */
export function titleFor(titles: ReadonlyMap<string, string>, anchorId: string): string | null {
  return titles.get(anchorId) ?? titles.get(sectionOf(anchorId)) ?? null;
}

// Outlines held per element: a hover and a spoken point may overlap, and the
// outline must outlast both.
const held = new Map<HTMLElement, { holds: number; timer: ReturnType<typeof setTimeout> | null }>();

function release(el: HTMLElement) {
  const h = held.get(el);
  if (!h || h.holds > 0 || h.timer) return;
  held.delete(el);
  el.classList.remove(POINT_CLASS);
}

/** Outline an anchor's block for `ms`. Never scrolls. */
export function pointAt(anchorId: string, ms = POINT_MS): void {
  const el = planBlock(anchorId);
  if (!el) return;
  const h = held.get(el) ?? { holds: 0, timer: null };
  if (h.timer) clearTimeout(h.timer);
  h.timer = setTimeout(() => {
    h.timer = null;
    release(el);
  }, ms);
  held.set(el, h);
  el.classList.add(POINT_CLASS);
}

/** Outline an anchor's block until the returned function is called (a chip's
 *  hover). */
export function holdPoint(anchorId: string): () => void {
  const el = planBlock(anchorId);
  if (!el) return () => {};
  const h = held.get(el) ?? { holds: 0, timer: null };
  h.holds += 1;
  held.set(el, h);
  el.classList.add(POINT_CLASS);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    h.holds -= 1;
    release(el);
  };
}

const smooth = (): ScrollBehavior =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/** Bring an anchor's block into view — a chip's click. */
export function scrollToSection(anchorId: string): boolean {
  const el = planBlock(anchorId);
  if (!el) return false;
  el.scrollIntoView({ block: "start", behavior: smooth() });
  pointAt(anchorId);
  return true;
}

/** Show a captured comment where it landed. Its highlight's own click is the
 *  app's "take me to this comment" path (it focuses the card too); without a
 *  highlight, the block it is anchored to. */
export function showComment(commentId: string, anchorId: string): void {
  const highlight = planScope()?.querySelector<HTMLElement>(
    `[data-comment-id="${cssEscape(commentId)}"]`,
  );
  if (highlight) {
    highlight.click();
    return;
  }
  scrollToSection(anchorId);
}

/** The section the reader is under, as the contents sidebar would highlight
 *  it. */
export function sectionInView(
  titles: ReadonlyMap<string, string>,
): { anchorId: string; title: string } | null {
  const scope = planScope();
  if (!scope) return null;
  const anchorId = activeAnchorIn(scope, [...titles.keys()]);
  return anchorId ? { anchorId, title: titles.get(anchorId) ?? "" } : null;
}
