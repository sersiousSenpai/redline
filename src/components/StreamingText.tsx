// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A reply's text while it streams — the live half of `ReplyBlock`, whose
//! settled half is `MarkdownView` over the same body, the same markup.
//!
//! The text renders in two halves, because re-parsing the whole reply on
//! every chunk made a long answer cost the square of its length: the closed
//! blocks go through a memoized `MarkdownView` that parses again only when
//! another block closes, and the open block at the end is re-rendered alone.
//! The markup is the one a single full render produces.
//!
//! It streams plain, never `rich`: a half-written ` ```mermaid ` fence that
//! reached `MermaidView` mid-stream flashed a "Diagram error" card. A diagram
//! streams as its fence and settles drawn — the one difference a settle is
//! allowed.

import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import { MarkdownView, renderLiveMarkdown, splitsCleanly } from "./MarkdownView";
import { splitAtClosedBlock, type StreamSplit } from "../lib/streamSplit";

/** The reply so far, split at its last closed block (`splitAtClosedBlock`).
 *  The open tail is not a second markdown view: its nodes are appended into
 *  the head view's own container, so they sit among the closed blocks exactly
 *  as one full render would place them — the same first/last-child rhythm in
 *  `.rl-md`, the same delegated copy-button and link clicks. React owns that
 *  container's markup only through `dangerouslySetInnerHTML`, which it
 *  re-assigns only when the head moves; the tail's nodes are ours. */
export function StreamingText({
  text,
  room = false,
  onOpenLink,
  className,
}: {
  text: string;
  room?: boolean;
  onOpenLink?: (url: string) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { head, tail, openFence } = useClosedBlockSplit(text);
  const tailHtml = useMemo(() => renderLiveMarkdown(tail, openFence), [tail, openFence]);
  // The head's props must hold still while only the tail moves, and a call
  // site's inline link handler is a new function every render.
  const linkRef = useRef(onOpenLink);
  linkRef.current = onOpenLink;
  const linked = onOpenLink != null;
  const onLinkClick = useMemo(
    () => (linked ? (url: string) => linkRef.current?.(url) : undefined),
    [linked],
  );
  useLiveTail(host, head, tailHtml);
  return (
    <div ref={host} className={className}>
      <MarkdownView body={head} compact room={room} onLinkClick={onLinkClick} />
    </div>
  );
}

/** `splitAtClosedBlock`, each new boundary confirmed by markdown-it's own
 *  block parser (`splitsCleanly`) before the text renders across it. The
 *  line scan reads a fence without its container — one opened on a list
 *  item's line, say — and a misread must cost a whole render, never a wrong
 *  one. A boundary's verdict holds as the reply grows, so the parse runs once
 *  per boundary, not once a frame. */
function useClosedBlockSplit(text: string): StreamSplit {
  const split = splitAtClosedBlock(text);
  const checked = useRef({ head: "", clean: true });
  if (checked.current.head !== split.head) {
    checked.current = {
      head: split.head,
      clean: split.head === "" || splitsCleanly(text, split.head),
    };
  }
  return checked.current.clean ? split : { head: "", tail: text, openFence: -1 };
}

/** Keep `html` appended to the end of the markdown container (`host`'s first
 *  child), replacing the previous tail. Re-runs when the head moves too: a
 *  new head re-assigns the container's markup, which takes the old tail with
 *  it. */
function useLiveTail(host: RefObject<HTMLDivElement | null>, head: string, html: string) {
  useLayoutEffect(() => {
    const view = host.current?.firstElementChild;
    if (!view || !html) return;
    const before = view.childNodes.length;
    view.insertAdjacentHTML("beforeend", html);
    const added = Array.from(view.childNodes).slice(before);
    return () => added.forEach((node) => node.remove());
  }, [host, head, html]);
}
