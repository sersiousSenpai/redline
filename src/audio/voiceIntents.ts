// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Spoken editing commands, recognized locally — no model, nothing sent
// anywhere. Two kinds:
//
// - **Commands on the field** (`readIntents`): "scratch that" at the start of
//   an utterance takes back the last phrase dictated before it, "undo" the
//   whole last dictation, and "send it" at the end submits a chat composer.
//   They are commands only where they stand alone at the edges of what was
//   said: "undo the migration step" and "please send it to Sam" are words.
// - **Layout said aloud** (`layoutCommands`): "new line", "new paragraph",
//   "bullet …" for list items, and a "scratch that" in the middle of an
//   utterance, which drops the clause just before it.

export type EditCommand = "scratch" | "undo";

export interface Intents {
  /** Commands on what earlier dictations wrote, in the order said. */
  edits: EditCommand[];
  /** What is left to write. */
  text: string;
  /** Submit the composer after writing ("send it"). */
  send: boolean;
}

/** A command opening the utterance, with the "and" that joins what follows. */
const LEADING = /^(scratch that|undo(?: that| it| this)?)\b[\s,.;:!]*(?:(?:and|then)\b[\s,]*)?/i;
const SEND_ALONE = /^(?:(?:and|then|now)\s+)?send it[\s.!]*$/i;
const SEND_LAST = /(?:^|[\s,.;:!]+)(?:(?:and|then|now)\s+)?send it[\s.!]*$/i;

/** The commands at the edges of one utterance. `canSend`: the target is a
 *  chat composer, where "send it" submits; anywhere else it is words, unless
 *  it is all that is left of a command utterance ("undo that and send it"). */
export function readIntents(utterance: string, opts: { canSend: boolean }): Intents {
  let text = utterance.trim();
  const edits: EditCommand[] = [];
  for (let m = LEADING.exec(text); m; m = LEADING.exec(text)) {
    const rest = text.slice(m[0].length);
    const cmd: EditCommand = /^scratch/i.test(m[1]) ? "scratch" : "undo";
    // "Undo" carries nothing after it but a send: otherwise it is a sentence.
    if (cmd === "undo" && rest && !SEND_ALONE.test(rest)) break;
    edits.push(cmd);
    text = rest;
  }
  let send = false;
  if (SEND_ALONE.test(text) || (opts.canSend && SEND_LAST.test(text))) {
    send = opts.canSend;
    text = text.replace(SEND_LAST, "").trim();
  }
  return { edits, text, send };
}

/** Where `text` ends its last sentence, so "scratch that" can take back only
 *  the last phrase of a dictation. 0 when it is one sentence. */
export function lastPhraseStart(text: string): number {
  const body = text.replace(/[\s.!?]+$/, "");
  let cut = 0;
  for (const m of body.matchAll(/[.!?]["')\]]?\s+|\n+/g)) cut = m.index + m[0].length;
  return cut;
}

const SENTENCE_END = /[.!?]["')\]]?\s+|\n+/g;

/** "Bullet fix the tray. Bullet fix the pin." → two list items. A bullet
 *  opens a sentence; what follows it, up to the next bullet or break, is its
 *  item. List items drop the period a recognizer puts on them. */
function bullets(text: string): string {
  if (!/(?:^|[.!?\n]\s*)bullet\b/i.test(text)) return text;
  const pieces: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    pieces.push(text.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  pieces.push(text.slice(last));
  let out = "";
  let inItem = false;
  for (const raw of pieces) {
    const opener = /^\s*bullet(?: point)?\b[\s,:;.-]*/i.exec(raw);
    const breaks = raw.endsWith("\n");
    let piece = raw;
    if (opener) {
      piece = piece.slice(opener[0].length);
      piece = piece.charAt(0).toUpperCase() + piece.slice(1);
      out = out.replace(/\s+$/, "");
      out += (out ? "\n" : "") + "- ";
      inItem = true;
    }
    if (inItem) piece = piece.replace(/\.(\s*)$/, "$1");
    out += piece;
    if (breaks) inItem = false;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\s+$/, "");
}

/** Say-aloud layout: breaks, list items, and a mid-utterance "scratch that". */
export function layoutCommands(text: string): string {
  let t = text;
  // "…three hundred, scratch that, make it seven hundred": the clause before
  // it, back to the sentence's start, goes, and what follows opens the
  // sentence instead.
  t = t
    .replace(/(^|[.!?\n]\s*)[^.!?\n]*?[\s,;]*\bscratch that\b[\s,.;:!]*/gi, "$1\u0001")
    .replace(/\u0001(\p{Ll})?/gu, (_, c?: string) => (c ? c.toUpperCase() : ""));
  // The sentence before keeps its period; the one the recognizer put after
  // the command goes.
  t = t.replace(/[\s,;:]*\bnew paragraph\b[\s,.;:]*/gi, "\n\n");
  t = t.replace(/[\s,;:]*\bnew ?line\b[\s,.;:]*/gi, "\n");
  t = t.replace(/\n(\p{Ll})/gu, (_, c: string) => "\n" + c.toUpperCase());
  return bullets(t);
}
