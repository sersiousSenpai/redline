// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Where a streaming reply's settled markdown ends.
//
// A reply streams in at ~30 chunks a second, and re-parsing the whole of it
// (markdown-it plus highlight.js) on every one made a long answer cost the
// square of its length. Almost all of it is settled, though: once a block is
// closed, nothing later in the reply changes how it renders. So the bubble
// renders the closed blocks once and re-parses only the open one at the end.
//
// The split must never change the output. Its line is a block boundary that
// markdown-it parses identically on both sides: a blank line outside any
// code fence, followed by a line that starts in column 0 and so cannot
// continue the block before it. Two blocks can still reach across one:
//
// - a list keeps going past a blank line when the next line is another item
//   (and turns loose, which re-renders every item), so after a list the
//   next line must be decided — complete, or unmistakably not a marker;
// - a reference-style link definition resolves links anywhere in the
//   document, so a reply holding one is not split at all.
//
// Everything else the reply might write — headings, paragraphs, tables,
// blockquotes (a blank line ends one), rules, fences — closes at that line.
// A reply holding a carriage return is not split either: markdown-it reads
// one as a line break, and this scan counts lines by `\n` alone.
//
// The scan reads fences line by line, without their containers, so it can
// misread one (a fence opened on a list item's own line); `StreamingText`
// has markdown-it confirm each boundary before rendering across it.

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const REFERENCE = /^ {0,3}\[[^\]]+\]:/m;

export interface StreamSplit {
  /** The closed blocks: everything before the last safe boundary. */
  head: string;
  /** The block still being written (sometimes more than one). */
  tail: string;
  /** The tail line a still-open code fence starts on, or -1. */
  openFence: number;
}

/** Split `text` at its last closed block boundary. `head + tail === text`,
 *  and rendering the two separately gives the markup of rendering the
 *  whole, short of a misread fence (above). Only ever moves forward as
 *  `text` grows by appending. */
export function splitAtClosedBlock(text: string): StreamSplit {
  if (REFERENCE.test(text) || text.includes("\r")) {
    return { head: "", tail: text, openFence: -1 };
  }
  const lines = text.split("\n");
  let head = 0; // offset where the tail starts
  let headLine = 0;
  let offset = 0; // offset of the current line
  let fence: { char: string; length: number; line: number } | null = null;
  let afterBlank = false;
  // The run since `head` holds a list item, so a blank line may not end it.
  let listy = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const complete = i < lines.length - 1;
    const marker = line.match(FENCE);
    if (fence) {
      const closes =
        marker != null &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        marker[2].trim() === "";
      if (closes) fence = null;
    } else if (line.trim() === "") {
      afterBlank = true;
    } else {
      const continuesList =
        listy && (LIST_ITEM.test(line) || (!complete && /^\d{1,9}$/.test(line)));
      if (afterBlank && /^\S/.test(line) && !continuesList) {
        head = offset;
        headLine = i;
        listy = false;
      }
      afterBlank = false;
      // A backtick fence's info string cannot hold a backtick.
      if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = { char: marker[1][0], length: marker[1].length, line: i };
      } else if (LIST_ITEM.test(line)) {
        listy = true;
      }
    }
    offset += line.length + 1;
  }
  return {
    head: text.slice(0, head),
    tail: text.slice(head),
    openFence: fence ? fence.line - headLine : -1,
  };
}
