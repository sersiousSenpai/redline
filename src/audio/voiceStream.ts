// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A voice reply carries two channels in one stream (the contract is
// `SPOKEN_RULES` in voice.rs): a few sentences for the ear, then — after a
// line holding only ⟦screen⟧ — detail for the eye that is never spoken. A
// sentence about one plan section is followed by ⟦§<anchorId>⟧. This module is
// the one reader of that contract: speech gets the spoken part with every
// marker taken out, the transcript renders the screen part as markdown and the
// markers as section chips. It is pure, so a reply stored raw renders the same
// way when the transcript reloads as it did live.

/** The line that ends the spoken part. */
export const SCREEN_MARKER = "⟦screen⟧";

/** A section marker in the spoken part, and where it sat. */
export interface SectionMark {
  anchorId: string;
  /** Offset into `spoken` just past the sentence the marker followed. */
  at: number;
}

export interface VoiceReply {
  /** What is said aloud: the part before ⟦screen⟧, markers removed. */
  spoken: string;
  /** The on-screen detail (markdown), markers removed; "" when there is none. */
  screen: string;
  /** The spoken part's markers, in order — what playback points at. */
  marks: SectionMark[];
  /** Every section the reply names, once each, in order — its chips. */
  sections: string[];
}

// A marker together with the whitespace before it, so "the risk ⟦§A⟧." reads
// "the risk." rather than "the risk ."
const MARKER = /\s*⟦([^⟦⟧]*)⟧/g;

/**
 * Split a reply — whole, or as much of it as has streamed — into its two
 * channels.
 *
 * Mid-stream, a marker that has not closed yet is left out, and so is
 * trailing whitespace (a marker may still arrive to swallow it). That keeps
 * one promise: the spoken text only ever grows by appending. Whatever was
 * handed to speech is a prefix of what comes next, so a caller speaks the
 * difference.
 */
export function splitReply(raw: string): VoiceReply {
  const cut = raw.indexOf(SCREEN_MARKER);
  const head = cut === -1 ? raw : raw.slice(0, cut);
  const spoken = strip(withoutOpenMarker(head));
  const screen =
    cut === -1
      ? { text: "", marks: [] }
      : strip(withoutOpenMarker(raw.slice(cut + SCREEN_MARKER.length)));
  const lead = spoken.text.length - spoken.text.trimStart().length;
  const text = spoken.text.trim();
  const marks = spoken.marks.map((m) => ({
    anchorId: m.anchorId,
    at: Math.min(text.length, Math.max(0, m.at - lead)),
  }));
  const sections: string[] = [];
  for (const m of [...marks, ...screen.marks]) {
    if (!sections.includes(m.anchorId)) sections.push(m.anchorId);
  }
  return { spoken: text, screen: screen.text.trim(), marks, sections };
}

/** Cut a marker that opened and has not closed: mid-stream it is still
 *  arriving, and in a finished reply it is malformed and never worth saying. */
function withoutOpenMarker(text: string): string {
  const open = text.lastIndexOf("⟦");
  return open !== -1 && text.indexOf("⟧", open) === -1 ? text.slice(0, open) : text;
}

/** Remove every closed marker, recording where each `⟦§…⟧` sat. Any other
 *  bracketed token is dropped too: nothing in ⟦…⟧ is ever meant to be read. */
function strip(text: string): { text: string; marks: SectionMark[] } {
  const marks: SectionMark[] = [];
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    out += text.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const body = m[1].trim();
    if (body.startsWith("§") && body.length > 1) {
      marks.push({ anchorId: body.slice(1).trim(), at: out.length });
    }
  }
  out += text.slice(last);
  return { text: out, marks };
}
