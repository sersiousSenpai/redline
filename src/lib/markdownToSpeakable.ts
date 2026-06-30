// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Mechanical, structure-aware markdown → spoken-text transform for the voice
// agent's Verbatim mode. It is deliberately *not* semantic: it strips syntax so
// the speech engine doesn't read "hash", "asterisk", backticks, or raw URLs,
// and it uses the document's headings to announce structure ("Section: …") with
// a pause, so the read doesn't run together. Semantic work — deciding what
// matters, condensing, rephrasing for the ear — lives one layer up in the warm
// Claude session (Summary / Bullets / Guided Walkthrough), never here.

import { stripSidecars } from "../editor/markdown/sidecar";
import type { Section } from "../types";

/** Strip inline markdown emphasis/code/link syntax, keeping the words. */
export function stripInline(text: string): string {
  return (
    text
      // images: drop entirely (alt text rarely reads well aloud)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // links: keep the label, drop the URL
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // bold/italic/strikethrough markers
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      // inline code: keep the contents, drop the backticks
      .replace(/`([^`]*)`/g, "$1")
      // bare URLs
      .replace(/\bhttps?:\/\/\S+/g, "")
      .trim()
  );
}

/**
 * Convert plan markdown to clean spoken text. Sidecars and HTML comments are
 * removed, headings become spoken "Section: …" lead-ins, code blocks collapse
 * to a short note (rather than reading symbols), and tables/lists/quotes are
 * flattened to plain prose. Blank lines are preserved as paragraph breaks,
 * which `SpeechQueue` treats as sentence boundaries — natural pauses.
 */
export function markdownToSpeakable(markdown: string): string {
  const { clean } = stripSidecars(markdown);
  const lines = clean.split("\n");
  const out: string[] = [];
  let inFence = false;
  let emittedCodeNote = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();

    // Fenced code blocks: announce once, then skip the contents.
    if (/^(```|~~~)/.test(trimmed)) {
      if (!inFence) {
        inFence = true;
        emittedCodeNote = false;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      if (!emittedCodeNote) {
        out.push("Code block.");
        emittedCodeNote = true;
      }
      continue;
    }

    // HTML comments (REDLINE_RESOLUTIONS side-channel, etc.) and HTML tags.
    if (/^<!--/.test(trimmed) || /^<\/?[a-zA-Z]/.test(trimmed)) continue;

    // Horizontal rules.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue;

    // Blank line → paragraph break (a pause).
    if (trimmed === "") {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    // Headings → "Section: <title>." lead-in.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const title = stripInline(heading[2]).replace(/[.:]+$/, "");
      if (title) {
        if (out.length && out[out.length - 1] !== "") out.push("");
        out.push(`Section: ${title}.`);
        out.push("");
      }
      continue;
    }

    // Table rows: drop the separator row, speak cells comma-separated.
    if (/^\|.*\|$/.test(trimmed)) {
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // |---|---|
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => stripInline(c.trim()))
        .filter(Boolean);
      if (cells.length) out.push(`${cells.join(", ")}.`);
      continue;
    }

    // Strip leading list markers / blockquote / task-list boxes.
    const body = stripInline(
      trimmed
        .replace(/^>\s?/, "")
        .replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, ""),
    );
    if (body) out.push(body);
  }

  // Collapse runs of blank lines, trim ends.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One node of the plan's section tree, flattened for the Guided Walkthrough. */
export interface SpeechSegment {
  anchorId: string;
  blockId: string;
  level: number;
  title: string;
  /** Verbatim body markdown for this section (sent to Claude to explain). */
  bodyMarkdown: string;
}

/**
 * Depth-first, document-order flattening of the section tree — the
 * deterministic traversal that drives the Guided Walkthrough. Because the order
 * is ours (not the model's), every section is guaranteed reached. A node with
 * no title and no body is skipped (e.g. a synthetic root).
 */
export function flattenSections(sections: Section[]): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  const walk = (nodes: Section[]) => {
    for (const s of nodes) {
      const title = stripInline(s.title ?? "").trim();
      const body = (s.bodyMarkdown ?? "").trim();
      if (title || body) {
        out.push({
          anchorId: s.anchorId,
          blockId: s.blockId,
          level: s.level,
          title,
          bodyMarkdown: s.bodyMarkdown ?? "",
        });
      }
      if (s.children?.length) walk(s.children);
    }
  };
  walk(sections);
  return out;
}
