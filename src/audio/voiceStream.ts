// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A voice reply carries two channels in one stream (the contract is
// `SPOKEN_RULES` in voice.rs): a few sentences for the ear, then — after a
// line holding only ⟦screen⟧ — detail for the eye that is never spoken. A
// sentence about one plan section is followed by ⟦§<anchorId>⟧, and a reply
// may open with ⟦tone: calm⟧ for a voice that can take one. This module is
// the one reader of that contract: speech gets the spoken part with every
// marker taken out, the transcript renders the screen part as markdown and the
// markers as section chips. It is pure, so a reply stored raw renders the same
// way when the transcript reloads as it did live.

/** The line that ends the spoken part. */
const SCREEN_MARKER = "⟦screen⟧";

/** How far an opened ⟦ may run without its ⟧ and still be a marker: every
 *  real one is shorter, and text after a stray ⟦ is spoken, not held back
 *  for the rest of the reply. */
const MARKER_MAX = 40;

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
  /** The spoken part's ⟦tone: …⟧, lowercased ("calm, warm"); null when it
   *  has none, or one that isn't plain words. */
  tone: string | null;
}

// A marker together with the whitespace before it, so "the risk ⟦§A⟧." reads
// "the risk." rather than "the risk ."
const MARKER = new RegExp(`\\s*⟦([^⟦⟧]{0,${MARKER_MAX}})⟧`, "g");
const TONE = /^tone\s*:\s*([a-z][a-z ,]*)$/;

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
  return { spoken: text, screen: screen.text.trim(), marks, sections, tone: spoken.tone };
}

/**
 * Whether the spoken text streamed so far ends a thought, so a sentence the
 * speech queue is holding back (it waits for what follows a period) can be
 * said now: the ⟦screen⟧ line has begun, or the stream rests at a line break
 * — which is where the agent stops to use a tool, often for seconds.
 */
export function spokenPause(raw: string): boolean {
  return raw.includes(SCREEN_MARKER) || /\n\s*$/.test(raw);
}

/** Cut a marker that opened and has not closed: mid-stream it is still
 *  arriving, and in a finished reply it is malformed and never worth saying.
 *  One that ran past `MARKER_MAX` without closing was never a marker. */
function withoutOpenMarker(text: string): string {
  const open = text.lastIndexOf("⟦");
  return open !== -1 && text.indexOf("⟧", open) === -1 && text.length - open <= MARKER_MAX + 1
    ? text.slice(0, open)
    : text;
}

/** Remove every closed marker, recording where each `⟦§…⟧` sat and the first
 *  `⟦tone: …⟧`. Any other bracketed token is dropped too: nothing in ⟦…⟧ is
 *  ever meant to be read. */
function strip(text: string): { text: string; marks: SectionMark[]; tone: string | null } {
  const marks: SectionMark[] = [];
  let tone: string | null = null;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    out += text.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const body = m[1].trim();
    if (body.startsWith("§") && body.length > 1) {
      marks.push({ anchorId: body.slice(1).trim(), at: out.length });
    }
    tone ??= TONE.exec(body.toLowerCase())?.[1].trim() ?? null;
  }
  out += text.slice(last);
  return { text: out, marks, tone };
}
