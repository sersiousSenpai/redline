// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Comment, ResearchLink } from "../types";
import { clampSelection } from "./browseSelection";
import { SEARCH_URL } from "./omnibox";

// Search from the plan: highlight → Search opens a browser tab whose agent
// researches the passage, and an anchored, NON-submitting research comment
// links back to the answer. The pure halves live here.

/** Whether a comment goes out with the next Send/Revise. Mirrors
 *  `Comment::rides_submit` in state.rs: drafts and reopened comments, except
 *  an unpromoted research comment — a pointer to what was found, not an
 *  instruction for the planner. */
export function ridesSubmit(c: Pick<Comment, "status" | "research" | "actionable">): boolean {
  return (c.status === "draft" || c.status === "reopened") && !(c.research && !c.actionable);
}

/** What gets searched: the passage, plus the reviewer's own instruction. */
export function researchQuery(selection: string, instruction: string): string {
  const quoted = clampSelection(selection).replace(/\s+/g, " ");
  const extra = instruction.trim();
  return extra ? `${quoted} — ${extra}` : quoted;
}

/** The tab opens on a web search for the passage (the browser's own engine),
 *  so there is a page to look at while the agent works. */
export function researchSearchUrl(selection: string, instruction: string): string {
  const terms = `${clampSelection(selection).replace(/\s+/g, " ").slice(0, 200)} ${instruction.trim()}`.trim();
  return `${SEARCH_URL}${encodeURIComponent(terms)}`;
}

/** The tab chat's first message — sent on its own (auto-send). */
export function researchSeed(selection: string, instruction: string, planTitle?: string | null): string {
  const quoted = clampSelection(selection)
    .split("\n")
    .map((line) => `> ${line}`.trimEnd());
  const from = planTitle?.trim() ? ` in the plan "${planTitle.trim()}"` : " in a plan I'm reviewing";
  const ask = instruction.trim()
    ? instruction.trim()
    : "Research this on the web — prefer WebSearch, compare the main options, and cite what you find.";
  return [`From a passage${from}:`, ...quoted, "", ask].join("\n");
}

/** The comment card's one-line summary of a research link. */
export function researchStatus(link: ResearchLink): string {
  return link.answerHash ? "🔎 Searched" : "🔎 Searching…";
}
